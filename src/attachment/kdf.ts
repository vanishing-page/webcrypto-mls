import type { Kdf } from '../crypto/kdf.js'
import { AttachmentError } from './error.js'

const encoder = new TextEncoder()

// Salt for LH(), the large-field hash used by frame() and by
// snapshot leaves. draft-sullivan-cfrg-raae-02 section 4.3:
// LH(x) = Extract("raAE-LP-v1", x).
const LP_SALT = encoder.encode('raAE-LP-v1')

export function ascii (s:string):Uint8Array {
    return encoder.encode(s)
}

export function uint16be (n:number):Uint8Array {
    const out = new Uint8Array(2)
    new DataView(out.buffer).setUint16(0, n)
    return out
}

export function uint32be (n:number):Uint8Array {
    const out = new Uint8Array(4)
    new DataView(out.buffer).setUint32(0, n)
    return out
}

export function uint64be (n:bigint):Uint8Array {
    if (n < 0n || n > 0xFFFFFFFFFFFFFFFFn) {
        throw new AttachmentError()
    }
    const out = new Uint8Array(8)
    new DataView(out.buffer).setBigUint64(0, n)
    return out
}

export function concatAll (parts:Uint8Array[]):Uint8Array {
    const len = parts.reduce((n, p) => n + p.length, 0)
    const out = new Uint8Array(len)
    let offset = 0
    for (const p of parts) {
        out.set(p, offset)
        offset += p.length
    }
    return out
}

/**
 * Pad salt to hash block size for @hpke/core compatibility.
 * Salt must not exceed hash size; zero padding to hash size is inert
 * because HMAC zero-pads keys to block size. The protocol_id in extract()
 * doubles as salt and must not exceed hash size (typically 32+ bytes), so
 * a protocol_id longer than 32 bytes triggers a validation error.
 */
function paddedSalt (kdf:Kdf, salt:Uint8Array):Uint8Array {
    if (salt.length > kdf.size) {
        throw new AttachmentError()
    }
    const out = new Uint8Array(kdf.size)
    out.set(salt)
    return out
}

export async function lh (x:Uint8Array, kdf:Kdf):Promise<Uint8Array> {
    return kdf.extract(paddedSalt(kdf, LP_SALT), x)
}

/**
 * frame(x): length-prefixed field. Fields longer than 0xFFFE are
 * replaced by 0xFFFF || LH(x). raae-02 section 4.3.
 */
export async function frame (
    x:Uint8Array,
    kdf:Kdf,
):Promise<Uint8Array> {
    if (x.length <= 0xFFFE) {
        return concatAll([uint16be(x.length), x])
    }
    return concatAll([uint16be(0xFFFF), await lh(x, kdf)])
}

/**
 * encode(x1, ..., xn) = frame(x1) || ... || frame(xn).
 * Strings are framed as their ASCII bytes.
 */
export async function encode (
    kdf:Kdf,
    ...parts:(Uint8Array|string)[]
):Promise<Uint8Array> {
    const framed:Uint8Array[] = []
    for (const p of parts) {
        const bytes = typeof p === 'string' ? ascii(p) : p
        framed.push(await frame(bytes, kdf))
    }
    return concatAll(framed)
}

/**
 * The SEAL KDF. raae-02 section 4.3 (two-step HKDF form):
 *   extract_input = encode(protocol_id, label, ...ikm)
 *   prk = Extract(salt = protocol_id, ikm = extract_input)
 *   expand_info = encode(protocol_id, label, ...info, uint16(L))
 *   out = Expand(prk, expand_info, L)
 */
export async function sealKdf (
    kdf:Kdf,
    protocolId:string,
    label:string,
    ikm:Uint8Array[],
    info:Uint8Array[],
    length:number,
):Promise<Uint8Array> {
    const extractInput = await encode(kdf, protocolId, label, ...ikm)
    const salt = ascii(protocolId)
    const prk = await kdf.extract(paddedSalt(kdf, salt), extractInput)
    const expandInfo = await encode(
        kdf, protocolId, label, ...info, uint16be(length),
    )
    return kdf.expand(prk, expandInfo, length)
}

export function constantTimeEqual (
    a:Uint8Array,
    b:Uint8Array,
):boolean {
    if (a.length !== b.length) return false
    let diff = 0
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
    return diff === 0
}
