const OFFSET = 0x811c9dc5
const PRIME = 0x01000193

export function fnv1a32(input: string | Uint8Array): number {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input
  let hash = OFFSET
  for (const byte of bytes) hash = Math.imul((hash ^ byte) >>> 0, PRIME) >>> 0
  return hash
}

export function normalizeLine(value: string): string {
  return value.trim().replace(/\s+/gu, " ")
}

export function lineHash(value: string): number { return fnv1a32(normalizeLine(value)) }

export function encodeHash(hash: number, length: number): string {
  if (!Number.isInteger(length) || length < 1 || length > 4) throw new Error("hash length must be 1..4")
  let result = ""
  for (let i = 0; i < length; i++) result += String.fromCharCode(97 + ((hash >>> (i * 8)) % 26))
  return result
}
