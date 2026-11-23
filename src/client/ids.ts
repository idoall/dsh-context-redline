/**
 * Browser-side id minting.
 *
 * The plugin mints operation ids in the Client half (an anchored-conversation
 * confirm carries one so a retried click cannot start twice). `crypto.randomUUID`
 * is the obvious primitive, but the Web Crypto spec gates it on a SECURE
 * CONTEXT: on a plain `http://<host>:<port>` deployment — the default for a
 * LAN-address DSH web session — the property is `undefined`, so calling it
 * throws `crypto.randomUUID is not a function` the moment a component that
 * mints the id renders (the 上下文批改 tab owns such a component at all times,
 * open dialog or not).
 *
 * `crypto.getRandomValues` carries no such gate; the UUID v4 shape is built
 * from it here. The `Math.random` arm is the last resort for an environment
 * without WebCrypto at all — these ids only need to be unique within one
 * browser page, never a security boundary.
 */

/** The pieces of `Crypto` this module actually depends on, re-proved at call time. */
interface WebCryptoLike {
  randomUUID?: () => string
  getRandomValues?: (array: Uint8Array) => Uint8Array
}

/** A UUID v4 string that works with or without a secure context. */
export function randomUuid(): string {
  const webCrypto = (globalThis as { crypto?: WebCryptoLike }).crypto
  if (webCrypto !== undefined && typeof webCrypto.randomUUID === 'function') return webCrypto.randomUUID()

  const bytes = new Uint8Array(16)
  if (webCrypto !== undefined && typeof webCrypto.getRandomValues === 'function') {
    webCrypto.getRandomValues(bytes)
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  }

  // RFC 4122 version 4: the high nibble of byte 6 names the version, the two
  // most significant bits of byte 8 name the variant.
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80

  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
