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
