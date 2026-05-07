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
import { toPgn } from '@canboat/canboatjs'
import { satisfies } from 'semver'
import * as fs from 'fs'
import * as path from 'path'
import {
  chunkZcf,
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
import { generateZcf, ZcfGenSpec, SUB_CATEGORY_BIT } from './zcfEncoder'

/**
 * Map a UI-friendly sub-category name (or "none") to the bitmap value
 * the .zcf circuits-section flags_b expects. All 16 low-half bits
 * exposed (verified via czone-spec/spec/zcf-section-circuits.md
 * cross-referenced with real .zcf samples).
 */
const SUB_CATEGORY_NAME_TO_BIT: { [key: string]: number } = {
  none: 0,
  'house-habitat': SUB_CATEGORY_BIT.HOUSE_HABITAT,
  'vessel-critical': SUB_CATEGORY_BIT.VESSEL_CRITICAL,
  navigation: SUB_CATEGORY_BIT.NAVIGATION,
  electronics: SUB_CATEGORY_BIT.ELECTRONICS,
  '24-hour': SUB_CATEGORY_BIT.TWENTY_FOUR_HOUR,
  communications: SUB_CATEGORY_BIT.COMMUNICATIONS,
  accessories: SUB_CATEGORY_BIT.ACCESSORIES,
  'indicators-alarms': SUB_CATEGORY_BIT.INDICATORS_AND_ALARMS,
  'engine-management': SUB_CATEGORY_BIT.ENGINE_MANAGEMENT,
  'fans-ventilation': SUB_CATEGORY_BIT.FANS_VENTILATION,
  lighting: SUB_CATEGORY_BIT.LIGHTING,
  'vessel-management': SUB_CATEGORY_BIT.VESSEL_MANAGEMENT,
  pumps: SUB_CATEGORY_BIT.PUMPS,
  'propulsion-management': SUB_CATEGORY_BIT.PROPULSION_MANAGEMENT,
  power: SUB_CATEGORY_BIT.POWER,
  refrigeration: SUB_CATEGORY_BIT.REFRIGERATION
}

const CZONE_HEARTBEAT_MS = 2000
// Re-broadcast PGN 65290 every 10 s so a plotter that joins the bus after
// the plugin starts still sees the module's announce. spec/pgn-65290.md
// doesn't mandate a cadence — this is defensive correctness.
const CZONE_ANNOUNCE_MS = 10000
const CZONE_PGN_ZCF_TRANSFER = 130816
// SignalK PUT path that triggers a .zcf push when czoneZcfPushEnabled is true.
// The PUT value carries the .zcf as a base64 string.
const CZONE_ZCF_PUSH_PATH = 'electrical.czone.pushZcf'

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
            const payload = extractZcfPayload(msg) ?? extractRawPayload(msg)
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

      registerZcfPushHandler()

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

    registerWithRouter: (router: any) => {
      // GET /plugins/signalk-n2k-switching-emulator/zcf?bank=N
      // Returns a synthesised .zcf for the requested bank as a download.
      // Defaults to bank index 0. Useful for a user who wants to load the
      // plugin's switch configuration into the CZone Configuration Tool
      // or upload it to a Navico MFD via SD/USB.
      router.get('/zcf', (req: any, res: any) => {
        const bankIndex =
          req.query?.bank !== undefined ? parseInt(String(req.query.bank), 10) : 0
        if (!Number.isFinite(bankIndex) || bankIndex < 0) {
          return res.status(400).send('bank must be a non-negative integer')
        }
        const bank = props?.banks?.[bankIndex]
        if (!bank) {
          return res.status(404).send(`no bank at index ${bankIndex}`)
        }
        try {
          const zcf = generateZcfForBank(bank)
          const filename = `${(bank.czoneModuleName || `signalk-bank-${bank.instance}`)
            .replace(/[^a-zA-Z0-9._-]/g, '_')}.zcf`
          res.setHeader('Content-Type', 'application/octet-stream')
          res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
          res.send(zcf)
        } catch (e: any) {
          error(e)
          res.status(500).send(`zcf generation failed: ${e?.message ?? e}`)
        }
      })
    },

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
          czoneZcfPushEnabled: {
            type: 'boolean',
            title: 'Enable .zcf push to the CZone bus (experimental)',
            description:
              'When enabled, the plugin can push a .zcf file to the bus via PGN 130816 ' +
              'fast-packet sequences from the first CZone-enabled bank\'s source address. ' +
              'Trigger with a SignalK PUT to electrical.czone.pushZcf carrying ' +
              '{ "value": "<base64 of .zcf>" } in the request body. ' +
              'Real CZone modules and plotters listening on PGN 130816 will receive the ' +
              'broadcast; whether a real plotter accepts a non-plotter-originated .zcf as ' +
              'a config replacement is not yet pinned down by czone-spec. Default off.',
            default: false
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
                },
                czoneModuleName: {
                  type: 'string',
                  title: 'CZone module name',
                  description:
                    'Module label as shown in the CZone Configuration Tool and used as the answer to a system-name query (PGN 65299 query_type 0x87). Also used as the filename for downloaded .zcf files. Optional.',
                  default: ''
                },
                czoneConfigName: {
                  type: 'string',
                  title: 'CZone config name',
                  description:
                    'Top-level config label written into the .zcf when generating one for download. Defaults to "SignalK Switching <instance>" if empty.',
                  default: ''
                },
                czoneSubCategories: {
                  type: 'array',
                  title: 'CZone sub-categories per switch (optional)',
                  description:
                    'One sub-category per switch (in the same order as the switches array) shown by the CZone Configuration Tool in its Circuit Menu Sub-Categories grid. Leave a slot at "none" to keep the circuit uncategorised.',
                  items: {
                    type: 'string',
                    enum: [
                      'none',
                      'house-habitat',
                      'vessel-critical',
                      'navigation',
                      'electronics',
                      '24-hour',
                      'communications',
                      'accessories',
                      'indicators-alarms',
                      'engine-management',
                      'fans-ventilation',
                      'lighting',
                      'vessel-management',
                      'pumps',
                      'propulsion-management',
                      'power',
                      'refrigeration'
                    ],
                    default: 'none'
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  // PGN 130816 dedicated extractor. canboatjs may deliver this PGN in
  // either of two shapes:
  //
  //  (a) Stub: fields.Data is a hex string of EVERY byte after the
  //      0x27 0x99 manufacturer header (chunk_idx + flag + reserved
  //      + actual .zcf data). Older canboat releases use this.
  //
  //  (b) Named: fields.{chunkIndex, flag, reserved6, data} where each
  //      field carries only its slice. The `data` field is just the
  //      trailing .zcf payload, NOT everything-after-header. Newer
  //      canboat releases (with the full BEP CZone .zcf Bus Distribution
  //      definition) use this shape.
  //
  // The legacy extractRawPayload only handles (a) and would prepend
  // 0x27 0x99 to the data slice in (b), producing a buffer the
  // ZcfReassembler reads chunk_idx out of the wrong byte offsets.
  // This helper handles (b) explicitly: rebuild the wire bytes from
  // the named fields, in the order the ZcfReassembler expects.
  function extractZcfPayload (msg: any): Buffer | undefined {
    const fields = msg?.fields
    if (!fields || typeof fields.chunkIndex !== 'number') return undefined
    const dataHex = fields.data ?? fields.Data
    if (typeof dataHex !== 'string') return undefined
    const cleaned = dataHex.replace(/[^0-9a-fA-F]/g, '')
    if (cleaned.length % 2 !== 0) return undefined
    const dataBytes = Buffer.alloc(cleaned.length / 2)
    for (let i = 0; i < dataBytes.length; i++) {
      dataBytes[i] = parseInt(cleaned.substr(i * 2, 2), 16)
    }
    // Build the 23-byte fixed header + dataBytes:
    //   [0x27 0x99] + chunkIndex u16 LE + flag u8 + 18 reserved bytes + data
    const buf = Buffer.alloc(23 + dataBytes.length)
    buf[0] = 0x27
    buf[1] = 0x99
    buf.writeUInt16LE(fields.chunkIndex & 0xffff, 2)
    buf[4] = (fields.flag ?? 0) & 0xff
    // bytes 5..22 are reserved zero (already zero from Buffer.alloc).
    dataBytes.copy(buf, 23)
    return buf
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
    // canboatjs has parsed the proprietary fields (e.g. circuit_id,
    // levelOrValue) into msg.fields and dropped the catch-all `Data`.
    // Round-trip back through the encoder to reconstruct the wire bytes
    // so our spec-driven parsers (parseCircuitControl, parseLabelQuery,
    // ...) see the same byte layout regardless of whether canboat ships
    // a stub for the PGN or a fully-decoded definition.
    if (msg?.fields && typeof msg.pgn === 'number') {
      try {
        const buf = toPgn(msg as any)
        if (Buffer.isBuffer(buf)) return buf
      } catch (e) {
        debug('extractRawPayload toPgn failed for pgn %d: %s', msg.pgn, e)
      }
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

  // Send a CZone-proprietary frame either through the bank's own
  // DeviceEmulator (when canboatjsUtils exposed createEmulator and we've
  // claimed a NAME-MFG=295 device for this bank) or, on older canboatjs
  // versions without that API, by injecting an Actisense string via the
  // `nmea2000out` event so the host CAN provider rewrites src to the
  // server's claimed source.
  //
  // The emulator path is what the discovery spec actually requires
  // (czone-spec/spec/discovery.md#the-mfg295-gate); the fallback exists
  // only so the plugin keeps doing _something_ on older canboatjs.
  function sendFromBank (bank: any, frame: string): void {
    if (bank.czoneEmulator) {
      bank.czoneEmulator.send(frame)
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

  function attachEmulatorToBank (bank: any, utils: any): void {
    if (bank.czoneEmulator) return
    const id = `signalk-n2k-switching-emulator/bank-${bank.instance}`
    debug(
      'creating CZone emulator for bank %d via canboatjsUtils id=%s',
      bank.instance,
      id
    )
    const emulator = utils.createEmulator(
      id,
      {},
      buildAddressClaim(bank),
      buildProductInfo(bank),
      undefined
    )
    bank.czoneEmulator = emulator
    onStop.push(() => {
      try {
        utils.removeEmulator(id)
      } catch (e) {
        debug('removeEmulator(%s) failed: %s', id, e)
      }
      delete bank.czoneEmulator
    })
    emulator.onPGN((pgn: any) => onCZonePGN(bank, pgn))
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

  // Locate the bundled .zcf template that generateZcf uses as a structural
  // prototype. When the plugin is installed via npm, dist/ sits next to
  // templates/ inside the package; in development from this repo it's the
  // same layout. Falls back to scanning a couple of well-known parents.
  let cachedTemplate: Buffer | undefined
  function loadZcfTemplate (): Buffer {
    if (cachedTemplate) return cachedTemplate
    const candidates = [
      path.join(__dirname, '..', 'templates', 'template.zcf'),
      path.join(__dirname, '..', '..', 'templates', 'template.zcf')
    ]
    for (const p of candidates) {
      try {
        cachedTemplate = fs.readFileSync(p)
        return cachedTemplate
      } catch {
        // try next
      }
    }
    throw new Error(
      `could not find template.zcf in any of: ${candidates.join(', ')}`
    )
  }

  function generateZcfForBank (bank: any): Buffer {
    const template = loadZcfTemplate()
    const switches = (bank.switches as string[]) ?? []
    if (switches.length === 0) {
      throw new Error(`bank ${bank.instance} has no switches configured`)
    }
    const firstCircuitId = bankFirstCircuitId(bank)
    const dipswitch = bank.czoneEnabled ? bankDipswitch(bank) : 0x18
    const moduleName = bank.czoneModuleName || `SignalK Bank ${bank.instance}`
    const subCats = (bank.czoneSubCategories as string[]) ?? []
    const spec: ZcfGenSpec = {
      configName: bank.czoneConfigName || `SignalK Switching ${bank.instance}`,
      module: { dipswitch, name: moduleName },
      bankInstance: bank.instance & 0xff,
      circuits: switches.map((sw, i) => {
        const subKey = subCats[i] ?? 'none'
        const subCategory = SUB_CATEGORY_NAME_TO_BIT[subKey] ?? 0
        return {
          name: switchLabel(sw),
          circuitId: firstCircuitId + i,
          subCategory
        }
      })
    }
    return generateZcf(spec, template)
  }

  // Push a full .zcf onto the bus as a sequence of PGN 130816 fast-packet
  // frames from the first CZone-enabled bank's source address. Mirrors what
  // a Zeus 3S plotter does when distributing a config — see
  // czone-spec/spec/pgn-130816.md "Frame layout" and the captures referenced
  // there. Gated on `props.czoneZcfPushEnabled`; the PUT handler refuses
  // when the toggle is off so this stays opt-in.
  function pushZcfToBus (zcf: Buffer): { chunks: number; bank: any } {
    const banks = czoneEnabledBanks()
    if (banks.length === 0) {
      throw new Error('no CZone-enabled bank to push from')
    }
    const bank = banks[0]
    const chunks = chunkZcf(zcf)
    for (const c of chunks) {
      const frame = czoneFrame(CZONE_PGN_ZCF_TRANSFER, c.payload)
      sendFromBank(bank, frame)
    }
    return { chunks: chunks.length, bank }
  }

  // SignalK PUT handler on `electrical.czone.pushZcf`. Body shape:
  //   { "value": "<base64 of .zcf>" }
  // Returns a SignalK ActionResult-compatible object.
  function registerZcfPushHandler (): void {
    if (typeof app.registerPutHandler !== 'function') {
      debug('app.registerPutHandler unavailable; .zcf push disabled')
      return
    }
    app.registerPutHandler(
      'vessels.self',
      CZONE_ZCF_PUSH_PATH,
      (_context: string, _path: string, value: any, _callback?: any) => {
        if (!props?.czoneZcfPushEnabled) {
          return {
            state: 'COMPLETED',
            statusCode: 403,
            message:
              'czoneZcfPushEnabled is false — enable it in plugin settings'
          }
        }
        if (typeof value !== 'string' || value.length === 0) {
          return {
            state: 'COMPLETED',
            statusCode: 400,
            message: 'PUT value must be a non-empty base64 string'
          }
        }
        let zcf: Buffer
        try {
          zcf = Buffer.from(value, 'base64')
        } catch (e) {
          return {
            state: 'COMPLETED',
            statusCode: 400,
            message: `base64 decode failed: ${e}`
          }
        }
        // Sanity-check the .zcf header. parseZcf returns at least an empty
        // circuit list on garbage input, so use it as a soft validator: a
        // file with zero strings is almost certainly not a real .zcf.
        const summary = parseZcf(zcf)
        if (zcf.length < 32 || summary.strings.length === 0) {
          return {
            state: 'COMPLETED',
            statusCode: 400,
            message: `payload (${zcf.length} bytes) does not look like a .zcf`
          }
        }
        try {
          const { chunks, bank } = pushZcfToBus(zcf)
          debug(
            'pushed .zcf (%d bytes) as %d chunks from bank %d',
            zcf.length,
            chunks,
            bank.instance
          )
          return {
            state: 'COMPLETED',
            statusCode: 200,
            message: `pushed ${zcf.length} bytes as ${chunks} chunks`
          }
        } catch (e: any) {
          error(e)
          return {
            state: 'COMPLETED',
            statusCode: 500,
            message: e?.message ?? String(e)
          }
        }
      }
    )
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
    czoneEnabledBanks().forEach((bank: any) => {
      const dipswitch = bankDipswitch(bank)
      const serial = bankSerial(bank)
      debug(
        'czone emulation: bank=%d dipswitch=%d serial=%d',
        bank.instance,
        dipswitch,
        serial
      )
      // The first announce goes out via the nmea2000out fallback; once
      // canboatjsUtils arrives below, the bank's DeviceEmulator is
      // attached and the next periodic announce uses the MFG=295 path.
      sendBankAnnounce(bank)
      // Defensive: re-broadcast PGN 65290 every 10 s so a plotter that
      // joins the bus after the plugin starts still sees the announce.
      // spec/pgn-65290.md doesn't mandate a cadence; real CZone modules
      // tolerate periodic re-announce and the bus chatter is negligible.
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

    // Subscribe to canboatjsUtils to get the DeviceEmulator factory; when
    // it arrives, attach a per-bank emulator that claims a NAME-MFG=295
    // device on the bus. This is what the spec's MFG=295 gate requires
    // (czone-spec/spec/discovery.md#the-mfg295-gate).
    if (typeof app.onPropertyValues === 'function') {
      app.onPropertyValues('canboatjsUtils', (history: any[]) => {
        if (!history) return
        for (const entry of history) {
          if (!entry || !entry.value) continue
          const utils = (entry.value as any).utils
          if (!utils || !utils.supportsDeviceCreation) continue
          czoneEnabledBanks().forEach((bank: any) =>
            attachEmulatorToBank(bank, utils)
          )
        }
      })
    } else {
      debug(
        'app.onPropertyValues unavailable; falling back to nmea2000out path. ' +
          'CZone main panel will not see MFG=295 in the address claim — ' +
          'upgrade canboatjs to the version that exports createEmulator.'
      )
    }
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
  registerWithRouter?: (router: any) => void
}
