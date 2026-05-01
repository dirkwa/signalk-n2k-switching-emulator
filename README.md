# signalk-n2k-switching-emulator
Signal K Plugin which makes existing switches in sk available as n2k switches

The plugin sends out pgn 127501 for the configured banks/switches and accepts
pgn 127502 to change the switches.

For compatibility with Maretron devices and MFDs, the plugin also accepts a
pgn 126208 Command Group Function whose commanded PGN is 127501. When such
a command is received, each pair in the command maps to a channel in the
indicated switch bank:

- parameter 1 carries the Indicator Bank Instance
- parameter N (for N in 2..29) carries the new status of channel N - 1

After applying the update, the plugin replies with a pgn 126208 Acknowledge
Group Function addressed to the sender.

The plugin also responds to pgn 59904 ISO Request when the requested PGN is
127501. On receipt it immediately broadcasts a pgn 127501 Binary Status
Report for every configured switch bank, so MFDs can pull the current state
on demand without waiting for the next periodic send.

## CZone emulation

In addition to standard NMEA 2000 switching, the plugin can publish one
bank as a Navico CZone-compatible module so plotters such as Zeus, GO and
Axiom display it on their CZone screen.

### Mental model

A CZone module is one NMEA 2000 device, identified by a single 8-bit
dipswitch value. The MFD holds a `.zcf` configuration file that maps
each circuit it knows about to a `(dipswitch, channel)` pair: the
dipswitch picks the module, the channel picks the switch on that module.
At runtime the MFD broadcasts circuit-control commands and each module
acts on commands whose dipswitch matches its own.

This plugin emulates one such module. It does not generate or distribute
the `.zcf` itself — you create that with Mastervolt's CZone Configuration
Tool or use a ready-made one (Yacht Devices ships one for the YDAB-01
that works with B&G plotters), and you upload it to the MFD via the MFD's
normal CZone configuration flow.

### Configuration

Two pieces of configuration:

1. **Per-bank `czoneEnabled`** flag (under `banks[i]`) — set to `true`
   on the one bank whose switches should appear under the CZone identity.
   Up to six switches per bank are exposed (CZone modules are 6-circuit).
2. **Top-level `czone`** block:
   - `dipswitch` — eight-character binary string (e.g. `"00011000"`),
     the same value you'd enter on the MFD's CZone settings page. Must
     match the dipswitch your `.zcf` uses for this module.
   - `address` — the N2K source address the emulated module claims
     (default 67).

### What goes on the bus

When `czoneEnabled` is set on a bank and the plugin starts, it sends:

| PGN | Direction | Cadence | Purpose |
|---|---|---|---|
| 65290 | TX once | startup | CZone announce (unique id + dipswitch) |
| 65284 | TX | 2 s | Circuit-state bitmap |
| 130817 | TX | 2 s | Status Extended (per-circuit state record) |
| 65280 | RX | on command | MFD circuit-control command (on/off per circuit id) |
| 65284 | RX | on query | MFD bitmap query (`27 99 C8 10 …` payload) |

Inbound circuit-control commands map circuit id `0x0D + n` to switch
`n + 1` of the enabled bank. The plugin writes `1` or `0` to that
bank's switch path via `app.putSelfPath`, so a downstream plugin (relay
driver, etc.) can turn the actual load on or off.

### Limitations

- One module (one dipswitch) per SignalK server.
- Up to six switches per CZone-enabled bank — the standard CZone
  module size. Banks with more than six paths are still served as a
  normal NMEA 2000 switch bank, but only the first six surface under
  the CZone identity.
- The plugin does not implement the `.zcf` distribution PGNs
  (130818/130819/130821). Configure the MFD with your `.zcf` through
  the existing CZone tooling.
