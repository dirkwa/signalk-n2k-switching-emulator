/*
 * Copyright 2021 Scott Bender <scott@scottbender.net>
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  PGN_60928,
  PGN_126996,
  PGN_127502,
  PGN_127501,
  PGN_130060,
  PGN_126208_NmeaAcknowledgeGroupFunction,
  ManufacturerCode,
  DeviceFunction,
  DeviceClass,
  YesNo,
  IndustryCode,
  GroupFunction,
  PgnErrorCode,
  mapCamelCaseKeys
} from '@canboat/ts-pgns'
import { SimpleCan } from '@canboat/canboatjs'
import { satisfies } from 'semver'
import * as fs from 'fs'
import * as path from 'path'
import {
  circuitIdToSwitchIndex,
  CZONE_PGN_ANNOUNCE,
  CZONE_PGN_CIRCUIT_BITMAP,
  CZONE_PGN_CIRCUIT_CONTROL,
  CZONE_PGN_LABEL_QUERY,
  CZONE_PGN_LABEL_REPLY,
  CZONE_PGN_STATUS_EXTENDED,
  CZONE_SUPPORTED_SWITCHES,
  czoneFrame,
  deriveUniqueSerial,
  isCircuitStateQuery,
  packAnnounce,
  packBinaryStatusReport,
  packCircuitBitmap,
  packLabelReply,
  packStatusExtended,
  parseCircuitControl,
  parseDipswitch,
  parseLabelQuery
} from './czone'
import { ZcfReassembler } from './zcfReassembler'
import { parseZcf } from './zcfParser'

const CZONE_HEARTBEAT_MS = 2000
// Re-broadcast PGN 65290 every 10 s so a plotter that joins the bus after
// the plugin starts still sees the module's announce. spec/pgn-65290.md
// doesn't mandate a cadence — this is defensive correctness.
const CZONE_ANNOUNCE_MS = 10000
const CZONE_PGN_ZCF_TRANSFER = 130816

export default function (app: any) {
  const error = app.error?.bind(app) ?? ((...args: any[]) => console.error(...args))
  const debug = app.debug?.bind(app) ?? ((..._args: any[]) => {})
  let props: any
  let onStop: any = []
  let switchBanks: any = {}

  const needsCamelMapping = !satisfies(app.config.version, '>=2.15.0')

  const plugin: Plugin = {
    start: function (properties: any) {
      props = properties

      if (!props?.banks || !props.banks.length) {
        return
      }

      props.banks.forEach((bank: any) => {
        if (!bank.switches || !bank.switches.length) {
          return
        }
        switchBanks[bank.instance] = bank.switches
        app.subscriptionmanager.subscribe(
          {
            context: 'vessels.self',
            subscribe: bank.switches.map((path: any) => {
              return { path }
            })
          },
          onStop,
          (err: any) => {
            error(err)
            app.setProviderError(err)
          },
          (delta: any) => {
            let pgn = makeBinaryStatusReport(bank)

            delta.updates?.forEach((update: any) => {
              update.values?.forEach((vp: any) => {
                ;(pgn.fields as any)[
                  `indicator${bank.switches.indexOf(vp.path) + 1}`
                ] = vp.value === 1 || vp.value === true ? 'On' : 'Off'
              })
            })
            pgn = needsCamelMapping
              ? (mapCamelCaseKeys(pgn) as PGN_127501)
              : pgn
            debug('sending %j', pgn)
            app.emit('nmea2000JsonOut', pgn)
            if (bank.czoneEnabled) {
              sendCZoneState(bank)
            }
          }
        )
        if (bank.sendRate) {
          const interval = setInterval(() => {
            let pgn = makeBinaryStatusReport(bank)
            pgn = needsCamelMapping
              ? (mapCamelCaseKeys(pgn) as PGN_127501)
              : pgn
            debug('sending update %j', pgn)
            app.emit('nmea2000JsonOut', pgn)
          }, bank.sendRate * 1000)
          onStop.push(() => clearInterval(interval))
        }
      })

      startCZoneEmulation()

      const applySwitchState = (
        instance: any,
        channel: number,
        rawValue: any
      ) => {
        const paths = switchBanks[instance]
        if (!paths) {
          return
        }
        if (channel < 1 || channel > 28) {
          return
        }
        if (paths.length < channel) {
          error(`no path for switch ${channel} bank ${instance}`)
          return
        }
        debug(`Switch ${channel} ${rawValue}`)
        app.putSelfPath(
          paths[channel - 1],
          rawValue === 'On' || rawValue === 1 || rawValue === true ? 1 : 0
        )
      }

      const sendAcknowledge = (
        commandedPgn: number,
        dst: number,
        errorCode: PgnErrorCode
      ) => {
        if (dst === undefined || dst === 255) {
          return
        }
        const ack = new PGN_126208_NmeaAcknowledgeGroupFunction(
          {
            pgn: commandedPgn,
            pgnErrorCode: errorCode,
            transmissionIntervalPriorityErrorCode: 0,
            numberOfParameters: 0,
            list: []
          },
          dst
        )
        const outgoing = needsCamelMapping
          ? (mapCamelCaseKeys(ack) as PGN_126208_NmeaAcknowledgeGroupFunction)
          : ack
        debug('sending ACK %j', outgoing)
        app.emit('nmea2000JsonOut', outgoing)
      }

      const sendBinaryStatusReport = (bank: any) => {
        let pgn = makeBinaryStatusReport(bank)
        if (needsCamelMapping) {
          pgn = mapCamelCaseKeys(pgn) as PGN_127501
        }
        debug('sending %j', pgn)
        app.emit('nmea2000JsonOut', pgn)
      }

      const sendLabels = (bank: any) => {
        bank.switches?.forEach((sw: any, index: number) => {
          const label = switchLabel(sw)
          let pgn = new PGN_130060({
            hardwareChannelId: index,
            pgn: 127501,
            dataSourceInstanceFieldNumber: 1,
            dataSourceInstanceValue: bank.instance,
            secondaryEnumerationFieldNumber: 0,
            secondaryEnumerationFieldValue: 0,
            parameterFieldNumber: index + 2,
            label
          })
          if (needsCamelMapping) {
            pgn = mapCamelCaseKeys(pgn) as PGN_130060
          }
          debug('sending label %j', pgn)
          app.emit('nmea2000JsonOut', pgn)
        })
      }

      const onCZoneCircuitControl = (msg: any) => {
        const result = parseCircuitControl(extractRawPayload(msg))
        if (!result) return
        czoneEnabledBanks().forEach((bank: any) => {
          const switchIndex = circuitIdToSwitchIndex(
            result.circuitId,
            bankFirstCircuitId(bank),
            bank.switches.length
          )
          if (switchIndex < 0) return
          const path = bank.switches[switchIndex]
          if (!path) return
          debug(
            'czone circuit %d -> bank %d switch %d path %s = %s',
            result.circuitId,
            bank.instance,
            switchIndex + 1,
            path,
            result.on ? 'on' : 'off'
          )
          app.putSelfPath(path, result.on ? 1 : 0)
          setCachedSwitch(path, result.on)
          sendCZoneState(bank)
        })
      }

      const onCZoneLabelQuery = (msg: any) => {
        const q = parseLabelQuery(extractRawPayload(msg))
        if (!q) return
        czoneEnabledBanks().forEach((bank: any) => {
          if (q.dipswitch !== bankDipswitch(bank)) return
          // queryType 0x80 = controller / group label (per-circuit), index
          // identifies the circuit by (instance, sub_instance). We answer
          // with the bank switch's display label.
          // queryType 0x87 = system / module name (per-module), no index.
          const replyIndex = (q.subInstance << 8) | q.instance
          let label = ''
          if (q.queryType === 0x87) {
            label = bank.czoneModuleName || `bank ${bank.instance}`
          } else {
            const switchIndex = q.subInstance
            const path = bank.switches?.[switchIndex]
            label = path ? switchLabel(path) : ''
          }
          if (!label) return
          const replyData = packLabelReply(q.queryType, replyIndex, label)
          const reply = czoneFrame(CZONE_PGN_LABEL_REPLY, replyData)
          debug(
            'czone label query type=%d (instance=%d sub=%d) -> %s',
            q.queryType,
            q.instance,
            q.subInstance,
            JSON.stringify(label)
          )
          sendFromBank(bank, reply)
        })
      }

      const onZcfComplete = (src: number, zcf: Buffer) => {
        const dataDir = app.getDataDirPath
          ? app.getDataDirPath()
          : path.join(__dirname, '..')
        try {
          fs.mkdirSync(dataDir, { recursive: true })
          const out = path.join(dataDir, 'last-czone.zcf')
          fs.writeFileSync(out, zcf)
          debug('saved .zcf (%d bytes) from src=%d to %s', zcf.length, src, out)
        } catch (e) {
          debug('failed to persist .zcf: %s', e)
        }
        const summary = parseZcf(zcf)
        if (summary.circuits.length === 0) {
          debug('zcf parse: no circuits found')
          return
        }
        debug(
          'zcf parse: %d circuits, first=%d, contiguous=%s',
          summary.circuits.length,
          summary.firstCircuitId,
          summary.contiguous
        )
        for (const c of summary.circuits) {
          debug('  circuit %d  %s', c.circuitId, c.name)
        }
        if (app.setProviderStatus) {
          const idStr = summary.contiguous
            ? `id range ${summary.firstCircuitId}..${summary.firstCircuitId! +
                summary.circuits.length -
                1}`
            : `ids ${summary.circuits.map(c => c.circuitId).join(',')}`
          app.setProviderStatus(
            `Saw .zcf from src=${src}: ${summary.circuits.length} circuits (${idStr})`
          )
        }
      }
      const zcfReassembler = new ZcfReassembler(onZcfComplete)

      // True when at least one bank has a DeviceEmulator attached; in
      // that case the per-bank emulator.onPGN callback is the dispatch
      // path for CZone proprietary PGNs. The server-wide listener
      // skips them here to avoid double-dispatch.
      const haveCZoneEmulators = (): boolean =>
        czoneEnabledBanks().some((b: any) => b.czoneEmulator)

      const n2kCallback = (msg: any) => {
        try {
          if (msg.pgn == CZONE_PGN_ZCF_TRANSFER) {
            const payload = extractRawPayload(msg)
            if (payload && msg.src !== undefined) {
              zcfReassembler.ingest(msg.src, payload)
            }
            return
          }
          if (
            msg.pgn == CZONE_PGN_CIRCUIT_CONTROL ||
            msg.pgn == CZONE_PGN_CIRCUIT_BITMAP ||
            msg.pgn == CZONE_PGN_LABEL_QUERY
          ) {
            if (haveCZoneEmulators()) {
              // The per-bank emulator's onPGN callback handles these.
              return
            }
            // Fallback path (older canboatjs without DeviceEmulator):
            // dispatch from the server-wide stream.
            if (msg.pgn == CZONE_PGN_CIRCUIT_CONTROL) {
              onCZoneCircuitControl(msg)
            } else if (msg.pgn == CZONE_PGN_CIRCUIT_BITMAP) {
              if (isCircuitStateQuery(extractRawPayload(msg))) {
                czoneEnabledBanks().forEach((b: any) => sendCZoneState(b))
              }
            } else if (msg.pgn == CZONE_PGN_LABEL_QUERY) {
              onCZoneLabelQuery(msg)
            }
            return
          }
          if (msg.pgn == 59904) {
            const requestedPgn =
              msg.fields['pgn'] !== undefined
                ? msg.fields['pgn']
                : msg.fields['PGN']
            if (requestedPgn == 127501) {
              debug('ISO Request for 127501 from src %j', msg.src)
              props.banks?.forEach((bank: any) => {
                if (bank.switches && bank.switches.length) {
                  sendBinaryStatusReport(bank)
                }
              })
            } else if (requestedPgn == 130060) {
              debug('ISO Request for 130060 from src %j', msg.src)
              props.banks?.forEach((bank: any) => {
                if (bank.switches && bank.switches.length) {
                  sendLabels(bank)
                }
              })
            }
            return
          }
          if (msg.pgn == 127502) {
            const camel = msg.fields['instance']
            const instance =
              camel !== undefined ? camel : msg.fields['Instance']
            if (switchBanks[instance]) {
              debug('msg: ' + JSON.stringify(msg))

              for (let i = 1; i < 29; i++) {
                const lowerVal = msg.fields[`switch${i}`]
                const val =
                  lowerVal !== undefined ? lowerVal : msg.fields[`Switch${i}`]
                if (typeof val !== 'undefined') {
                  applySwitchState(instance, i, val)
                }
              }
            }
          } else if (msg.pgn == 126208) {
            const functionCode =
              msg.fields['functionCode'] !== undefined
                ? msg.fields['functionCode']
                : msg.fields['Function Code']
            if (functionCode !== GroupFunction.Command && functionCode !== 1) {
              return
            }
            const commandedPgn =
              msg.fields['pgn'] !== undefined
                ? msg.fields['pgn']
                : msg.fields['PGN'] !== undefined
                ? msg.fields['PGN']
                : msg.fields['Commanded PGN']
            if (commandedPgn != 127501) {
              return
            }
            const list = msg.fields['list'] || msg.fields['List'] || []
            if (!Array.isArray(list) || list.length === 0) {
              return
            }

            let instance: any = undefined
            const channelUpdates: { channel: number; value: any }[] = []

            list.forEach((pair: any) => {
              const parameter =
                pair.parameter !== undefined ? pair.parameter : pair.Parameter
              const value = pair.value !== undefined ? pair.value : pair.Value
              if (parameter == 1) {
                instance = value
              } else if (
                typeof parameter === 'number' &&
                parameter >= 2 &&
                parameter <= 29
              ) {
                channelUpdates.push({ channel: parameter - 1, value })
              }
            })

            if (instance === undefined || !switchBanks[instance]) {
              sendAcknowledge(127501, msg.src, PgnErrorCode.PgnNotAvailable)
              return
            }

            debug('msg: ' + JSON.stringify(msg))
            channelUpdates.forEach(({ channel, value }) => {
              applySwitchState(instance, channel, value)
            })
            sendAcknowledge(127501, msg.src, PgnErrorCode.Acknowledge)
          }
        } catch (e) {
          error(e)
        }
      }
      app.on('N2KAnalyzerOut', n2kCallback)
      onStop.push(() => app.removeListener('N2KAnalyzerOut', n2kCallback))

      const labelTimer = setTimeout(() => {
        props.banks?.forEach((bank: any) => {
          if (bank.switches && bank.switches.length) {
            sendLabels(bank)
          }
        })
      }, 5000)
      onStop.push(() => clearTimeout(labelTimer))
    },

    stop: function () {
      onStop.forEach((f: any) => f())
      onStop = []
    },

    id: 'signalk-n2k-switching-emulator',
    name: 'NMEA 2000 Siwtching Emulator',
    description:
      'Signal K Plugin which makes existing switches in sk available as n2k switches',

    schema: () => {
      let paths = app.streambundle
        .getAvailablePaths()
        .filter(
          (path: any) =>
            path &&
            path.startsWith('electrical.switches.') &&
            path.endsWith('.state')
        )

      if (props) {
        props.banks?.forEach((bank: any) => {
          bank.switches?.forEach((sw: any) => {
            if (paths.indexOf(sw) === -1) {
              paths.push(sw)
            }
          })
        })
      }

      paths = paths.sort()

      return {
        //title: plugin.name,
        type: 'object',
        properties: {
          canDevice: {
            type: 'string',
            title: 'CAN interface',
            description:
              'SocketCAN interface name to bind the CZone-emulator devices to (e.g. "can0", "vcan0"). Each CZone-enabled bank claims its own NAME-MFG=295 source address on this interface, independent of any other CAN provider configured for the SignalK server.',
            default: 'can0'
          },
          banks: {
            title: 'Banks',
            type: 'array',
            description: 'N2K bank instances to emulate',
            items: {
              type: 'object',
              properties: {
                instance: {
                  title: 'N2K Bank Instance',
                  type: 'number',
                  default: 0
                },
                sendRate: {
                  title: 'Send Rate',
                  type: 'number',
                  description:
                    'Rate (in seconds) to send to N2K (set to 0 to not send updates)',
                  default: 15
                },
                switches: {
                  type: 'array',
                  title: 'Switches',
                  items: {
                    title: 'Switch Path',
                    type: 'string',
                    enum: paths.length > 0 ? paths : undefined
                  }
                },
                czoneEnabled: {
                  type: 'boolean',
                  title: 'Expose this bank as a CZone module on the bus',
                  default: false
                },
                czoneDipswitch: {
                  type: 'string',
                  title: 'CZone dipswitch (when CZone enabled)',
                  description:
                    'Eight-bit dipswitch as a binary string (the same value entered on the plotter\'s CZone settings page), e.g. "00011000". Each CZone-enabled bank must use a distinct dipswitch.',
                  default: '00011000',
                  pattern: '^[01]{8}$'
                },
                czoneFirstCircuitId: {
                  type: 'integer',
                  title: 'First CZone circuit id (when CZone enabled)',
                  description:
                    'The first circuit id the .zcf assigned to this module. Switch 1 of this bank = this id, switch 2 = id+1, etc. Yacht Devices YDAB-01 uses 13.',
                  default: 13,
                  minimum: 1,
                  maximum: 252
                }
              }
            }
          }
        }
      }
    }
  }

  function extractRawPayload (msg: any): Buffer | undefined {
    if (Buffer.isBuffer(msg?.data)) return msg.data
    const dataField = msg?.fields?.Data ?? msg?.fields?.data
    if (typeof dataField === 'string') {
      const cleaned = dataField.replace(/[^0-9a-fA-F]/g, '')
      if (cleaned.length % 2 !== 0) return undefined
      const buf = Buffer.alloc(2 + cleaned.length / 2)
      buf[0] = 0x27
      buf[1] = 0x99
      for (let i = 0; i < cleaned.length / 2; i++) {
        buf[2 + i] = parseInt(cleaned.substr(i * 2, 2), 16)
      }
      return buf
    }
    return undefined
  }

  // Per-bank in-memory cache of switch states. Inbound CZone circuit-control
  // (PGN 65280) writes to this synchronously so the next heartbeat reflects
  // the new state immediately. We also fall back to app.getSelfPath if the
  // cache hasn't seen the path yet (e.g. an externally-driven switch toggled
  // via SignalK delta from another producer).
  const switchStateCache: { [path: string]: boolean } = {}

  function setCachedSwitch (path: string, on: boolean): void {
    switchStateCache[path] = on
  }

  function readBankSwitchStates (bank: any): boolean[] {
    const out = new Array(CZONE_SUPPORTED_SWITCHES).fill(false)
    bank.switches?.forEach((sw: any, index: number) => {
      if (index >= CZONE_SUPPORTED_SWITCHES) return
      if (Object.prototype.hasOwnProperty.call(switchStateCache, sw)) {
        out[index] = switchStateCache[sw]
        return
      }
      const value = app.getSelfPath(sw)
      if (value && typeof value.value !== 'undefined') {
        out[index] = value.value === 1 || value.value === true
      }
    })
    return out
  }

  function czoneEnabledBanks (): any[] {
    return (
      props?.banks?.filter(
        (b: any) => b?.czoneEnabled && b.switches && b.switches.length
      ) ?? []
    )
  }

  function bankDipswitch (bank: any): number {
    return parseDipswitch(bank?.czoneDipswitch)
  }

  function bankFirstCircuitId (bank: any): number {
    const v = bank?.czoneFirstCircuitId
    return Number.isFinite(v) ? Number(v) : 13
  }

  function bankSerial (bank: any): number {
    return deriveUniqueSerial(
      `${app.config?.settings?.vesselUuid ??
        app.config?.settings?.vesselMMSI ??
        'signalk'}#${bank.instance}`
    )
  }

  // Send a CZone-proprietary frame from this bank. Preferred path is the
  // bank's own SimpleCan device, which has claimed a NAME-MFG=295 source
  // address on the configured canDevice — that's what the discovery spec
  // requires (czone-spec/spec/discovery.md#the-mfg295-gate).
  //
  // Fallback: if SimpleCan couldn't start (no canDevice, no socketcan, etc),
  // emit via the SignalK `nmea2000out` event so the host's existing CAN
  // provider (if any) carries the frame. The plotter won't gate it as
  // MFG=295 since the host's source address has its own NAME, but the
  // plugin keeps doing _something_ — and the test harness's FakeApp can
  // observe these emits without needing a real CAN socket.
  function sendFromBank (bank: any, frame: string): void {
    if (bank.czoneEmulator) {
      bank.czoneEmulator.sendPGN(frame)
    } else {
      app.emit('nmea2000out', frame)
    }
  }

  function sendCZoneState (bank: any): void {
    const switches = readBankSwitchStates(bank)
    const dipswitch = bankDipswitch(bank)
    const bitmap = czoneFrame(
      CZONE_PGN_CIRCUIT_BITMAP,
      packCircuitBitmap(dipswitch, switches)
    )
    debug('sending czone 65284 %s', bitmap)
    sendFromBank(bank, bitmap)

    const status = czoneFrame(
      CZONE_PGN_STATUS_EXTENDED,
      packStatusExtended(dipswitch, switches)
    )
    debug('sending czone 130817 %s', status)
    sendFromBank(bank, status)
  }

  function buildAddressClaim (bank: any): PGN_60928 {
    return new PGN_60928({
      uniqueNumber: bankSerial(bank),
      // czone-spec/spec/discovery.md "MFG=295 gate": the CZone receiver
      // requires NAME manufacturer_code = 295. ManufacturerCode.BepMarine
      // resolves to 116 (an older BEP company code); ManufacturerCode.
      // BepMarine2 resolves to 295 — exposed by @canboat/ts-pgns once
      // canboat upstream PR #627 disambiguated the duplicate "BEP Marine"
      // names in MANUFACTURER_CODE.
      manufacturerCode: ManufacturerCode.BepMarine2,
      deviceFunction: DeviceFunction.SwitchInterface,
      deviceClass: DeviceClass.ElectricalDistribution,
      deviceInstanceLower: 0,
      deviceInstanceUpper: 0,
      systemInstance: 0,
      industryGroup: IndustryCode.Marine,
      arbitraryAddressCapable: YesNo.Yes
    })
  }

  function buildProductInfo (bank: any): PGN_126996 {
    // productCode 8395 = COI = Combination Output Interface (per
    // czone-spec/spec/discovery.md#recognised-product-ids). Picked as the
    // closest match for "a generic 6-channel switch bank" until the spec
    // identifies a better default.
    return new PGN_126996({
      nmea2000Version: 1300,
      productCode: bank.czoneProductCode ?? 8395,
      modelId: (bank.czoneModuleName || `signalk-czone-${bank.instance}`).slice(
        0,
        32
      ),
      softwareVersionCode: '1.0',
      modelVersion: '1.0',
      modelSerialCode: String(bankSerial(bank)).slice(0, 32),
      certificationLevel: 0,
      loadEquivalency: 1
    })
  }

  // Bring up a SimpleCan-backed virtual N2K device for one CZone bank.
  // SimpleCan opens its own socketcan socket on `canDevice`, claims a
  // source address with NAME-MFG=295, and forwards every other frame on
  // the bus into our messageCb. Each bank gets its own SimpleCan so they
  // can claim independent N2K source addresses (matching the
  // "Recommended architecture: two N2K device personas" sketch in
  // czone-spec/spec/discovery.md).
  function attachEmulatorToBank (bank: any, canDevice: string): void {
    if (bank.czoneEmulator) return
    const id = `signalk-n2k-switching-emulator/bank-${bank.instance}`
    debug('creating SimpleCan emulator for bank %d on %s', bank.instance, canDevice)
    // Tests can override the SimpleCan implementation by setting
    // `app._simpleCanFactory` to a factory that returns an object with
    // `start()` and `sendPGN(msg)`. Production code uses the real
    // canboatjs SimpleCan which opens a socketcan socket.
    const SimpleCanCtor: any = (app as any)._simpleCanFactory ?? SimpleCan
    const device: any = new SimpleCanCtor(
      {
        app,
        canDevice,
        providerId: id,
        addressClaim: buildAddressClaim(bank),
        productInfo: buildProductInfo(bank)
      },
      (msg: any) => {
        // SimpleCan delivers raw single-frame messages: { pgn, length, data }
        // where pgn = { src, dst, pgn, prio } and data is the 8-byte frame.
        // Adapt to onCZonePGN's expected shape (.pgn / .src / .dst / .data).
        if (!msg || !msg.pgn) return
        onCZonePGN(bank, {
          pgn: msg.pgn.pgn,
          src: msg.pgn.src,
          dst: msg.pgn.dst,
          data: msg.data
        })
      }
    )
    try {
      device.start()
      bank.czoneEmulator = device
      onStop.push(() => {
        try {
          device.candevice?.stop?.()
          device.channel?.stop?.()
        } catch (e) {
          debug('SimpleCan stop for bank %d failed: %s', bank.instance, e)
        }
        delete bank.czoneEmulator
      })
    } catch (e: any) {
      // canDevice doesn't exist, no permission, etc. The plugin keeps
      // running so that any non-CZone behaviours (PGN 127501 emission,
      // ack/group-function handling) still work, and CZone PGNs fall back
      // to nmea2000out emission without the MFG=295 source-address gate.
      error(
        `failed to start SimpleCan for bank ${bank.instance} on ${canDevice}: ${e?.message || e}`
      )
    }
    // Send the announce regardless of whether SimpleCan started: if it did,
    // it goes out via the MFG=295 socket; if it didn't, it goes via
    // nmea2000out fallback so consumers see something.
    sendBankAnnounce(bank)
  }

  // Dispatch a CZone proprietary PGN that arrived on a specific bank's
  // DeviceEmulator. The bank context is known statically (each bank
  // owns one emulator) so we don't need to iterate every CZone-enabled
  // bank like the server-wide n2kCallback does.
  function onCZonePGN (bank: any, pgn: any): void {
    if (!pgn) return
    if (pgn.pgn === CZONE_PGN_CIRCUIT_CONTROL) {
      const result = parseCircuitControl(extractRawPayload(pgn))
      if (!result) return
      const switchIndex = circuitIdToSwitchIndex(
        result.circuitId,
        bankFirstCircuitId(bank),
        bank.switches.length
      )
      if (switchIndex < 0) return
      const path = bank.switches[switchIndex]
      if (!path) return
      debug(
        'czone circuit %d -> bank %d switch %d path %s = %s',
        result.circuitId,
        bank.instance,
        switchIndex + 1,
        path,
        result.on ? 'on' : 'off'
      )
      app.putSelfPath(path, result.on ? 1 : 0)
      // Update the in-memory mirror synchronously so the next heartbeat
      // reflects the new state without waiting for the SignalK delta
      // pipeline to round-trip back through getSelfPath.
      setCachedSwitch(path, result.on)
      sendCZoneState(bank)
      return
    }
    if (pgn.pgn === CZONE_PGN_CIRCUIT_BITMAP) {
      if (isCircuitStateQuery(extractRawPayload(pgn))) {
        sendCZoneState(bank)
      }
      return
    }
    if (pgn.pgn === CZONE_PGN_LABEL_QUERY) {
      const q = parseLabelQuery(extractRawPayload(pgn))
      if (!q) return
      if (q.dipswitch !== bankDipswitch(bank)) return
      const replyIndex = (q.subInstance << 8) | q.instance
      let label = ''
      if (q.queryType === 0x87) {
        label = bank.czoneModuleName || `bank ${bank.instance}`
      } else {
        const switchIndex = q.subInstance
        const path = bank.switches?.[switchIndex]
        label = path ? switchLabel(path) : ''
      }
      if (!label) return
      const replyData = packLabelReply(q.queryType, replyIndex, label)
      const reply = czoneFrame(CZONE_PGN_LABEL_REPLY, replyData)
      debug(
        'czone label query type=%d (instance=%d sub=%d) -> %s',
        q.queryType,
        q.instance,
        q.subInstance,
        JSON.stringify(label)
      )
      sendFromBank(bank, reply)
    }
  }

  function sendBankAnnounce (bank: any): void {
    const dipswitch = bankDipswitch(bank)
    const serial = bankSerial(bank)
    const announce = czoneFrame(
      CZONE_PGN_ANNOUNCE,
      packAnnounce(serial, dipswitch)
    )
    sendFromBank(bank, announce)
  }

  function startCZoneEmulation (): void {
    const canDevice = props?.canDevice ?? 'can0'
    czoneEnabledBanks().forEach((bank: any) => {
      const dipswitch = bankDipswitch(bank)
      const serial = bankSerial(bank)
      debug(
        'czone emulation: bank=%d dipswitch=%d serial=%d canDevice=%s',
        bank.instance,
        dipswitch,
        serial,
        canDevice
      )
      // Bring up a SimpleCan-backed virtual N2K device that claims its own
      // NAME-MFG=295 source address (czone-spec/spec/discovery.md#the-mfg295-gate).
      // SimpleCan starts immediately and synchronously claims an address
      // on the configured canDevice, independent of the SignalK server's
      // own canbus provider.
      attachEmulatorToBank(bank, canDevice)
      // Defensive: re-broadcast the announce a few times after startup so
      // a plotter that booted slightly later still sees it. spec/pgn-65290.md
      // doesn't mandate a cadence, but real CZone modules tolerate
      // periodic re-announce and the bus chatter is negligible.
      const announceInterval = setInterval(
        () => sendBankAnnounce(bank),
        CZONE_ANNOUNCE_MS
      )
      onStop.push(() => clearInterval(announceInterval))
      const interval = setInterval(
        () => sendCZoneState(bank),
        CZONE_HEARTBEAT_MS
      )
      onStop.push(() => clearInterval(interval))
    })
  }

  function switchLabel (path: string): string {
    const data = app.getSelfPath(path)
    if (data?.meta?.displayName) {
      return data.meta.displayName
    }
    const parts = path
      .replace('electrical.switches.', '')
      .replace('.state', '')
      .split('.')
    return parts
      .map((p: string) =>
        p
          .replace(/([A-Z])/g, ' $1')
          .replace(/^./, (c: string) => c.toUpperCase())
      )
      .join(' ')
      .trim()
  }

  function makeBinaryStatusReport (bank: any) {
    const pgn = new PGN_127501({
      instance: bank.instance
    })

    bank.switches?.forEach((sw: any, index: number) => {
      const value = app.getSelfPath(sw)
      if (value && typeof value.value !== 'undefined') {
        ;(pgn.fields as any)[`indicator${index + 1}`] =
          value.value === 1 || value.value === true ? 'On' : 'Off'
      }
    })
    return pgn
  }

  return plugin
}

interface Plugin {
  start: (app: any) => void
  stop: () => void
  id: string
  name: string
  description: string
  schema: any
}
