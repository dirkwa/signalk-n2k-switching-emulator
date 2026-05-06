// Verifies the SimpleCan-based CZone persona path.
//
// The plugin uses canboatjs's SimpleCan to claim a NAME-MFG=295 source
// address on the configured canDevice. SimpleCan opens a real socketcan
// socket which we don't want in CI, so the plugin honors a
// `app._simpleCanFactory` injection point that this test uses to
// substitute a stub. The stub captures every SimpleCan constructor call
// (so we can inspect addressClaim / productInfo / canDevice options)
// and exposes injectInbound() so tests can simulate inbound CZone
// frames as if a plotter sent them.

import assert from 'node:assert/strict'
import pluginModule from '/home/dirk/dev/signalk-n2k-switching-emulator/dist/index.js'
import { ManufacturerCode } from '/home/dirk/dev/signalk-n2k-switching-emulator/node_modules/@canboat/ts-pgns/dist/index.js'

const pluginFactory = pluginModule.default ?? pluginModule

// Capture every SimpleCan constructor call so the test can inspect what
// the plugin passed.
const simpleCanInstances = []

class FakeSimpleCan {
  constructor (options, messageCb) {
    this.options = options
    this.messageCb = messageCb
    this.sent = []
    this.started = false
    simpleCanInstances.push(this)
  }
  start () {
    this.started = true
  }
  sendPGN (msg) {
    this.sent.push(msg)
  }
  // helper for tests
  injectInbound (msg) {
    if (this.messageCb) this.messageCb(msg)
  }
}

const SWITCH_PATHS = [
  'electrical.switches.bank.0.1.state',
  'electrical.switches.bank.0.2.state',
  'electrical.switches.bank.0.3.state'
]

class FakeApp {
  constructor () {
    this.config = { version: '2.20.0', settings: { vesselUuid: 'urn:test' } }
    this.selfState = {}
    this.subscriptions = []
    this.subscriptionmanager = {
      subscribe: (cmd, _onStop, errorCb, deltaCb) => {
        this.subscriptions.push({ cmd, errorCb, deltaCb })
      }
    }
    this.emitted = []
    this.errors = []
    this._simpleCanFactory = FakeSimpleCan
  }
  debug () {}
  error (...args) { this.errors.push(args) }
  setProviderError () {}
  setProviderStatus () {}
  getSelfPath (path) { return this.selfState[path] }
  putSelfPath (path, value) {
    this.selfState[path] = { value }
    const sub = this.subscriptions[0]
    if (sub) sub.deltaCb({ updates: [{ values: [{ path, value }] }] })
  }
  handleMessage () {}
  emit (event, payload) {
    if (event === 'nmea2000out') this.emitted.push(payload)
  }
  on () {}
  removeListener () {}
}

const app = new FakeApp()
const plugin = pluginFactory(app)

plugin.start({
  canDevice: 'vcan-test-stub',
  banks: [
    {
      instance: 0,
      sendRate: 0,
      switches: SWITCH_PATHS,
      czoneEnabled: true,
      czoneDipswitch: '00011000',
      czoneFirstCircuitId: 13,
      czoneModuleName: 'test-module'
    }
  ]
})

await new Promise((r) => setTimeout(r, 50))

assert.equal(
  simpleCanInstances.length,
  1,
  'one SimpleCan instance created for one CZone-enabled bank'
)
const sc = simpleCanInstances[0]
assert.equal(sc.started, true, 'SimpleCan.start() was called')
assert.equal(sc.options.canDevice, 'vcan-test-stub', 'canDevice option propagated')

const claimMfg = sc.options.addressClaim?.fields?.manufacturerCode
assert.equal(
  claimMfg,
  ManufacturerCode.BepMarine2,
  // ManufacturerCode.BepMarine2 = "BEP Marine 2" -> 295 (the CZone gate
  // value, exposed by ts-pgns once canboat#627 disambiguated the two
  // "BEP Marine" entries in MANUFACTURER_CODE).
  `address claim mfg should be BepMarine2 (got ${claimMfg})`
)
console.log('SimpleCan opts: canDevice=vcan-test-stub, mfg=BepMarine2: OK')

const productCode = sc.options.addressClaim
  ? sc.options.productInfo?.fields?.productCode
  : undefined
assert.equal(
  productCode,
  8395,
  `productCode should be 8395 (COI), got ${productCode}`
)
console.log('product info productCode=8395 (COI): OK')

// Inject an inbound PGN 65280 ON command and verify the plugin updates
// the switch state.
sc.injectInbound({
  pgn: { src: 5, dst: 255, pgn: 65280, prio: 3 },
  length: 8,
  data: Buffer.from([0x27, 0x99, 0x0d, 0, 0, 0, 0xf1, 0])
})
await new Promise((r) => setTimeout(r, 30))
assert.deepEqual(
  app.selfState[SWITCH_PATHS[0]],
  { value: 1 },
  'inbound 65280 via SimpleCan should set switch 1 = 1'
)
console.log('inbound 65280 via SimpleCan -> switch 1 = 1: OK')

// Inject an inbound 65299 query and expect a 130820 reply through
// SimpleCan.sendPGN.
sc.sent.length = 0
sc.injectInbound({
  pgn: { src: 5, dst: 255, pgn: 65299, prio: 7 },
  length: 8,
  data: Buffer.from([0x27, 0x99, 0x18, 0, 0, 0x80, 0xff, 0xff])
})
await new Promise((r) => setTimeout(r, 30))
const replies = sc.sent
  .filter((s) => typeof s === 'string')
  .map((s) => s.split(','))
  .filter((p) => p[2] === '130820')
assert.ok(
  replies.length > 0,
  `expected a 130820 reply via SimpleCan.sendPGN, got ${sc.sent.length} frames`
)
console.log('inbound 65299 via SimpleCan -> 130820 reply: OK')

plugin.stop()
console.log('\nemulator integration test: PASS')
