import { gunzipSync } from 'node:zlib'

function encodeVarint(value: number): Buffer {
  const chunks: number[] = []
  let v = value
  while (v > 0x7f) {
    chunks.push((v & 0x7f) | 0x80)
    v >>>= 7
  }
  chunks.push(v)
  return Buffer.from(chunks)
}

function encodeStringField(tag: number, value: string): Buffer {
  const key = (tag << 3) | 2
  const utf8 = Buffer.from(value, 'utf8')
  return Buffer.concat([encodeVarint(key), encodeVarint(utf8.length), utf8])
}

export interface DevinProtoMetadata {
  apiKey: string
  userJwt?: string
}

export function encodeGetCliModelConfigsRequest(metadata: DevinProtoMetadata): Buffer {
  const metadataBuf = Buffer.concat([
    encodeStringField(1, 'windsurf'),
    encodeStringField(2, '1.48.2'),
    encodeStringField(3, metadata.apiKey),
    encodeStringField(4, 'en'),
    encodeStringField(7, '3.2.23'),
    encodeStringField(12, 'windsurf'),
    encodeStringField(21, metadata.userJwt ?? ''),
  ])
  // GetCliModelConfigsRequest field 1 (metadata) is a length-delimited message
  const key = (1 << 3) | 2
  return Buffer.concat([encodeVarint(key), encodeVarint(metadataBuf.length), metadataBuf])
}

function decodeVarint(buf: Buffer, offset: number): { value: number; next: number } | undefined {
  let result = 0
  let shift = 0
  let pos = offset
  while (pos < buf.length) {
    const b = buf[pos]!
    result |= (b & 0x7f) << shift
    pos += 1
    if ((b & 0x80) === 0) {
      return { value: result >>> 0, next: pos }
    }
    shift += 7
    if (shift > 35) return undefined
  }
  return undefined
}

export interface DevinModelConfig {
  label: string
  modelUid: string
  disabled: boolean
  supportsImages: boolean
  maxTokens: number
}

function parseString(buf: Buffer, offset: number): { value: string; next: number } | undefined {
  const len = decodeVarint(buf, offset)
  if (!len) return undefined
  const end = len.next + len.value
  if (end > buf.length) return undefined
  return { value: buf.slice(len.next, end).toString('utf8'), next: end }
}

function parseClientModelConfig(buf: Buffer): DevinModelConfig {
  const result: DevinModelConfig = {
    label: '',
    modelUid: '',
    disabled: false,
    supportsImages: false,
    maxTokens: 0,
  }
  let offset = 0
  while (offset < buf.length) {
    const key = decodeVarint(buf, offset)
    if (!key) break
    offset = key.next
    const wireType = key.value & 7
    const fieldNumber = key.value >>> 3
    if (wireType === 0) {
      const v = decodeVarint(buf, offset)
      if (!v) break
      offset = v.next
      if (fieldNumber === 4) result.disabled = v.value !== 0
      else if (fieldNumber === 5) result.supportsImages = v.value !== 0
      else if (fieldNumber === 18) result.maxTokens = v.value
    } else if (wireType === 2) {
      const s = parseString(buf, offset)
      if (!s) break
      offset = s.next
      if (fieldNumber === 1) result.label = s.value
      else if (fieldNumber === 22) result.modelUid = s.value
      // field 23 model_info is a nested message; skip it
    } else {
      break
    }
  }
  return result
}

export function decodeGetCliModelConfigsResponse(buf: Buffer): DevinModelConfig[] {
  let offset = 0
  const models: DevinModelConfig[] = []
  while (offset < buf.length) {
    const key = decodeVarint(buf, offset)
    if (!key) break
    offset = key.next
    const wireType = key.value & 7
    const fieldNumber = key.value >>> 3
    if (wireType === 2 && fieldNumber === 1) {
      const len = decodeVarint(buf, offset)
      if (!len) break
      const end = len.next + len.value
      if (end > buf.length) break
      models.push(parseClientModelConfig(buf.slice(len.next, end)))
      offset = end
    } else if (wireType === 2) {
      const len = decodeVarint(buf, offset)
      if (!len) break
      offset = len.next + len.value
    } else if (wireType === 0) {
      const v = decodeVarint(buf, offset)
      if (!v) break
      offset = v.next
    } else {
      break
    }
  }
  return models
}

export function maybeGunzip(buf: Buffer): Buffer {
  if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    return gunzipSync(buf)
  }
  return buf
}
