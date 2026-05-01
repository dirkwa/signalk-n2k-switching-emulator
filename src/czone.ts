/*
 * CZone (BEP Marine) proprietary helpers used to make a virtual switch bank
 * appear as a Navico CZone-compatible device on NMEA2000 so plotters such as
 * Zeus and GO discover and display the bank.
 *
 * All BEP proprietary PGNs share a 2-byte manufacturer-code/industry-code
 * header (mfg=116 = BEP Marine, industry=4 = Marine).
 */

const BEP_MANUFACTURER_CODE = 116

export const CZONE_PGN_DIPSWITCH_STATE = 65283
export const CZONE_PGN_CAPABILITY = 65284
export const CZONE_PGN_ANNOUNCE = 65290
export const CZONE_PGN_CIRCUIT_DESCRIPTOR = 130817

function bepHeader (): Buffer {
  // bits 0-10  = manufacturer code (116)
  // bits 11-12 = reserved (11b)
  // bits 13-15 = industry code  (4 = Marine)
  const header = (0b100 << 13) | (0b11 << 11) | BEP_MANUFACTURER_CODE
  const buf = Buffer.alloc(2)
  buf[0] = header & 0xff
  buf[1] = (header >> 8) & 0xff
  return buf
}

export function bepFrame (pgn: number, src: number, payload: Buffer): any {
  const data = Buffer.concat([bepHeader(), payload])
  return { pgn, prio: 6, dst: 255, src, forceSrc: true, data }
}

/**
 * PGN 65290 announce payload: 6 data bytes encoding a unique 20-bit serial
 * and the dipswitch group number that this device claims.
 */
export function packAnnounce (uniqueSerial: number, group: number): Buffer {
  const buf = Buffer.alloc(6)
  buf[0] = uniqueSerial & 0xff
  buf[1] = (uniqueSerial >> 8) & 0xff
  buf[2] = (uniqueSerial >> 16) & 0x0f
  buf[3] = 0
  buf[4] = 0
  buf[5] = group & 0xff
  return buf
}

/**
 * PGN 130817 circuit descriptor: 20 bytes. Empty template carries no
 * configured circuits; the plotter uses standard PGN 130060 labels instead.
 */
export function packCircuitDescriptor (group: number): Buffer {
  const buf = Buffer.alloc(20)
  buf[0] = 0x01
  buf[1] = group & 0xff
  return buf
}

/**
 * PGN 65283 carries six switch states packed 2 bits per switch:
 *   byte[0]    = dipswitch group
 *   byte[1]    = switches[offset+0..2]  (bits 0-1, 2-3, 4-5)
 *   byte[2]    = switches[offset+3..5]  (bits 0-1, 2-3, 4-5)
 *   byte[5]    = 0x10 (presence flag observed on real hardware)
 */
export function packDipswitchState (
  group: number,
  indicators: boolean[],
  offset: number
): Buffer {
  const buf = Buffer.alloc(6)
  buf[0] = group & 0xff
  let b1 = 0
  let b2 = 0
  for (let i = 0; i < 3; i++) {
    if (indicators[offset + i]) b1 |= 1 << (i * 2)
    if (indicators[offset + 3 + i]) b2 |= 1 << (i * 2)
  }
  buf[1] = b1
  buf[2] = b2
  buf[5] = 0x10
  return buf
}

/**
 * PGN 65284 capability bitmap: which of up to 32 circuits are configured.
 */
export function packCapabilityBitmap (
  group: number,
  capability: number,
  configured: boolean[]
): Buffer {
  const buf = Buffer.alloc(6)
  buf[0] = group & 0xff
  buf[1] = capability & 0xff
  for (let i = 0; i < 32; i++) {
    if (configured[i]) {
      buf[2 + (i >> 3)] |= 1 << (i & 7)
    }
  }
  return buf
}

/**
 * Derive a stable 20-bit unique serial from a string (vessel uuid, mmsi etc).
 */
export function deriveUniqueSerial (seed: string | undefined): number {
  const s = String(seed ?? 'signalk')
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0
  }
  return h & 0xfffff
}
