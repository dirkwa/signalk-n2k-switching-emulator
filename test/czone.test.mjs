// Validate CZone packers against reference capture bytes.
// Run with: node test/czone.test.mjs
import assert from 'node:assert/strict'
import {
  bepFrame,
  packAnnounce,
  packCircuitDescriptor,
  packDipswitchState,
  packCapabilityBitmap,
  parseDipswitch
} from '../dist/czone.js'

// dipswitch parsing: binary string preferred, integer accepted, fallback default
assert.equal(parseDipswitch('00011000'), 0x18, 'binary string parses to byte')
assert.equal(parseDipswitch('00010000'), 0x10)
assert.equal(parseDipswitch('11111111'), 0xff)
assert.equal(parseDipswitch(24), 24, 'integer passes through')
assert.equal(parseDipswitch(undefined), 0x18, 'undefined uses default')
assert.equal(parseDipswitch('not-a-pattern'), 0x18, 'invalid string uses default')

// PGN 65290 announce: reference payload for serial 0xDB13B (897339), group 0x18
const announce = packAnnounce(0xdb13b, 0x18)
assert.deepEqual(
  Array.from(announce),
  [0x3b, 0xb1, 0x0d, 0x00, 0x00, 0x18],
  'PGN 65290 announce payload matches reference'
)

// PGN 130817 circuit descriptor: 20 bytes, header 01 18 ...
const desc = packCircuitDescriptor(0x18)
assert.equal(desc.length, 20)
assert.equal(desc[0], 0x01)
assert.equal(desc[1], 0x18)

// PGN 65283 dipswitch state: switch 1 on -> byte[1] = 0x01
const ind1 = new Array(28).fill(false)
ind1[0] = true
const s1 = packDipswitchState(0x18, ind1, 0)
assert.equal(s1[0], 0x18, 'byte[0] = group')
assert.equal(s1[1], 0x01, 'switch 1 on (bit 0 of byte[1])')
assert.equal(s1[5], 0x10, 'presence flag byte')

// switch 3 on (without 1) -> byte[1] = 0x10 (bits 4-5 = 01)
const ind3 = new Array(28).fill(false)
ind3[2] = true
const s3 = packDipswitchState(0x18, ind3, 0)
assert.equal(s3[1], 0x10, 'switch 3 on encodes to byte[1] = 0x10')

// PGN 65284 capability bitmap: switches 0,7,15 on -> bitmap bits 0, 7, 15 set
const ind = new Array(32).fill(false)
ind[0] = true
ind[7] = true
ind[15] = true
const cap = packCapabilityBitmap(0x18, 0x0f, ind)
assert.equal(cap[0], 0x18)
assert.equal(cap[1], 0x0f)
assert.equal(cap[2], 0x81, 'bits 0,7 of bitmap byte 0')
assert.equal(cap[3], 0x80, 'bit 7 of bitmap byte 1 (=switch index 15)')

// bepFrame: BEP header prefix + payload, with src honored
const f = bepFrame(65290, 67, announce)
assert.equal(f.pgn, 65290)
assert.equal(f.src, 67)
assert.equal(f.forceSrc, true)
assert.equal(f.dst, 255)
assert.equal(f.data.length, 8, 'header + payload')
// BEP header: industry=4, reserved=11b, mfg=116
//   0b100<<13 | 0b11<<11 | 116 = 0x9874
assert.equal(f.data[0], 0x74)
assert.equal(f.data[1], 0x98)

console.log('czone packer smoke test: PASS')
