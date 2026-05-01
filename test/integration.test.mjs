// Integration test: load the built plugin, drive it with a fake SignalK
// app, capture every nmea2000* emission, parse each Actisense frame back
// to raw bytes via canboatjs, and assert that the CZone PGN sequence is
// what we expect — including state changes when an inbound PGN 65280
// command arrives.
//
// Run with: node test/integration.test.mjs

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import canboatjs from '@canboat/canboatjs'
import stringMsg from '@canboat/canboatjs/dist/stringMsg.js'
const { parseActisense } = canboatjs.parseActisense ? canboatjs : stringMsg

import pluginModule from '../dist/index.js'
const pluginFactory = pluginModule.default ?? pluginModule

const PLUGIN_ID = 'signalk-n2k-switching-emulator'
const SWITCH_PATHS = [
  'electrical.switches.bank.0.1.state',
  'electrical.switches.bank.0.2.state',
  'electrical.switches.bank.0.3.state',
  'electrical.switches.bank.0.4.state',
  'electrical.switches.bank.0.5.state',
  'electrical.switches.bank.0.6.state'
]

class FakeApp extends EventEmitter {
  constructor () {
    super()
    this.config = { version: '2.20.0', settings: { vesselUuid: 'urn:test' } }
    this.selfState = {}
    this.emitted = []
    this.subscriptions = []
    this.errors = []
    this.subscriptionmanager = {
      subscribe: (cmd, _onStop, errorCb, deltaCb) => {
        this.subscriptions.push({ cmd, errorCb, deltaCb })
      }
    }

    for (const evt of ['nmea2000out', 'nmea2000JsonOut']) {
      this.on(evt, (msg) => this.emitted.push({ evt, msg }))
    }
  }

  debug () {}
  error (...args) { this.errors.push(args) }
  setProviderError (e) { this.errors.push(['provider', e]) }
  getSelfPath (path) { return this.selfState[path] }
  putSelfPath (path, value) {
    this.selfState[path] = { value }
    const sub = this.subscriptions[0]
    if (sub) {
      sub.deltaCb({
        updates: [{ values: [{ path, value }] }]
      })
    }
  }
  handleMessage () {}
}

const app = new FakeApp()
const plugin = pluginFactory(app)

plugin.start({
  banks: [
    {
      instance: 0,
      sendRate: 0,
      switches: SWITCH_PATHS,
      czoneEnabled: true
    }
  ],
  czone: { dipswitch: '00011000' }
})

await new Promise((r) => setTimeout(r, 2200))

function parseEmit ({ evt, msg }) {
  if (evt !== 'nmea2000out') return null
  const parsed = parseActisense(msg)
  return {
    pgn: parsed.pgn,
    bytes: Array.from(parsed.data ?? []).map((b) =>
      b.toString(16).padStart(2, '0')
    ),
    raw: msg
  }
}

const decoded = app.emitted.map(parseEmit).filter(Boolean)

console.log(`captured ${decoded.length} nmea2000out frames at startup:`)
for (const d of decoded) {
  console.log(
    `  PGN ${d.pgn.toString().padStart(6)}  ${d.bytes.join(' ')}`
  )
}

assert.ok(
  decoded.find((d) => d.pgn === 65290),
  'PGN 65290 announce was emitted'
)

const announce = decoded.find((d) => d.pgn === 65290)
assert.equal(announce.bytes[0], '27', 'CZone header low byte')
assert.equal(announce.bytes[1], '99', 'CZone header high byte')
assert.equal(
  announce.bytes[7],
  '18',
  'announce dipswitch byte = 0x18 (binary 00011000)'
)

assert.ok(
  decoded.find((d) => d.pgn === 65284),
  'PGN 65284 circuit bitmap was emitted'
)
const bitmap0 = decoded.find((d) => d.pgn === 65284)
assert.equal(bitmap0.bytes[2], '18', '65284 dipswitch byte')
assert.equal(bitmap0.bytes[3], '0f', '65284 circuit-state-type byte')
assert.equal(
  bitmap0.bytes.slice(4).join(''),
  '00000000',
  '65284 bitmap is all-zero (no switches on)'
)

assert.ok(
  decoded.find((d) => d.pgn === 130817),
  'PGN 130817 status extended was emitted'
)
const ext0 = decoded.find((d) => d.pgn === 130817)
assert.equal(ext0.bytes[2], '01', '130817 page id')
assert.equal(ext0.bytes[3], '18', '130817 dipswitch byte')

console.log('startup PGN set: OK')

// --- Now simulate the MFD sending PGN 65280 to turn switch 1 on ---
app.emitted.length = 0

const cmdData = Buffer.from([0x27, 0x99, 0x0d, 0, 0, 0, 0xf1, 0])
app.emit('N2KAnalyzerOut', {
  pgn: 65280,
  src: 5,
  fields: { Data: '0d 00 00 00 f1 00' }
})

await new Promise((r) => setTimeout(r, 20))

assert.deepEqual(
  app.selfState[SWITCH_PATHS[0]],
  { value: 1 },
  'circuit 0x0D (switch 1) put to 1 after 65280 ON command'
)
console.log('inbound 65280 ON -> switch 1 = 1: OK')

const replyDecoded = app.emitted.map(parseEmit).filter(Boolean)
const replyBitmap = replyDecoded.find((d) => d.pgn === 65284)
assert.ok(replyBitmap, '65284 re-emitted after state change')
assert.equal(
  replyBitmap.bytes[4],
  '01',
  '65284 bitmap byte 0 has switch 1 bit set'
)
console.log('outbound 65284 reflects new state: OK')

// --- Toggle off ---
app.emitted.length = 0
app.emit('N2KAnalyzerOut', {
  pgn: 65280,
  src: 5,
  fields: { Data: '0d 00 00 00 f2 00' }
})
await new Promise((r) => setTimeout(r, 20))
assert.deepEqual(
  app.selfState[SWITCH_PATHS[0]],
  { value: 0 },
  'switch 1 = 0 after 65280 OFF command'
)
console.log('inbound 65280 OFF -> switch 1 = 0: OK')

plugin.stop()
console.log('\nintegration test: PASS')
