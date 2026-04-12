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
  PGN_127502,
  PGN_127501,
  PGN_130060,
  PGN_126208_NmeaAcknowledgeGroupFunction,
  GroupFunction,
  PgnErrorCode,
  mapCamelCaseKeys
} from '@canboat/ts-pgns'
import { satisfies } from 'semver'

export default function (app: any) {
  const error = app.error
  const debug = app.debug
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

      const n2kCallback = (msg: any) => {
        try {
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
                }
              }
            }
          }
        }
      }
    }
  }

  function switchLabel (path: string): string {
    const data = app.getSelfPath(path)
    if (data?.meta?.displayName) {
      return data.meta.displayName
    }
    const parts = path.replace('electrical.switches.', '').replace('.state', '').split('.')
    return parts
      .map((p: string) => p.replace(/([A-Z])/g, ' $1').replace(/^./, (c: string) => c.toUpperCase()))
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
