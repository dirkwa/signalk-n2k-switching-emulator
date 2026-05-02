#!/usr/bin/env node
// zcf-info.mjs — extract circuit info from a CZone .zcf file.
//
// Usage:
//   node tools/zcf-info.mjs path/to/your.zcf [--strings]
//
// Prints each circuit's name and circuit id, then suggests a
// `czoneFirstCircuitId` value to put in the plugin config.
//
// Pass `--strings` to also dump every length-prefixed string the scanner
// found in the file (handy for verifying which `.zcf` you're looking at).
//
// This is a best-effort *heuristic* parser. The .zcf format is proprietary
// and the parser locates circuit records by scanning for length-prefixed
// names rather than implementing the full record schema. It works on
// .zcf files produced by the CZone Configuration Tool for typical small
// switching configurations.
//
// If the output looks wrong: open the .zcf in the CZone Configuration
// Tool, read the dipswitch off the Modules tab and the circuit IDs off the
// Circuits tab, and configure the plugin manually.

import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const showStrings = args.includes('--strings')
const file = args.find((a) => !a.startsWith('--'))
if (!file) {
  console.error('Usage: node tools/zcf-info.mjs path/to/your.zcf [--strings]')
  process.exit(1)
}
if (!fs.existsSync(file)) {
  console.error(`No such file: ${file}`)
  process.exit(1)
}

const data = fs.readFileSync(file)

console.log(`zcf:    ${path.resolve(file)}`)
console.log(`size:   ${data.length} bytes`)
console.log()

const versionByte = data[0]
console.log(`format version byte: 0x${versionByte.toString(16).padStart(2, '0')}`)
if (versionByte !== 6) {
  console.log(
    `  WARNING: this scanner has only been tested against version 6 files.`
  )
}
console.log()

// Find length-prefixed printable-ASCII strings (length byte equals string
// length, string is at least 3 chars). Returns [{offset, length, text}].
function findLengthPrefixedStrings (buf) {
  const out = []
  for (let i = 1; i < buf.length; i++) {
    const len = buf[i - 1]
    if (len < 3 || len > 64) continue
    if (i + len > buf.length) continue
    let printable = true
    for (let j = i; j < i + len; j++) {
      const b = buf[j]
      if (b < 32 || b > 126) {
        printable = false
        break
      }
    }
    if (!printable) continue
    // Reject runs that are part of a longer printable region (we want exact
    // length match, so the byte after the run should not also be printable).
    if (i + len < buf.length) {
      const next = buf[i + len]
      if (next >= 32 && next <= 126 && next !== 0) {
        // Could still be a string with trailing printable; tolerate it.
      }
    }
    out.push({ offset: i - 1, length: len, text: buf.slice(i, i + len).toString('ascii') })
  }
  return out
}

const strings = findLengthPrefixedStrings(data)

if (showStrings) {
  console.log('strings found in file (offset, length, text):')
  for (const s of strings) {
    console.log(
      `  0x${s.offset.toString(16).padStart(4, '0')}  len=${String(s.length).padStart(2)}  ${s.text}`
    )
  }
  console.log()
}

// Loads ("outputChannels") and circuits sections both list the same names
// — once each. Names appearing twice are circuit/channel pairs; names
// appearing only once are something else (config name, module name, MFD,
// switch-bank name, lighting zone, …).
const counts = new Map()
for (const s of strings) {
  counts.set(s.text, (counts.get(s.text) || 0) + 1)
}
const repeatedNames = [...counts.entries()]
  .filter(([, n]) => n >= 2)
  .map(([name]) => name)


// For each repeated name, the SECOND occurrence is the circuit record.
// The 32-bit little-endian field that ends 1 byte before the length-prefix
// is the circuit id. So if the length-prefix is at offset N, the circuit id
// occupies bytes [N - 4, N).
const circuits = []
for (const name of repeatedNames) {
  const occurrences = strings.filter((s) => s.text === name)
  if (occurrences.length < 2) continue
  const circuit = occurrences[1]
  if (circuit.offset < 4) continue
  const circuitId = data.readUInt32LE(circuit.offset - 4)
  circuits.push({ name, circuitId })
}

if (circuits.length === 0) {
  console.log(
    'No repeated names found. This .zcf may not contain switchable circuits ' +
      'or its layout is one this scanner does not yet handle.'
  )
  process.exit(0)
}

circuits.sort((a, b) => a.circuitId - b.circuitId)

console.log('circuit_id  name')
for (const c of circuits) {
  console.log(`  ${String(c.circuitId).padStart(8)}  ${c.name}`)
}
console.log()

const firstId = circuits[0].circuitId
const lastId = circuits[circuits.length - 1].circuitId
const contiguous = lastId - firstId === circuits.length - 1

console.log(`first circuit id: ${firstId}`)
if (contiguous) {
  console.log(
    `circuit ids ${firstId}..${lastId} are contiguous — czoneFirstCircuitId: ${firstId}`
  )
} else {
  console.log(
    `circuit ids are NOT contiguous (range ${firstId}..${lastId}, ${circuits.length} circuits). ` +
      `The plugin's czoneFirstCircuitId expects a contiguous run; either reconfigure your ` +
      `.zcf so the circuits used by this module have sequential ids, or pick a starting id ` +
      `and accept that gaps map to "no switch".`
  )
}
console.log()

// Dipswitch is somewhere in the module section near the start of the file,
// but its exact offset varies by file version and which optional fields
// are present. We don't try to extract it automatically. Tell the user
// where to look.
console.log(
  'dipswitch: open the .zcf in the CZone Configuration Tool, click the ' +
    "Modules tab, and read the dipswitch from there. Convert it to the plugin's " +
    "binary-string form by writing positions 1..8 as '1' (on) or '0' (off), " +
    'leftmost = position 1.'
)
