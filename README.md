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

Three per-bank fields, all under `banks[i]`:

| Field | Default | Notes |
|---|---|---|
| `czoneEnabled` | `false` | Set to `true` to publish this bank as a CZone module. |
| `czoneDipswitch` | `"00011000"` | Eight-character binary string, leftmost char = position 1 (bit 0). Must match the dipswitch the `.zcf` assigns to this module. Each enabled bank must use a distinct dipswitch. |
| `czoneFirstCircuitId` | `13` | The first circuit id the `.zcf` gave this module. Switch 1 = this id, switch 2 = id+1, etc. The Yacht Devices YDAB-01 uses 13; configurations created from scratch in the CZone Configuration Tool can use any value. |

Each enabled bank exposes up to six switches as one CZone module —
that is the standard module size. Multiple enabled banks become
multiple modules on the bus, each with its own dipswitch.

### What goes on the bus

When `czoneEnabled` is set on a bank and the plugin starts, it sends:

| PGN | Direction | Cadence | Purpose |
|---|---|---|---|
| 65290 | TX once | startup | CZone announce (unique id + dipswitch) |
| 65284 | TX | 2 s | Circuit-state bitmap |
| 130817 | TX | 2 s | Status Extended (per-circuit state record) |
| 65280 | RX | on command | MFD circuit-control command (on/off per circuit id) |
| 65284 | RX | on query | MFD bitmap query (`27 99 C8 10 …` payload) |

Inbound circuit-control commands carry an absolute circuit id from the
`.zcf`. The plugin subtracts the bank's `czoneFirstCircuitId` to get a
0-based switch index, then writes `1` or `0` to the matching switch
path via `app.putSelfPath`, so a downstream plugin (relay driver,
etc.) can turn the actual load on or off.

### Dipswitch and `.zcf` matching

The MFD uses the dipswitch in your `.zcf` to address a specific module.
Three rules follow from that:

1. **The plugin's `dipswitch` must match the dipswitch the `.zcf`
   assigns to this module.** If they differ the MFD's commands target
   a different dipswitch and the plugin never sees them.
2. **Two devices on the bus must not share the same dipswitch.** If a
   real CZone module is on the bus with the dipswitch you've configured
   here, both devices will broadcast circuit state for the same
   dipswitch and the MFD will see conflicting statuses. Either change
   the plugin's dipswitch (and load a `.zcf` matching the new value),
   or disconnect the conflicting hardware module before enabling
   emulation.
3. **You can leave a real CZone module physically connected** as long
   as you upload a `.zcf` whose dipswitch differs from the real
   module's — the MFD will simply stop addressing it.

When testing, give the emulated circuits clearly different labels in
the `.zcf` from anything in your existing setup. That way the MFD
visibly switches to the new configuration once you upload it, which
makes it obvious whether you're seeing the emulator or the old
hardware.

### Side-bar control on Navico displays

To make the emulated switches appear on the Navico Control Bar (the
side-bar on Zeus / NSS / GO), follow Navico's standard procedure for
adding third-party Switch Bank Control devices to a CZone
configuration:

1. In the CZone Configuration Tool, open the **Advanced → Third-Party
   Devices** tab and add a Switch Bank PGN Control entry. Pick a
   Switch Bank supported module type (C1, MOI, OI, etc.), set a
   unique Switch Bank Instance, and tick *Enable advanced CZone
   remote control switch functions*.
2. On the **Circuits** tab, add a Switch Bank circuit control to each
   circuit you want the side-bar to drive (Switch Type:
   Single Throw Momentary, Switch Output Function: Toggle).
3. Write the updated configuration to the network.
4. On the MFD, enable *Settings → System → Advanced → Digital
   Switching* and CZone, then add the Control Bar to the side-bar
   layout.

The plugin itself is unchanged by this — it just publishes the
module so the MFD can address it. All UI configuration happens in
the CZone Configuration Tool.

### Limitations

- Up to six switches per CZone-enabled bank — the standard CZone
  module size. Banks with more than six paths are still served as a
  normal NMEA 2000 switch bank, but only the first six surface under
  the CZone identity.
- The plugin does not implement the `.zcf` distribution PGNs
  (130818/130819/130821). Configure the MFD with your `.zcf` through
  the existing CZone tooling.
