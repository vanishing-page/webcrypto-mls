import {
    startSeal, startOpen, sealSegment, openSegment,
    wipeSealState, PROTOCOL_RO, SNAP_EPOCH_TREE,
    NONCE_DERIVED, ATTACHMENT_EPOCH_LENGTH, SEGMENT_MAX,
    type SealParams,
} from './schedule.js'
import {
    segmentLeaf, epochHead, epochTreeRoot,
} from './snapshot.js'
import { layout, metaRange, blockRange, isZeroRegion }
    from './layout.js'
import { AttachmentError } from './error.js'
import type { SealCrypto } from './crypto.js'
import { constantTimeEqual, concatAll } from './kdf.js'
import { assertCekLength } from './keys.js'

export interface SealedObject {
    bytes:Uint8Array
    snapshot:Uint8Array
    salt:Uint8Array
}

/**
 * Seal a plaintext into an attachment object: header, padding gap and
 * the encrypted blocks, plus the snapshot root and the salt used.
 *
 * @param cek Content encryption key, exactly `CEK_LENGTH` (32)
 * octets. Usually the output of `attachmentCek`.
 * @param objectId Identifies the attachment; 1 to 255 octets. It is
 * bound into the commitment, so an object only opens under the same
 * id it was sealed under.
 * @param plaintext The bytes to seal. Must be non-empty, and is
 * sealed whole: this entry point holds the plaintext and the whole
 * object in memory at once. For anything large, use
 * `encryptAttachment`, which streams the result out.
 * @param crypto The primitive bundle. `crypto.rng` supplies the salt
 * and `crypto.kdf.size` sets the header size.
 * @param opts.salt Tests and vector generation only. The payload key,
 * the snapshot key and the nonce base derive from `(cek, salt)` and
 * nothing else; the objectId enters the commitment alone. Two seals
 * that share a CEK and a pinned salt reuse the same AES-GCM key and
 * nonce for every segment, so their ciphertexts XOR to the two
 * plaintexts. Leave it unset and the salt comes from `crypto.rng`.
 *
 * @returns The object `bytes`, the `snapshot` root that authenticates
 * them, and the `salt` that was used. The snapshot is what a reader
 * has to receive over an authenticated channel; see `AttachmentRef`.
 *
 * @throws {AttachmentError} On a wrong-length CEK, an empty
 * plaintext, an objectId outside 1 to 255 octets, or a plaintext too
 * large to lay out. The error carries no message or cause by design,
 * so the caller cannot tell these apart.
 *
 * Memory: owns the `SealState` it derives (payload key, snapshot key,
 * nonce base, cached epoch keys) and wipes it in a `finally`, on both
 * the success and the throw path. It does NOT own `cek`, `objectId`
 * or `plaintext`: wiping those is the caller's job. The returned
 * `bytes` and `snapshot` are fresh allocations the caller owns.
 */
export async function sealObject (
    cek:Uint8Array,
    objectId:Uint8Array,
    plaintext:Uint8Array,
    crypto:SealCrypto,
    opts?:{ salt?:Uint8Array },
):Promise<SealedObject> {
    // Reject a wrong-length CEK, empty plaintext, and an empty or
    // oversize objectId
    assertCekLength(cek)
    if (plaintext.length === 0) throw new AttachmentError()
    if (objectId.length === 0 || objectId.length > 255) {
        throw new AttachmentError()
    }

    // Get or generate salt
    const salt = opts?.salt ?? crypto.rng.randomBytes(32)

    // Build SealParams from SEAL-attachment constants
    const params:SealParams = {
        protocolId: PROTOCOL_RO,
        aeadId: crypto.aeadId,
        kdfId: crypto.kdfId,
        segmentMax: SEGMENT_MAX,
        snapId: SNAP_EPOCH_TREE,
        nonceMode: NONCE_DERIVED,
        epochLength: ATTACHMENT_EPOCH_LENGTH,
        salt,
    }

    // Start seal
    const state = await startSeal(cek, params, objectId, crypto)

    try {
        // Hoist LayoutParams for reuse
        const layoutParams = {
            plaintextLength: plaintext.length,
            segmentMax: SEGMENT_MAX,
            epochLength: ATTACHMENT_EPOCH_LENGTH,
            nh: crypto.kdf.size,
        }

        // Compute layout
        const l = layout(layoutParams)

        // Allocate object bytes
        const bytes = new Uint8Array(l.totalSize)

        // Seal each segment and write ciphertext and leaf
        for (let i = 0; i < l.nSeg; i++) {
            const isFinal = i === l.nSeg - 1
            const segStart = i * SEGMENT_MAX
            const segEnd = Math.min(segStart + SEGMENT_MAX, plaintext.length)
            const segPlaintext = plaintext.slice(segStart, segEnd)

            const sealed = await sealSegment(state, {
                index: BigInt(i),
                isFinal,
                plaintext: segPlaintext,
            })

            // Write ciphertext to block
            const br = blockRange(l, layoutParams, i)
            bytes.set(sealed.ciphertext, br.offset)

            // Write leaf to metadata: LH(ct) || tag
            const leaf = await segmentLeaf(state, sealed.ciphertext, sealed.tag)
            const mr = metaRange(l, i)
            bytes.set(leaf, mr.offset)
        }

        // Group leaves into epoch runs and compute epoch heads
        const perEpoch = 2 ** ATTACHMENT_EPOCH_LENGTH
        const heads:Uint8Array[] = []
        for (let e = 0; e < l.nEp; e++) {
            const first = e * perEpoch
            const count = Math.min(perEpoch, l.nSeg - first)

            // Concatenate leaves for this epoch
            const leaves:Uint8Array[] = []
            for (let i = first; i < first + count; i++) {
                const mr = metaRange(l, i)
                leaves.push(bytes.slice(mr.offset, mr.offset + mr.length))
            }
            const epochRun = concatAll(leaves)

            // Compute epoch head
            const head = await epochHead(state, epochRun)
            heads.push(head)
        }

        // Concatenate all heads
        const allHeads = concatAll(heads)

        // Compute root snapshot
        const root = await epochTreeRoot(state, BigInt(l.nSeg), allHeads)

        // Write salt, commitment, snapshot to header
        bytes.set(salt, 0)
        bytes.set(state.commitment, 32)
        bytes.set(root, 32 + crypto.kdf.size)

        // Write epoch heads
        bytes.set(allHeads, l.epochHeadsOffset)

        return {
            bytes,
            snapshot: root,
            salt,
        }
    } finally {
        wipeSealState(state)
    }
}

/**
 * Open a sealed object whole and return its plaintext. Verifies the
 * commitment, every segment leaf, every epoch head and the snapshot
 * root before decrypting anything.
 *
 * @param cek The same content encryption key the object was sealed
 * under, exactly `CEK_LENGTH` (32) octets.
 * @param objectId The same 1 to 255 octet id used to seal.
 * @param bytes The whole sealed object. Its length must equal the
 * size the layout computes from `ref.plaintextLength`.
 * @param ref.snapshot The authenticated snapshot root, from a signed
 * `AttachmentRef`. The copy stored in the object's own header is
 * checked for consistency but is never trusted on its own.
 * @param ref.plaintextLength The plaintext length, as a `number`.
 * NOTE the type difference: `AttachmentRef.plaintextLength` is a
 * `bigint`, because the wire format carries a uint64, while this
 * lower level entry point takes a `number`. Narrowing is the
 * caller's job (`Number(ref.plaintextLength)`), and a file big enough
 * to lose precision in a `number` is one to stream rather than open
 * whole. `decryptAttachmentStream` takes the `bigint` directly.
 * @param crypto The primitive bundle. Must be the same AEAD and KDF
 * pair the object was sealed under; the ids are bound into the key
 * schedule.
 *
 * @returns A fresh `Uint8Array` of the plaintext, owned by the
 * caller.
 *
 * @throws {AttachmentError} On a wrong-length CEK, an objectId
 * outside 1 to 255 octets, a `bytes` length that disagrees with the
 * layout, a non-zero padding gap, a commitment mismatch (wrong CEK,
 * wrong objectId, or a tampered header), a leaf, epoch head or root
 * that does not recompute, a snapshot that does not match `ref`, or a
 * segment whose AEAD tag fails. Every one of these throws the same
 * bare error with no message: a wrong key and a tampered object are
 * deliberately indistinguishable.
 *
 * Memory: owns the `SealState` it derives and wipes it in a
 * `finally`, on both the success and the throw path. `startOpen`
 * wipes what it derived before throwing on a commitment mismatch, so
 * a failed open leaves no key material behind either. It does NOT
 * own `cek`, `objectId` or `bytes`.
 */
export async function openObject (
    cek:Uint8Array,
    objectId:Uint8Array,
    bytes:Uint8Array,
    ref:{ snapshot:Uint8Array, plaintextLength:number },
    crypto:SealCrypto,
):Promise<Uint8Array> {
    // Reject a wrong-length CEK, and an empty or oversize objectId.
    // The CEK check comes before any derivation: a wrong-length CEK
    // is a caller bug, not a failed decrypt.
    assertCekLength(cek)
    if (objectId.length < 1 || objectId.length > 255) {
        throw new AttachmentError()
    }

    // Hoist LayoutParams for reuse
    const layoutParams = {
        plaintextLength: ref.plaintextLength,
        segmentMax: SEGMENT_MAX,
        epochLength: ATTACHMENT_EPOCH_LENGTH,
        nh: crypto.kdf.size,
    }

    // Compute layout from ref.plaintextLength
    const l = layout(layoutParams)

    // Verify bytes.length == totalSize
    if (bytes.length !== l.totalSize) throw new AttachmentError()

    // Verify padding gap is all zero
    if (!isZeroRegion(bytes, l.headerSize, l.firstBlockOffset)) {
        throw new AttachmentError()
    }

    // Parse salt from header
    const salt = bytes.slice(0, 32)
    const storedCommitment = bytes.slice(32, 32 + crypto.kdf.size)

    // Rebuild params
    const params:SealParams = {
        protocolId: PROTOCOL_RO,
        aeadId: crypto.aeadId,
        kdfId: crypto.kdfId,
        segmentMax: SEGMENT_MAX,
        snapId: SNAP_EPOCH_TREE,
        nonceMode: NONCE_DERIVED,
        epochLength: ATTACHMENT_EPOCH_LENGTH,
        salt,
    }

    // startOpen (gate on commitment)
    const state = await startOpen(cek, params, objectId, storedCommitment,
        crypto)

    try {
        // Recompute leaves and epoch heads
        const perEpoch = 2 ** ATTACHMENT_EPOCH_LENGTH
        const heads:Uint8Array[] = []

        for (let e = 0; e < l.nEp; e++) {
            const first = e * perEpoch
            const count = Math.min(perEpoch, l.nSeg - first)

            // Recompute leaves for this epoch
            const leaves:Uint8Array[] = []
            for (let i = first; i < first + count; i++) {
                const br = blockRange(l, layoutParams, i)
                const mr = metaRange(l, i)

                const ciphertext = bytes.slice(br.offset,
                    br.offset + br.length)
                const tag = bytes.slice(mr.offset + crypto.kdf.size,
                    mr.offset + mr.length)

                // Recompute leaf
                const leaf = await segmentLeaf(state, ciphertext, tag)
                leaves.push(leaf)

                // Verify stored leaf matches recomputed
                const storedLeaf = bytes.slice(mr.offset, mr.offset + mr.length)
                if (!constantTimeEqual(leaf, storedLeaf)) {
                    throw new AttachmentError()
                }
            }

            // Compute epoch head
            const epochRun = concatAll(leaves)
            const head = await epochHead(state, epochRun)
            heads.push(head)

            // Verify stored epoch head
            const storedHead = bytes.slice(
                l.epochHeadsOffset + (e * crypto.kdf.size),
                l.epochHeadsOffset + ((e + 1) * crypto.kdf.size),
            )
            if (!constantTimeEqual(head, storedHead)) {
                throw new AttachmentError()
            }
        }

        // Compute and verify root
        const allHeads = concatAll(heads)
        const root = await epochTreeRoot(state, BigInt(l.nSeg), allHeads)

        // Compare root against ref.snapshot (constant time)
        if (!constantTimeEqual(root, ref.snapshot)) {
            throw new AttachmentError()
        }

        // Also verify against stored snapshot field as consistency check
        const storedSnapshot = bytes.slice(32 + crypto.kdf.size,
            32 + (2 * crypto.kdf.size))
        if (!constantTimeEqual(root, storedSnapshot)) {
            throw new AttachmentError()
        }

        // openSegment each block and concatenate plaintext
        const plaintextParts:Uint8Array[] = []
        for (let i = 0; i < l.nSeg; i++) {
            const isFinal = i === l.nSeg - 1
            const br = blockRange(l, layoutParams, i)
            const mr = metaRange(l, i)

            const ciphertext = bytes.slice(br.offset, br.offset + br.length)
            const tag = bytes.slice(mr.offset + crypto.kdf.size,
                mr.offset + mr.length)

            const plaintext = await openSegment(state, {
                index: BigInt(i),
                isFinal,
                ciphertext,
                tag,
            })

            plaintextParts.push(plaintext)
        }

        return concatAll(plaintextParts)
    } finally {
        wipeSealState(state)
    }
}
