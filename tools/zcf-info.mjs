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

import { parseZcf } from '../dist/zcfParser.js'

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

const summary = parseZcf(data)

console.log(
  `format version byte: 0x${summary.versionByte.toString(16).padStart(2, '0')}`
)
if (summary.versionByte !== 6) {
  console.log(
    `  WARNING: this scanner has only been tested against version 6 files.`
  )
}
console.log()

if (showStrings) {
  console.log('strings found in file (offset, length, text):')
  for (const s of summary.strings) {
    console.log(
      `  0x${s.offset.toString(16).padStart(4, '0')}  len=${String(s.length).padStart(2)}  ${s.text}`
    )
  }
  console.log()
}

if (summary.circuits.length === 0) {
  console.log(
    'No circuits found. This .zcf may not contain switchable circuits ' +
      'or its layout is one this scanner does not yet handle.'
  )
  process.exit(0)
}

console.log('circuit_id  name')
for (const c of summary.circuits) {
  console.log(`  ${String(c.circuitId).padStart(8)}  ${c.name}`)
}
console.log()

const firstId = summary.firstCircuitId
const lastId = summary.circuits[summary.circuits.length - 1].circuitId

console.log(`first circuit id: ${firstId}`)
if (summary.contiguous) {
  console.log(
    `circuit ids ${firstId}..${lastId} are contiguous — czoneFirstCircuitId: ${firstId}`
  )
} else {
  console.log(
    `circuit ids are NOT contiguous (range ${firstId}..${lastId}, ${summary.circuits.length} circuits). ` +
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
