import {
    sealObject,
} from './object.js'
import type { SealCrypto } from './crypto.js'
import { sealCryptoFromCiphersuite } from './crypto.js'
import { attachmentCek } from './keys.js'
import type { AttachmentRef } from './reference.js'
import type { KeySchedule } from '../key-schedule.js'
import type { CiphersuiteImpl } from '../crypto/ciphersuite.js'
import { SEGMENT_MAX } from './schedule.js'

/**
 * What the two encrypt entry points return. The object is already
 * sealed by the time you hold one of these; nothing here does further
 * work.
 *
 * - `readable`: the sealed bytes as a `ReadableStream`, chunked at
 *   `SEGMENT_MAX` (64 KiB). Use it to upload without a second copy of
 *   the whole object in a request body. It chunks the very same
 *   sealed buffer, not a re-encryption, so consuming it and reading
 *   `bytes` give identical octets. Single use, like any stream.
 * - `reference`: the `AttachmentRef` a reader needs. It carries the
 *   snapshot root, so it MUST travel inside something the sender
 *   signed; see `refToAuthData`.
 * - `bytes`: the same sealed object in one array, for callers that
 *   want it whole.
 *
 * Holds no key material: the object is ciphertext and the reference
 * is public. There is nothing here to wipe. The CEK is the caller's
 * (or, for `encryptAttachmentForGroup`, already wiped).
 */
export interface EncryptedAttachment {
    readable:ReadableStream<Uint8Array>
    reference:AttachmentRef
    bytes:Uint8Array
}

/**
 * Seal plaintext to a sealed attachment. Produces ciphertext bytes
 * and reference identical to sealObject, wrapped in a
 * ReadableStream emitting SEGMENT_MAX-sized chunks.
 *
 * `cek` must be exactly CEK_LENGTH octets. The check lives in
 * sealObject, which runs before anything else here, so a wrong-length
 * CEK throws AttachmentError with no work done and no stream created.
 *
 * `opts.salt` is for tests and vector generation only. The payload
 * key, the snapshot key and the nonce base all derive from
 * `(cek, salt)` and nothing else; the objectId enters the commitment
 * alone. Two calls that share a CEK and a pinned salt therefore
 * produce the same AES-GCM key and nonce for every segment, and the
 * two ciphertexts XOR to the two plaintexts. Leave it unset in
 * production, or use `encryptAttachmentForGroup`, whose per-object
 * CEK makes the collision unreachable.
 *
 * `opts.locator` is where the object will be stored: a URL, a
 * content address, a bucket key, whatever the deployment uses. It is
 * copied verbatim into `reference.locator` and is otherwise inert --
 * this library never fetches it, and no key or authenticator derives
 * from it. It rides inside the signed reference, so a reader can
 * trust it came from the sender, but it is not secret: leave it unset
 * (the default is an empty array) if the storage path leaks something
 * the transport should not.
 *
 * @throws {AttachmentError} From `sealObject`, on a wrong-length CEK,
 * an empty plaintext, or an objectId outside 1 to 255 octets. All of
 * that runs before the stream is created, so a throw leaves nothing
 * to clean up.
 *
 * Memory: does not own `cek` and does not wipe it. The caller wipes
 * the key it supplied. `sealObject` wipes its own derived state.
 */
export async function encryptAttachment (
    cek:Uint8Array,
    objectId:Uint8Array,
    plaintext:Uint8Array,
    crypto:SealCrypto,
    opts?:{ salt?:Uint8Array, locator?:Uint8Array },
):Promise<EncryptedAttachment> {
    // Seal the plaintext using sealObject
    const sealed = await sealObject(cek, objectId, plaintext, crypto, {
        salt: opts?.salt,
    })

    // Build the AttachmentRef
    const reference:AttachmentRef = {
        version: 1,
        objectId: objectId.slice(),
        plaintextLength: BigInt(plaintext.length),
        snapshot: sealed.snapshot.slice(),
        locator: opts?.locator ?? new Uint8Array(),
    }

    // Wrap the bytes in a ReadableStream emitting SEGMENT_MAX chunks
    let offset = 0
    const readable = new ReadableStream({
        pull (controller) {
            if (offset >= sealed.bytes.length) {
                controller.close()
            } else {
                const chunk = sealed.bytes.slice(
                    offset,
                    Math.min(offset + SEGMENT_MAX, sealed.bytes.length),
                )
                offset += chunk.length
                controller.enqueue(chunk)
            }
        },
    })

    return { readable, reference, bytes: sealed.bytes }
}

/**
 * Convenience wrapper: derive the CEK via attachmentCek and the
 * crypto bundle via sealCryptoFromCiphersuite, then delegate to
 * encryptAttachment. The derived CEK is wiped (zeroed) before
 * returning, on both success and error paths.
 *
 * There is deliberately no `salt` option here. A pinned salt plus a
 * repeated CEK repeats the whole segment key and nonce stream, so the
 * only safe salt on a group-derived CEK is a fresh random one. The
 * salt always comes from `crypto.rng`.
 *
 * LIFETIME: the returned ref is only decryptable within the epoch it
 * was created in. The CEK comes from the current epoch's
 * `applicationExportSecret`, and the ref carries no epoch, so once the
 * group commits, no member -- including the sender -- can re-derive
 * it. The read then fails the commitment gate and throws a bare
 * `AttachmentError`, which is exactly what a tampered object throws:
 * a post-commit read is indistinguishable from tampering. Treat a ref
 * as valid for the epoch that produced it and no longer.
 *
 * `opts.locator` is passed straight through to `encryptAttachment`;
 * see there for what it is and is not.
 */
export async function encryptAttachmentForGroup (
    keySchedule:Pick<KeySchedule, 'applicationExportSecret'>,
    objectId:Uint8Array,
    plaintext:Uint8Array,
    cs:CiphersuiteImpl,
    opts?:{ locator?:Uint8Array },
):Promise<EncryptedAttachment> {
    const cek = await attachmentCek(keySchedule, objectId, cs)
    try {
        const crypto = sealCryptoFromCiphersuite(cs)
        return await encryptAttachment(
            cek, objectId, plaintext, crypto,
            { locator: opts?.locator },
        )
    } finally {
        cek.fill(0)
    }
}
