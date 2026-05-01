/*
 * CZone proprietary helpers used to make a virtual switch bank appear as a
 * Navico CZone-compatible device on NMEA2000 so plotters such as Zeus, GO,
 * and Axiom discover and display the bank.
 *
 * All CZone proprietary PGNs share a 2-byte manufacturer-code/industry-code
 * header (mfg=295 = Navico/CZone, industry=4 = Marine), encoded as
 * little-endian bytes 0x27 0x99.
 *
 * Reference: github.com/negrusti/czone-emulator-cs (verified working with Axiom).
 */

const CZONE_HEADER_LO = 0x27
const CZONE_HEADER_HI = 0x99

export const CZONE_PGN_CIRCUIT_CONTROL = 65280 // inbound: MFD -> module commands
export const CZONE_PGN_CIRCUIT_BITMAP = 65284 // outbound: state bitmap; inbound: query
export const CZONE_PGN_ANNOUNCE = 65290 // outbound: one-shot announce
export const CZONE_PGN_STATUS_EXTENDED = 130817 // outbound: extended status (fast packet)

export const CZONE_PGN_SWITCH_BANK_STATUS = 127501
export const CZONE_PGN_SWITCH_BANK_CONTROL = 127502

export const CZONE_FIRST_CIRCUIT_ID = 0x0d
export const CZONE_SUPPORTED_SWITCHES = 6

export const CZONE_COMMAND_ON = 0xf1
export const CZONE_COMMAND_OFF = 0xf2
export const CZONE_QUERY_CODE = 0xc8
export const CZONE_QUERY_SCOPE = 0x10

const CZONE_CIRCUIT_STATE_TYPE = 0x0f
const CZONE_EXTENDED_STATUS_PAGE = 0x01
const CZONE_EXTENDED_POSITIVE_FLAG = 0x04
const CZONE_ANALOG_BASE_OFFSET = 4
const CZONE_ANALOG_STRIDE = 3
const CZONE_EXTENDED_PAYLOAD_LEN = 22
const CZONE_BITS_PER_SWITCH = 2
const CZONE_SWITCHES_PER_STATUS_BYTE = 4

function header (): Buffer {
  return Buffer.from([CZONE_HEADER_LO, CZONE_HEADER_HI])
}

const CZONE_PRIORITY = 6

/**
 * Build a CZone proprietary frame as an Actisense-format string suitable
 * for emission via the SignalK `nmea2000out` event.
 *
 * Emitted as a string rather than a JSON PGN object because canboatjs's
 * `toPgn()` requires a registered PGN definition to serialize, and the
 * CZone proprietary PGNs (65280/65283/65284/65290/130817) are not part of
 * the standard canboat database; the raw `data` field on a JSON message
 * is ignored. The Actisense string path passes the bytes through unchanged.
 */
export function czoneFrame (pgn: number, payload: Buffer): string {
  const bytes = Buffer.concat([header(), payload])
  const hex = Array.from(bytes)
    .map(b =>
      b
        .toString(16)
        .padStart(2, '0')
        .toUpperCase()
    )
    .join(',')
  return `${new Date().toISOString()},${CZONE_PRIORITY},${pgn},0,255,${
    bytes.length
  },${hex}`
}

/**
 * PGN 65290 announce payload (6 data bytes after the 2-byte CZone header):
 * carries an opaque module identifier and the dipswitch value the module
 * is claiming. Reference capture observed `3B B1 0D 00 00 18`.
 */
export function packAnnounce (uniqueSerial: number, dipswitch: number): Buffer {
  const buf = Buffer.alloc(6)
  buf[0] = uniqueSerial & 0xff
  buf[1] = (uniqueSerial >> 8) & 0xff
  buf[2] = (uniqueSerial >> 16) & 0x0f
  buf[5] = dipswitch & 0xff
  return buf
}

/**
 * PGN 130817 (Status Extended) payload after the 2-byte CZone header. Carries
 * a state-page identifier, the dipswitch, and one 3-byte analog record per
 * switch. The record layout is `[state, secondary, flag]`; the meaningful
 * byte is the first (1 = on, 0 = off).
 */
export function packStatusExtended (
  dipswitch: number,
  switches: boolean[]
): Buffer {
  const payload = Buffer.alloc(CZONE_EXTENDED_PAYLOAD_LEN - 2)
  payload[0] = CZONE_EXTENDED_STATUS_PAGE
  payload[1] = dipswitch & 0xff
  for (let i = 0; i < CZONE_SUPPORTED_SWITCHES; i++) {
    const offset = CZONE_ANALOG_BASE_OFFSET - 2 + i * CZONE_ANALOG_STRIDE
    if (offset + 2 < payload.length) {
      const on = switches[i] ? 1 : 0
      payload[offset] = on
      payload[offset + 1] = on
      payload[offset + 2] = CZONE_EXTENDED_POSITIVE_FLAG
    }
  }
  return payload
}

/**
 * PGN 65284 carries the bank's circuit-state bitmap.
 *   byte[0..1] = CZone header (filled by caller via czoneFrame)
 *   byte[2]    = dipswitch
 *   byte[3]    = circuit state type (0x0F)
 *   byte[4..7] = 32-bit bitmap of circuits that are ON
 */
export function packCircuitBitmap (
  dipswitch: number,
  switches: boolean[]
): Buffer {
  const buf = Buffer.alloc(6)
  buf[0] = dipswitch & 0xff
  buf[1] = CZONE_CIRCUIT_STATE_TYPE
  for (let i = 0; i < Math.min(switches.length, 32); i++) {
    if (switches[i]) {
      buf[2 + (i >> 3)] |= 1 << (i & 7)
    }
  }
  return buf
}

/**
 * Standard PGN 127501 Binary Switch Bank Status as the CZone module reports
 * it: 8-byte payload starting with the bank instance, followed by 6 switch
 * states packed at 2 bits per switch, 4 switches per byte (so byte[1] holds
 * switches 1-4, byte[2] holds switches 5-6).
 */
export function packBinaryStatusReport (
  instance: number,
  switches: boolean[]
): Buffer {
  const buf = Buffer.alloc(8)
  buf[0] = instance & 0xff
  for (let i = 0; i < CZONE_SUPPORTED_SWITCHES; i++) {
    if (switches[i]) {
      const byteIndex = 1 + Math.floor(i / CZONE_SWITCHES_PER_STATUS_BYTE)
      const slot = i % CZONE_SWITCHES_PER_STATUS_BYTE
      const shift = slot * CZONE_BITS_PER_SWITCH
      buf[byteIndex] = (buf[byteIndex] & ~(0x03 << shift)) | (0x01 << shift)
    }
  }
  return buf
}

/**
 * Parse PGN 65280 inbound. Returns the circuit id and on/off command if the
 * payload is a CZone circuit-control command, or undefined otherwise.
 */
export function parseCircuitControl (
  payload: Buffer | number[] | undefined
): { circuitId: number; on: boolean } | undefined {
  if (!payload || payload.length < 8) return undefined
  const p = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
  if (p[0] !== CZONE_HEADER_LO || p[1] !== CZONE_HEADER_HI) return undefined
  const cmd = p[6]
  if (cmd !== CZONE_COMMAND_ON && cmd !== CZONE_COMMAND_OFF) return undefined
  return { circuitId: p[2], on: cmd === CZONE_COMMAND_ON }
}

/**
 * Detect the CZone "bitmap query" form of inbound PGN 65284.
 */
export function isCircuitStateQuery (
  payload: Buffer | number[] | undefined
): boolean {
  if (!payload || payload.length < 4) return false
  const p = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
  return (
    p[0] === CZONE_HEADER_LO &&
    p[1] === CZONE_HEADER_HI &&
    p[2] === CZONE_QUERY_CODE &&
    p[3] === CZONE_QUERY_SCOPE
  )
}

/**
 * Map a CZone circuitId (0x0D, 0x0E, ...) to a 0-based switch index.
 */
export function circuitIdToSwitchIndex (circuitId: number): number {
  const i = circuitId - CZONE_FIRST_CIRCUIT_ID
  return i >= 0 && i < CZONE_SUPPORTED_SWITCHES ? i : -1
}

/**
 * Parse a CZone dipswitch setting. Accepts the eight-position binary string
 * users enter on the plotter's CZone settings page, e.g. "00011000". A number
 * is accepted unchanged (its low 8 bits become the dipswitch value).
 */
export function parseDipswitch (input: unknown): number {
  if (typeof input === 'number' && Number.isFinite(input)) {
    return input & 0xff
  }
  if (typeof input === 'string') {
    const cleaned = input.trim()
    if (/^[01]{8}$/.test(cleaned)) {
      return parseInt(cleaned, 2)
    }
  }
  return 0x18
}

/**
 * Derive a stable 20-bit unique serial from a seed string.
 */
export function deriveUniqueSerial (seed: string | undefined): number {
  const s = String(seed ?? 'signalk')
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0
  }
  return h & 0xfffff
}
