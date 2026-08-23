import type { Encoder } from '../codec/tls-encoder.js'
import { contramapEncoders } from '../codec/tls-encoder.js'
import type { Decoder } from '../codec/tls-decoder.js'
import { mapDecoders } from '../codec/tls-decoder.js'
import {
    decodeVarLenData, encodeVarLenData,
} from '../codec/variable-length.js'
import {
    decodeUint8, decodeUint64, encodeUint8, encodeUint64,
} from '../codec/number.js'
import { AttachmentError } from './error.js'

/**
 * Library-level format version (the design's Versioning
 * requirement). Bump when the drafts change our stored bytes;
 * decoders reject versions they do not know.
 */
export const ATTACHMENT_REF_VERSION = 1

/**
 * The authenticated reference to an encrypted attachment. Must
 * travel inside a signed MLS message (authenticated_data or
 * application content); receivers use ONLY these values, never the
 * copies stored in the object.
 */
export interface AttachmentRef {
    version:number
    objectId:Uint8Array
    plaintextLength:bigint
    snapshot:Uint8Array
    locator:Uint8Array
}

/**
 * Encode a reference to its TLS wire form: `version` as a uint8,
 * `objectId` as varint-prefixed data, `plaintextLength` as a uint64,
 * then `snapshot` and `locator` as varint-prefixed data. Round trips
 * through `decodeAttachmentRef`.
 *
 * Validates first, so an ill formed ref never reaches the wire.
 *
 * @param r The reference to encode. Not retained and not mutated;
 * `decodeAttachmentRef` copies its arrays out on the way back, so the
 * two sides never share a buffer.
 * @returns A fresh `Uint8Array`, owned by the caller.
 *
 * @throws {AttachmentError} Whatever `validateAttachmentRef` throws:
 * an unknown version, an objectId outside 1 to 255 octets, a
 * `plaintextLength` that is not a positive uint64, or a snapshot
 * whose length is not one of `SNAPSHOT_LENGTHS`. Note the arity: this
 * cannot pass a `kdfSize`, so it only checks membership in that set.
 *
 * Memory: the encoded bytes are public. A reference holds no key
 * material -- the snapshot is a commitment, not a secret -- so there
 * is nothing here to wipe. What matters is integrity, not
 * confidentiality: the result MUST be covered by the sender's
 * signature. See `refToAuthData`.
 */
export function encodeAttachmentRef (r:AttachmentRef):Uint8Array {
    validateAttachmentRef(r)
    const encoder:Encoder<AttachmentRef> = contramapEncoders(
        [
            encodeUint8,
            encodeVarLenData,
            encodeUint64,
            encodeVarLenData,
            encodeVarLenData,
        ],
        (ref:AttachmentRef) => [
            ref.version, ref.objectId, ref.plaintextLength, ref.snapshot,
            ref.locator,
        ] as const,
    )
    return encoder(r)
}

const decodeRefBody:Decoder<AttachmentRef> = mapDecoders(
    [
        decodeUint8, decodeVarLenData, decodeUint64,
        decodeVarLenData, decodeVarLenData,
    ],
    (version, objectId, plaintextLength, snapshot, locator) => ({
        version, objectId, plaintextLength, snapshot, locator,
    }),
)

/**
 * The snapshot is one KDF output, so its length is the KDF output
 * size of the ciphersuite the object was sealed under: SHA-256,
 * SHA-384 or SHA-512. A ref carries no ciphersuite, so a caller with
 * no crypto in hand can only check membership in this set; callers
 * that do have a `SealCrypto` pass `crypto.kdf.size` and pin the one
 * length that can be right.
 */
export const SNAPSHOT_LENGTHS:readonly number[] = [32, 48, 64]

/**
 * A wrong-length snapshot is caught downstream anyway, because
 * `constantTimeEqual` returns false for unequal lengths before it
 * compares anything. That is a property of a general-purpose utility
 * two modules away, though, and this is the layer that decides what a
 * well formed ref is, so the check belongs here as well. Both layers
 * have their own test.
 *
 * @param r The reference to check. Read only; nothing is normalized
 * or filled in.
 * @param kdfSize The KDF output size of the ciphersuite the object
 * was sealed under, in octets. Pass it whenever a `SealCrypto` is in
 * hand (`crypto.kdf.size`) and the snapshot length is pinned to the
 * one value that can be right. Omit it and the check weakens to
 * membership in `SNAPSHOT_LENGTHS`, which is all a caller with no
 * crypto can do: a ref carries no ciphersuite.
 * @returns Nothing. It either returns or throws.
 *
 * @throws {AttachmentError} On a `version` other than
 * `ATTACHMENT_REF_VERSION`, an `objectId` outside 1 to 255 octets, a
 * `plaintextLength` that is not positive or does not fit a uint64, or
 * a `snapshot` of the wrong length. As everywhere in this module the
 * error is bare, so the cases are not distinguishable from outside.
 *
 * Memory: owns nothing and wipes nothing.
 */
export function validateAttachmentRef (
    r:AttachmentRef,
    kdfSize?:number,
):void {
    if (r.version !== ATTACHMENT_REF_VERSION) {
        throw new AttachmentError()
    }
    if (r.objectId.length < 1 || r.objectId.length > 255) {
        throw new AttachmentError()
    }
    if (r.plaintextLength <= 0n) throw new AttachmentError()
    if (r.plaintextLength > 0xFFFFFFFFFFFFFFFFn) throw new AttachmentError()
    if (kdfSize === undefined) {
        if (!SNAPSHOT_LENGTHS.includes(r.snapshot.length)) {
            throw new AttachmentError()
        }
    } else if (r.snapshot.length !== kdfSize) {
        throw new AttachmentError()
    }
}

/**
 * Strict decode: the whole input must be consumed. Truncated input
 * makes decodeVarLenData THROW CodecError (it does not return
 * undefined, see src/codec/variable-length.ts:63-72), so the body
 * decode is wrapped to keep the single-opaque-error rule.
 */
export function decodeAttachmentRef (bytes:Uint8Array):AttachmentRef {
    let result
    try {
        result = decodeRefBody(bytes, 0)
    } catch (_err) {
        throw new AttachmentError()
    }
    if (!result || result[1] !== bytes.length) {
        throw new AttachmentError()
    }
    const decoded = result[0]
    validateAttachmentRef(decoded)
    return {
        version: decoded.version,
        objectId: decoded.objectId.slice(),
        plaintextLength: decoded.plaintextLength,
        snapshot: decoded.snapshot.slice(),
        locator: decoded.locator.slice(),
    }
}

/**
 * Helpers for the signed transport. The reference MUST be covered
 * by the sender's signature; pass the encoded bytes as the
 * authenticatedData argument of createApplicationMessage or
 * createProposal (src/create-message.ts:73 and :16), or embed them
 * in signed application content. Receivers recover the ref with
 * refFromAuthData and MUST ignore any snapshot or length
 * stored inside the object itself.
 */
export function refToAuthData (r:AttachmentRef):Uint8Array {
    validateAttachmentRef(r)
    return encodeAttachmentRef(r)
}

export function refFromAuthData (
    bytes:Uint8Array,
):AttachmentRef {
    return decodeAttachmentRef(bytes)
}
