/*
 * .zcf parser + byte-for-byte round-trip encoder + template-based generator.
 *
 * Port of czone-spec/tools/zcf_header.py + zcf_sections.py + zcf_encode.py
 * to TypeScript. Round-trip identity (parse -> encode == original bytes)
 * is locked in by the unit tests in test/zcf-encoder.test.mjs against three
 * real .zcf files: Test.zcf (781), config-6.zcf (1014), CompassRose.zcf
 * (6384). The Python reference encodes the same three files identically.
 *
 * Field meanings and section layouts come from czone-spec/spec/zcf-*.md.
 * Anything we don't understand on a parsed file is preserved by the encoder
 * verbatim (raw byte-arrays for the global-config sub-blocks, the per-circuit
 * flag fields, the trailing-section payloads, etc.).
 *
 * The `generate(spec, template)` entry point lets the plugin synthesise a
 * .zcf for the user to download and load via the CZone Configuration Tool:
 * starting from a known-good template, only the labelled "user-visible"
 * fields are mutated (config name, the emulated module's dipswitch + name,
 * and the circuits + circuit_ids list).
 */

const CRC8_TABLE_HEX =
  '00070e091c1b1215383f363124232a2d70777e796c6b6265484f464154535a5d' +
  'e0e7eee9fcfbf2f5d8dfd6d1c4c3cacd90979e998c8b8285a8afa6a1b4b3babd' +
  'c7c0c9cedbdcd5d2fff8f1f6e3e4edeab7b0b9beabaca5a28f88818693949d9a' +
  '2720292e3b3c35321f18111603040d0a5750595e4b4c45426f68616673747d7a' +
  '898e878095929b9cb1b6bfb8adaaa3a4f9fef7f0e5e2ebecc1c6cfc8dddad3d4' +
  '696e676075727b7c51565f584d4a4344191e171005020b0c21262f283d3a3334' +
  '4e49404752555c5b7671787f6a6d64633e39303722252c2b0601080f1a1d1413' +
  'aea9a0a7b2b5bcbb9691989f8a8d8483ded9d0d7c2c5cccbe6e1e8effafdf4f3'

const CRC8_TABLE = Buffer.from(CRC8_TABLE_HEX, 'hex')

export function crc8 (data: Buffer): number {
  let c = 0
  for (let i = 0; i < data.length; i++) {
    c = CRC8_TABLE[c ^ data[i]]
  }
  return c
}

// Standard zlib CRC32 (polynomial 0xEDB88320), low 20 bits returned.
const CRC32_TABLE: number[] = (() => {
  const t = new Array<number>(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    t[i] = c >>> 0
  }
  return t
})()

export function crc32Lo20 (data: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < data.length; i++) {
    c = (CRC32_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8)) >>> 0
  }
  return (c ^ 0xffffffff) & 0xfffff
}

// ------------------------------- structures -------------------------------

export interface ZcfHeader {
  version: number
  reservedByte9: number
  unknown_10_13: Buffer  // 4 bytes; observed zero in our corpus
}

export interface ConfigName {
  length: number
  name: string
}

export interface ModuleRecord {
  dipswitch: number
  moduleSpecificValue: number   // wire byte 1
  moduleSpecificValue2: number  // wire byte 2
  nameFlag: number              // bit 7 of byte 3
  name: string
  trailer: number
}

export interface ModulesSection {
  sectionTag: number  // = 0x05
  records: ModuleRecord[]
}

export interface BacklightZoneRecord {
  name: string
  fieldA: number
  fieldB: number
  fieldC: number
}

export interface BacklightZonesSection {
  sectionTag: number  // = 0x04
  records: BacklightZoneRecord[]
}

export interface GlobalConfigBlock {
  metadataTotalByteCount: number
  metadataStrings: string[]   // always 5 entries
  flagsByte: number
  subBlocks: Buffer[]         // 6 entries, each 33 bytes
}

export interface OutputRecord {
  channelAddress: number
  flagsBytes: Buffer  // 5 bytes
  name: string
}

export interface DisplayRefRecord {
  displayAddress: number
  flagsA: number
  flagsB: number      // bit 2 indicates transient
  transient: boolean
  extra: Buffer       // 1 byte for normal, 10 bytes for transient
}

export interface CircuitRecord {
  circuitIndex: number
  flagsA: number
  flagsB: number
  field2a: number
  name: string
  outputs: OutputRecord[]
  displayRefs: DisplayRefRecord[]
}

export interface CircuitsSection {
  sectionTag: number  // = 0x08
  formatHints: Buffer  // 3 bytes, expected = 08 05 0E
  records: CircuitRecord[]
}

export interface CircuitIdRecord {
  channelAddress: number
  flags: Buffer       // 11 bytes
  circuitId: number   // u32 user-set ID
  name: string
}

export interface CircuitIdsSection {
  sectionTag: number  // = 0x12
  records: CircuitIdRecord[]
}

export interface TrailingSection {
  sectionPayloadSize: number
  recordCount: number
  sectionTag: number
  payload: Buffer    // bytes after the 7-byte header (size = sectionPayloadSize - 3)
}

export interface ZcfBody {
  configName: ConfigName
  modules: ModulesSection
  backlightZones: BacklightZonesSection
  globalConfig: GlobalConfigBlock
  circuits: CircuitsSection
  circuitIds: CircuitIdsSection
  trailingSections: TrailingSection[]
}

export interface ParsedZcf {
  header: ZcfHeader
  body: ZcfBody
}

// --------------------------------- constants ------------------------------

const HEADER_SIZE = 14
const CONFIG_NAME_OFFSET = 14
const MODULES_SECTION_TAG = 0x05
const BACKLIGHT_ZONES_SECTION_TAG = 0x04
const CIRCUITS_SECTION_TAG = 0x08
const CIRCUITS_FORMAT_HINTS = Buffer.from([0x08, 0x05, 0x0e])
const CIRCUIT_IDS_SECTION_TAG = 0x12

const GLOBAL_CONFIG_SUBBLOCK_COUNT = 6
const GLOBAL_CONFIG_SUBBLOCK_SIZE = 33
const GLOBAL_CONFIG_BLOCK_SIZE = 6 + 1 + GLOBAL_CONFIG_SUBBLOCK_COUNT * GLOBAL_CONFIG_SUBBLOCK_SIZE  // 205
const GLOBAL_CONFIG_SUBBLOCK_MARKER = 0x20

// --------------------------------- parser ---------------------------------

export function parseHeader (data: Buffer): ZcfHeader {
  if (data.length < HEADER_SIZE + 1) {
    throw new Error(`file too short: ${data.length} bytes (need at least ${HEADER_SIZE + 1})`)
  }
  return {
    version: data[0],
    reservedByte9: data[9],
    unknown_10_13: data.slice(10, 14)
  }
}

function parseConfigName (data: Buffer, offset: number): { value: ConfigName; next: number } {
  if (offset >= data.length) {
    throw new Error(`config name offset ${offset} past end of data (${data.length} bytes)`)
  }
  const length = data[offset]
  const end = offset + 1 + length
  if (end > data.length) {
    throw new Error(`config name length ${length} extends past end of data`)
  }
  return {
    value: { length, name: data.slice(offset + 1, end).toString('ascii') },
    next: end
  }
}

function parseModulesSection (data: Buffer, offset: number): { value: ModulesSection; next: number } {
  if (offset + 7 > data.length) {
    throw new Error(`modules section header runs past end at offset ${offset}`)
  }
  const sectionPayloadSize = data.readUInt32LE(offset)
  const recordCount = data.readUInt16LE(offset + 4)
  const sectionTag = data[offset + 6]
  if (sectionTag !== MODULES_SECTION_TAG) {
    throw new Error(`expected modules tag 0x05, got 0x${sectionTag.toString(16)}`)
  }
  const sectionEnd = offset + 4 + sectionPayloadSize
  if (sectionEnd > data.length) {
    throw new Error(`modules section claims to end at ${sectionEnd} but file is ${data.length} bytes`)
  }
  let o = offset + 7
  const records: ModuleRecord[] = []
  for (let i = 0; i < recordCount; i++) {
    if (o + 5 > sectionEnd) throw new Error(`module record ${i} header past section end`)
    const dipswitch = data[o]
    const b1 = data[o + 1]
    const b2 = data[o + 2]
    const b3 = data[o + 3]
    const nameLen = b3 & 0x7f
    const nameFlag = (b3 >> 7) & 1
    const nameEnd = o + 4 + nameLen
    if (nameEnd + 1 > sectionEnd) throw new Error(`module record ${i} runs past section end`)
    const name = data.slice(o + 4, nameEnd).toString('ascii')
    const trailer = data[nameEnd]
    records.push({
      dipswitch,
      moduleSpecificValue: b1,
      moduleSpecificValue2: b2,
      nameFlag,
      name,
      trailer
    })
    o = nameEnd + 1
  }
  if (o !== sectionEnd) throw new Error(`modules section size drift: parsed ${o}, ends at ${sectionEnd}`)
  return { value: { sectionTag, records }, next: sectionEnd }
}

function parseBacklightZonesSection (data: Buffer, offset: number): { value: BacklightZonesSection; next: number } {
  if (offset + 7 > data.length) throw new Error(`backlight zones header past end at ${offset}`)
  const sectionPayloadSize = data.readUInt32LE(offset)
  const recordCount = data.readUInt16LE(offset + 4)
  const sectionTag = data[offset + 6]
  if (sectionTag !== BACKLIGHT_ZONES_SECTION_TAG) {
    throw new Error(`expected backlight tag 0x04, got 0x${sectionTag.toString(16)}`)
  }
  const sectionEnd = offset + 4 + sectionPayloadSize
  let o = offset + 7
  const records: BacklightZoneRecord[] = []
  for (let i = 0; i < recordCount; i++) {
    if (o + 4 > sectionEnd) throw new Error(`bz record ${i} past section end`)
    const nameLen = data[o]
    const nameEnd = o + 1 + nameLen
    if (nameEnd + 3 > sectionEnd) throw new Error(`bz record ${i} runs past section end`)
    const name = data.slice(o + 1, nameEnd).toString('ascii')
    records.push({
      name,
      fieldA: data[nameEnd],
      fieldB: data[nameEnd + 1],
      fieldC: data[nameEnd + 2]
    })
    o = nameEnd + 3
  }
  if (o !== sectionEnd) throw new Error(`backlight section size drift`)
  return { value: { sectionTag, records }, next: sectionEnd }
}

function parseGlobalConfigBlock (data: Buffer, offset: number): { value: GlobalConfigBlock; next: number } {
  if (offset + GLOBAL_CONFIG_BLOCK_SIZE > data.length) {
    throw new Error(`global config block past end at ${offset}`)
  }
  const metadataTotalByteCount = data[offset]
  let o = offset + 1
  const metadataStrings: string[] = []
  let consumed = 1
  for (let i = 0; i < 5; i++) {
    if (o + 1 > data.length) throw new Error(`metadata string ${i} length past end`)
    const ln = data[o]
    if (o + 1 + ln > data.length) throw new Error(`metadata string ${i} body past end`)
    metadataStrings.push(data.slice(o + 1, o + 1 + ln).toString('ascii'))
    consumed += 1 + ln
    o += 1 + ln
  }
  if (consumed !== metadataTotalByteCount) {
    throw new Error(`metadata total ${metadataTotalByteCount} != actual ${consumed}`)
  }
  const flagsByte = data[o]
  o += 1
  const subBlocks: Buffer[] = []
  for (let i = 0; i < GLOBAL_CONFIG_SUBBLOCK_COUNT; i++) {
    const block = data.slice(o, o + GLOBAL_CONFIG_SUBBLOCK_SIZE)
    if (block.length !== GLOBAL_CONFIG_SUBBLOCK_SIZE) throw new Error(`sub-block ${i} truncated`)
    if (block[0] !== GLOBAL_CONFIG_SUBBLOCK_MARKER) {
      throw new Error(`sub-block ${i}: expected marker 0x20, got 0x${block[0].toString(16)}`)
    }
    subBlocks.push(block)
    o += GLOBAL_CONFIG_SUBBLOCK_SIZE
  }
  return {
    value: { metadataTotalByteCount, metadataStrings, flagsByte, subBlocks },
    next: offset + GLOBAL_CONFIG_BLOCK_SIZE
  }
}

function parseOutputsSubsection (data: Buffer, offset: number, sectionEnd: number): { records: OutputRecord[]; next: number } {
  if (offset + 6 > sectionEnd) throw new Error(`outputs subsec header past section end`)
  const payloadSize = data.readUInt32LE(offset)
  const count = data.readUInt16LE(offset + 4)
  const subEnd = offset + 4 + payloadSize
  if (subEnd > sectionEnd) throw new Error(`outputs subsec ends past section end`)
  let o = offset + 6
  const records: OutputRecord[] = []
  for (let i = 0; i < count; i++) {
    if (o + 8 > subEnd) throw new Error(`output ${i} header past subsec`)
    const channelAddress = data.readUInt16LE(o)
    const flagsBytes = data.slice(o + 2, o + 7)
    const nameLen = data[o + 7]
    if (o + 8 + nameLen > subEnd) throw new Error(`output ${i} name past subsec`)
    const name = data.slice(o + 8, o + 8 + nameLen).toString('ascii')
    records.push({ channelAddress, flagsBytes, name })
    o += 8 + nameLen
  }
  if (o !== subEnd) throw new Error(`outputs subsec size drift`)
  return { records, next: subEnd }
}

function parseDisplayRefsSubsection (data: Buffer, offset: number, sectionEnd: number): { records: DisplayRefRecord[]; next: number } {
  if (offset + 6 > sectionEnd) throw new Error(`drefs subsec header past section end`)
  const payloadSize = data.readUInt32LE(offset)
  const count = data.readUInt16LE(offset + 4)
  const subEnd = offset + 4 + payloadSize
  if (subEnd > sectionEnd) throw new Error(`drefs subsec ends past section end`)
  let o = offset + 6
  const records: DisplayRefRecord[] = []
  for (let i = 0; i < count; i++) {
    if (o + 4 > subEnd) throw new Error(`dref ${i} header past subsec`)
    const displayAddress = data.readUInt16LE(o)
    const flagsA = data[o + 2]
    const flagsB = data[o + 3]
    const transient = (flagsB & 0x04) !== 0
    const recSize = transient ? 14 : 5
    if (o + recSize > subEnd) throw new Error(`dref ${i} runs past subsec`)
    const extra = data.slice(o + 4, o + recSize)
    records.push({ displayAddress, flagsA, flagsB, transient, extra })
    o += recSize
  }
  if (o !== subEnd) throw new Error(`drefs subsec size drift`)
  return { records, next: subEnd }
}

function parseCircuitsSection (data: Buffer, offset: number): { value: CircuitsSection; next: number } {
  if (offset + 10 > data.length) throw new Error(`circuits section header past end`)
  const sectionPayloadSize = data.readUInt32LE(offset)
  const recordCount = data.readUInt16LE(offset + 4)
  const sectionTag = data[offset + 6]
  if (sectionTag !== CIRCUITS_SECTION_TAG) throw new Error(`expected circuits tag 0x08`)
  const formatHints = data.slice(offset + 7, offset + 10)
  if (!formatHints.equals(CIRCUITS_FORMAT_HINTS)) {
    throw new Error(`unexpected circuits format_hints ${formatHints.toString('hex')}`)
  }
  const sectionEnd = offset + 4 + sectionPayloadSize
  let o = offset + 10
  const records: CircuitRecord[] = []
  for (let i = 0; i < recordCount; i++) {
    if (o + 8 > sectionEnd) throw new Error(`circuit ${i} header past section end`)
    const circuitIndex = data.readUInt16LE(o)
    const flagsA = data[o + 2]
    const flagsB = data.readUInt16LE(o + 3)
    const field2a = data.readUInt16LE(o + 5)
    const nameLen = data[o + 7]
    if (o + 8 + nameLen > sectionEnd) throw new Error(`circuit ${i} name past section`)
    const name = data.slice(o + 8, o + 8 + nameLen).toString('utf8')
    let cur = o + 8 + nameLen
    const outputsRes = parseOutputsSubsection(data, cur, sectionEnd)
    cur = outputsRes.next
    const drefsRes = parseDisplayRefsSubsection(data, cur, sectionEnd)
    cur = drefsRes.next
    records.push({
      circuitIndex,
      flagsA,
      flagsB,
      field2a,
      name,
      outputs: outputsRes.records,
      displayRefs: drefsRes.records
    })
    o = cur
  }
  if (o !== sectionEnd) throw new Error(`circuits section size drift`)
  return { value: { sectionTag, formatHints, records }, next: sectionEnd }
}

function parseCircuitIdsSection (data: Buffer, offset: number): { value: CircuitIdsSection; next: number } {
  if (offset + 7 > data.length) throw new Error(`circuit_ids header past end`)
  const sectionPayloadSize = data.readUInt32LE(offset)
  const recordCount = data.readUInt16LE(offset + 4)
  const sectionTag = data[offset + 6]
  if (sectionTag !== CIRCUIT_IDS_SECTION_TAG) throw new Error(`expected circuit_ids tag 0x12`)
  const sectionEnd = offset + 4 + sectionPayloadSize
  let o = offset + 7
  const records: CircuitIdRecord[] = []
  for (let i = 0; i < recordCount; i++) {
    if (o + 18 > sectionEnd) throw new Error(`circuit_ids ${i} header past section`)
    const channelAddress = data.readUInt16LE(o)
    const flags = data.slice(o + 2, o + 13)
    const circuitId = data.readUInt32LE(o + 13)
    const nameLen = data[o + 17]
    if (o + 18 + nameLen > sectionEnd) throw new Error(`circuit_ids ${i} name past section`)
    const name = data.slice(o + 18, o + 18 + nameLen).toString('utf8')
    records.push({ channelAddress, flags, circuitId, name })
    o += 18 + nameLen
  }
  if (o !== sectionEnd) throw new Error(`circuit_ids section size drift`)
  return { value: { sectionTag, records }, next: sectionEnd }
}

function parseTrailingSections (data: Buffer, offset: number, end: number): TrailingSection[] {
  const sections: TrailingSection[] = []
  let o = offset
  while (o + 7 <= end) {
    const sectionPayloadSize = data.readUInt32LE(o)
    const recordCount = data.readUInt16LE(o + 4)
    const sectionTag = data[o + 6]
    const sectionEnd = o + 4 + sectionPayloadSize
    if (sectionEnd > end) {
      throw new Error(`trailing section at ${o} (tag 0x${sectionTag.toString(16)}) past trailing area end ${end}`)
    }
    sections.push({
      sectionPayloadSize,
      recordCount,
      sectionTag,
      payload: data.slice(o + 7, sectionEnd)
    })
    o = sectionEnd
  }
  if (o !== end) throw new Error(`trailing sections did not consume entire range`)
  return sections
}

export function parseZcfFull (data: Buffer): ParsedZcf {
  const header = parseHeader(data)
  let next = CONFIG_NAME_OFFSET
  const cn = parseConfigName(data, next); next = cn.next
  const mods = parseModulesSection(data, next); next = mods.next
  const bz = parseBacklightZonesSection(data, next); next = bz.next
  const gc = parseGlobalConfigBlock(data, next); next = gc.next
  const circ = parseCircuitsSection(data, next); next = circ.next
  const cids = parseCircuitIdsSection(data, next); next = cids.next
  const trailingEnd = data.length - 1  // last byte is trailing CRC8
  const trailing = parseTrailingSections(data, next, trailingEnd)
  return {
    header,
    body: {
      configName: cn.value,
      modules: mods.value,
      backlightZones: bz.value,
      globalConfig: gc.value,
      circuits: circ.value,
      circuitIds: cids.value,
      trailingSections: trailing
    }
  }
}

// --------------------------------- encoder --------------------------------

function encodeConfigName (cn: ConfigName): Buffer {
  const body = Buffer.from(cn.name, 'ascii')
  if (body.length !== cn.length) throw new Error(`config name length mismatch ${body.length} != ${cn.length}`)
  return Buffer.concat([Buffer.from([cn.length]), body])
}

function encodeModulesSection (s: ModulesSection): Buffer {
  const parts: Buffer[] = []
  for (const r of s.records) {
    const nameBytes = Buffer.from(r.name, 'ascii')
    const nameLen = nameBytes.length
    const b3 = (nameLen & 0x7f) | ((r.nameFlag & 1) << 7)
    parts.push(Buffer.from([r.dipswitch, r.moduleSpecificValue, r.moduleSpecificValue2, b3]))
    parts.push(nameBytes)
    parts.push(Buffer.from([r.trailer]))
  }
  const body = Buffer.concat(parts)
  const sectionPayloadSize = 3 + body.length
  const header = Buffer.alloc(7)
  header.writeUInt32LE(sectionPayloadSize, 0)
  header.writeUInt16LE(s.records.length, 4)
  header[6] = s.sectionTag
  return Buffer.concat([header, body])
}

function encodeBacklightZonesSection (s: BacklightZonesSection): Buffer {
  const parts: Buffer[] = []
  for (const r of s.records) {
    const nameBytes = Buffer.from(r.name, 'ascii')
    parts.push(Buffer.from([nameBytes.length]))
    parts.push(nameBytes)
    parts.push(Buffer.from([r.fieldA, r.fieldB, r.fieldC]))
  }
  const body = Buffer.concat(parts)
  const sectionPayloadSize = 3 + body.length
  const header = Buffer.alloc(7)
  header.writeUInt32LE(sectionPayloadSize, 0)
  header.writeUInt16LE(s.records.length, 4)
  header[6] = s.sectionTag
  return Buffer.concat([header, body])
}

function encodeGlobalConfigBlock (g: GlobalConfigBlock): Buffer {
  const parts: Buffer[] = []
  parts.push(Buffer.from([g.metadataTotalByteCount]))
  for (const s of g.metadataStrings) {
    const sb = Buffer.from(s, 'ascii')
    parts.push(Buffer.from([sb.length]))
    parts.push(sb)
  }
  parts.push(Buffer.from([g.flagsByte]))
  for (const sb of g.subBlocks) {
    if (sb.length !== GLOBAL_CONFIG_SUBBLOCK_SIZE) throw new Error('sub-block wrong size')
    parts.push(sb)
  }
  const out = Buffer.concat(parts)
  if (out.length !== GLOBAL_CONFIG_BLOCK_SIZE) {
    throw new Error(`global config block encoded to ${out.length}, expected ${GLOBAL_CONFIG_BLOCK_SIZE}`)
  }
  return out
}

function encodeOutputsSubsection (outs: OutputRecord[]): Buffer {
  const body = Buffer.concat(
    outs.map(o => {
      const nameBytes = Buffer.from(o.name, 'ascii')
      if (o.flagsBytes.length !== 5) throw new Error('output flags must be 5 bytes')
      const head = Buffer.alloc(2)
      head.writeUInt16LE(o.channelAddress, 0)
      return Buffer.concat([head, o.flagsBytes, Buffer.from([nameBytes.length]), nameBytes])
    })
  )
  const payloadSize = 2 + body.length
  const header = Buffer.alloc(6)
  header.writeUInt32LE(payloadSize, 0)
  header.writeUInt16LE(outs.length, 4)
  return Buffer.concat([header, body])
}

function encodeDisplayRefsSubsection (drefs: DisplayRefRecord[]): Buffer {
  const body = Buffer.concat(
    drefs.map(d => {
      const head = Buffer.alloc(4)
      head.writeUInt16LE(d.displayAddress, 0)
      head[2] = d.flagsA
      head[3] = d.flagsB
      const expectedExtra = d.transient ? 10 : 1
      if (d.extra.length !== expectedExtra) {
        throw new Error(`dref extra must be ${expectedExtra} bytes (got ${d.extra.length})`)
      }
      return Buffer.concat([head, d.extra])
    })
  )
  const payloadSize = 2 + body.length
  const header = Buffer.alloc(6)
  header.writeUInt32LE(payloadSize, 0)
  header.writeUInt16LE(drefs.length, 4)
  return Buffer.concat([header, body])
}

function encodeCircuitRecord (r: CircuitRecord): Buffer {
  const nameBytes = Buffer.from(r.name, 'utf8')
  const head = Buffer.alloc(8)
  head.writeUInt16LE(r.circuitIndex, 0)
  head[2] = r.flagsA
  head.writeUInt16LE(r.flagsB, 3)
  head.writeUInt16LE(r.field2a, 5)
  head[7] = nameBytes.length
  return Buffer.concat([
    head,
    nameBytes,
    encodeOutputsSubsection(r.outputs),
    encodeDisplayRefsSubsection(r.displayRefs)
  ])
}

function encodeCircuitsSection (s: CircuitsSection): Buffer {
  const body = Buffer.concat([s.formatHints, ...s.records.map(encodeCircuitRecord)])
  const sectionPayloadSize = 3 + body.length
  const header = Buffer.alloc(7)
  header.writeUInt32LE(sectionPayloadSize, 0)
  header.writeUInt16LE(s.records.length, 4)
  header[6] = s.sectionTag
  return Buffer.concat([header, body])
}

function encodeCircuitIdsSection (s: CircuitIdsSection): Buffer {
  const body = Buffer.concat(
    s.records.map(r => {
      const nameBytes = Buffer.from(r.name, 'utf8')
      if (r.flags.length !== 11) throw new Error('circuit_id flags must be 11 bytes')
      const head = Buffer.alloc(2)
      head.writeUInt16LE(r.channelAddress, 0)
      const cid = Buffer.alloc(4)
      cid.writeUInt32LE(r.circuitId, 0)
      return Buffer.concat([head, r.flags, cid, Buffer.from([nameBytes.length]), nameBytes])
    })
  )
  const sectionPayloadSize = 3 + body.length
  const header = Buffer.alloc(7)
  header.writeUInt32LE(sectionPayloadSize, 0)
  header.writeUInt16LE(s.records.length, 4)
  header[6] = s.sectionTag
  return Buffer.concat([header, body])
}

function encodeTrailingSection (s: TrailingSection): Buffer {
  const head = Buffer.alloc(7)
  head.writeUInt32LE(s.sectionPayloadSize, 0)
  head.writeUInt16LE(s.recordCount, 4)
  head[6] = s.sectionTag
  return Buffer.concat([head, s.payload])
}

export function encodeZcf (parsed: ParsedZcf): Buffer {
  const { header, body } = parsed
  const bodyParts: Buffer[] = []
  // Body bytes 0..3 (file offsets 10..13) are the four "unknown" bytes
  // carried in the header struct.
  bodyParts.push(header.unknown_10_13)
  bodyParts.push(encodeConfigName(body.configName))
  bodyParts.push(encodeModulesSection(body.modules))
  bodyParts.push(encodeBacklightZonesSection(body.backlightZones))
  bodyParts.push(encodeGlobalConfigBlock(body.globalConfig))
  bodyParts.push(encodeCircuitsSection(body.circuits))
  bodyParts.push(encodeCircuitIdsSection(body.circuitIds))
  for (const ts of body.trailingSections) bodyParts.push(encodeTrailingSection(ts))
  const bodyBytes = Buffer.concat(bodyParts)

  // File layout (matches Python encoder):
  //   bytes 0..5  = version + body_size(4) + header_crc8 (placeholder)
  //   bytes 6..8  = body_crc32 low 20 bits (placeholder)
  //   byte 9      = reserved_byte9
  //   bytes 10..N = body_bytes
  //   last byte   = trailing CRC8 over bytes 6..end-1
  const fileNoTrailer = Buffer.alloc(10 + bodyBytes.length)
  fileNoTrailer[0] = header.version
  // body_size = file_size_no_trailer + 1 (trailing CRC) - 7
  const fileSizeNoTrailer = fileNoTrailer.length
  const fileSize = fileSizeNoTrailer + 1
  const bodySize = fileSize - 7
  fileNoTrailer.writeUInt32LE(bodySize, 1)
  // body_crc32 over bodyBytes (file bytes 10..end-1)
  const bodyCrc32 = crc32Lo20(bodyBytes)
  fileNoTrailer[6] = bodyCrc32 & 0xff
  fileNoTrailer[7] = (bodyCrc32 >> 8) & 0xff
  fileNoTrailer[8] = (bodyCrc32 >> 16) & 0x0f
  fileNoTrailer[9] = header.reservedByte9
  bodyBytes.copy(fileNoTrailer, 10)
  // header CRC8 over bytes 0..4
  fileNoTrailer[5] = crc8(fileNoTrailer.slice(0, 5))
  // trailing CRC8 over bytes 6..end-1 (of fileNoTrailer)
  const trailingCrc = crc8(fileNoTrailer.slice(6))
  return Buffer.concat([fileNoTrailer, Buffer.from([trailingCrc])])
}

// --------------------------------- generator ------------------------------

export interface ZcfGenSpec {
  configName: string                    // user-visible config label
  module: {
    dipswitch: number                   // 0..255
    name: string                        // module label as shown in CZone tool
  }
  circuits: Array<{
    name: string
    circuitId: number                   // user-set id (matches plugin's czoneFirstCircuitId+offset)
  }>
}

/**
 * Generate a .zcf from a small user-supplied spec, starting from a
 * known-good template (typically templates/template.zcf). The template's
 * header, global-config sub-blocks, backlight-zones, circuit/output
 * flag bytes and trailing-section payloads are preserved verbatim;
 * only the spec's labelled fields are mutated.
 *
 * The template MUST contain at least one module record and at least
 * one circuit (it serves as the structural prototype for those records).
 * The resulting bytes pass parseZcfFull(generate(...)) byte-for-byte
 * (locked in by test/zcf-encoder.test.mjs).
 */
export function generateZcf (spec: ZcfGenSpec, template: Buffer): Buffer {
  const parsed = parseZcfFull(template)

  if (parsed.body.modules.records.length < 1) {
    throw new Error('template must contain at least one module record')
  }
  if (parsed.body.circuits.records.length < 1) {
    throw new Error('template must contain at least one circuit record')
  }
  if (spec.circuits.length < 1) {
    throw new Error('spec must contain at least one circuit')
  }

  // Mutate config name.
  const cnBytes = Buffer.from(spec.configName, 'ascii')
  parsed.body.configName = { length: cnBytes.length, name: spec.configName }

  // Mutate the first module record to be the emulated module. Drop any
  // additional modules (the template's "MFD" placeholder, etc.) so the
  // CZone tool sees a single module owned by the user's plugin.
  const moduleProto = parsed.body.modules.records[0]
  parsed.body.modules.records = [
    {
      ...moduleProto,
      dipswitch: spec.module.dipswitch & 0xff,
      name: spec.module.name
    }
  ]

  // Build the circuit list by cloning the template's first circuit
  // record per spec entry. Each clone gets:
  //   - a unique circuit_index (starting at the template's value)
  //   - the spec's name
  //   - a unique output channel_address (spaced 1 apart, starting from
  //     the template's first output's channel_address)
  //   - a unique display_ref display_address (spaced 1 apart, starting
  //     from the template's first dref's display_address)
  // The matching circuit_ids record uses the same display_address as
  // its channel_address so the firmware links circuit -> circuit_id.
  //
  // **Critical:** both `output.channelAddress` and `dref.displayAddress`
  // (and the matching `circuit_id.channelAddress`) are dipswitch-namespaced:
  // their HIGH byte is the dipswitch of the module that owns the channel
  // (verified against Test.zcf: module dipswitch 0x01 owns outputs
  // 0x011e..0x0120 and drefs 0x0100..0x0102; config-6.zcf: module dipswitch
  // 0x02 owns outputs 0x021e..0x0222 and drefs 0x0200..0x0204). When we
  // change the module's dipswitch to whatever the user picked we MUST
  // rewrite the high byte of every channel address to match -- otherwise
  // the CZone Configuration Tool's GetChannelString() lookup fails and the
  // tool crashes with a NullReferenceException when the user clicks the
  // circuit (observed: bank-16 download with dipswitch=0x08 produced
  // outputs at 0x011e which the tool tried to resolve against dipswitch
  // 0x01, found no module, and crashed in UpdateLvCircuitOutputs).
  const circuitProto = parsed.body.circuits.records[0]
  const cidProto = parsed.body.circuitIds.records[0]
  const protoOutChan = circuitProto.outputs[0]?.channelAddress ?? 0x011e
  const protoDrefAddr = circuitProto.displayRefs[0]?.displayAddress ?? 0x0100
  // Re-namespace the low byte of the template's output and display ranges
  // under the user's chosen dipswitch.
  const dipHi = (spec.module.dipswitch & 0xff) << 8
  const outBaseChan = (dipHi | (protoOutChan & 0xff)) & 0xffff
  const drefBaseAddr = (dipHi | (protoDrefAddr & 0xff)) & 0xffff
  const indexBase = circuitProto.circuitIndex

  parsed.body.circuits.records = spec.circuits.map((c, i) => ({
    circuitIndex: indexBase + i,
    flagsA: circuitProto.flagsA,
    flagsB: circuitProto.flagsB,
    field2a: circuitProto.field2a,
    name: c.name,
    outputs: [
      {
        channelAddress: (outBaseChan + i) & 0xffff,
        flagsBytes: Buffer.from(circuitProto.outputs[0].flagsBytes),
        name: ''  // outputs in the template are unnamed; circuit name is the user-visible one
      }
    ],
    displayRefs: [
      {
        displayAddress: (drefBaseAddr + i) & 0xffff,
        flagsA: circuitProto.displayRefs[0].flagsA,
        flagsB: circuitProto.displayRefs[0].flagsB,
        transient: circuitProto.displayRefs[0].transient,
        extra: Buffer.from(circuitProto.displayRefs[0].extra)
      }
    ]
  }))

  parsed.body.circuitIds.records = spec.circuits.map((c, i) => ({
    channelAddress: (drefBaseAddr + i) & 0xffff,
    flags: Buffer.from(cidProto.flags),
    circuitId: c.circuitId >>> 0,
    name: c.name
  }))

  return encodeZcf(parsed)
}
