import { sealObject } from '../../src/attachment/object.js'
import type { SealedObject } from '../../src/attachment/object.js'
import { sealCryptoFromIds } from '../../src/attachment/crypto.js'
import type { SealCrypto } from '../../src/attachment/crypto.js'
import { SEGMENT_MAX } from '../../src/attachment/schedule.js'
import type { AttachmentRef } from '../../src/attachment/reference.js'
import { buildRef } from './attachment-fixtures.js'

/**
 * The smallest object that puts a whole segment past the first epoch.
 * ATTACHMENT_EPOCH_LENGTH is 10, so an epoch holds 1024 segments and
 * segment 1024 is the first one whose key comes from epoch 1. At
 * SEGMENT_MAX = 65536 that is 1025 * 65536 = 67,174,400 octets of
 * plaintext, and there is no cheaper way to get there: segmentMax and
 * epochLength are constants of the SEAL-attachment profile, and
 * reader.ts and range.ts read them from those constants rather than
 * from a parameter, so a synthetic small-segment layout cannot reach
 * either path.
 *
 * The tradeoff this buys, measured on an M-series laptop under node:
 * sealing the fixture takes about 0.53s and it is built once and
 * shared by every test in this directory that needs a second epoch. A
 * whole-object read costs about 0.35s more per path. That is real time
 * added to a suite that otherwise runs in seconds, and it is the price
 * of covering segments at or past index 1024 with anything other than
 * an early rejection.
 */
export const MULTI_EPOCH_SEGMENTS = 1025
export const MULTI_EPOCH_LENGTH = SEGMENT_MAX * MULTI_EPOCH_SEGMENTS

export interface MultiEpochFixture {
    crypto:SealCrypto
    cek:Uint8Array
    objectId:Uint8Array
    plaintext:Uint8Array
    sealed:SealedObject
    ref:AttachmentRef
}

/**
 * Plaintext byte at `i`. The period is 251, a prime that does not
 * divide SEGMENT_MAX, so the pattern does not repeat on a segment
 * boundary and a segment emitted at the wrong offset shows up as a
 * mismatch rather than as more of the same bytes.
 */
export function patternByte (i:number):number {
    return i % 251
}

let cached:Promise<MultiEpochFixture>|null = null

async function build ():Promise<MultiEpochFixture> {
    const crypto = await sealCryptoFromIds(2, 1)
    const cek = new Uint8Array(32).fill(0x5c)
    const objectId = new TextEncoder().encode('multi-epoch')
    const plaintext = new Uint8Array(MULTI_EPOCH_LENGTH)
    for (let i = 0; i < plaintext.length; i++) {
        plaintext[i] = patternByte(i)
    }
    const sealed = await sealObject(cek, objectId, plaintext, crypto)
    const ref = buildRef(plaintext, objectId, sealed)
    return { crypto, cek, objectId, plaintext, sealed, ref }
}

/**
 * The shared two-epoch object. Sealed once per run: the first caller
 * pays for it and every later caller awaits the same promise, so a
 * second test that needs a second epoch does not seal a second 64 MiB
 * object. Callers must treat everything they get back as read-only,
 * and copy before mutating.
 */
export function multiEpochFixture ():Promise<MultiEpochFixture> {
    if (!cached) cached = build()
    return cached
}
