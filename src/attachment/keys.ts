import type { CiphersuiteImpl } from '../crypto/ciphersuite.js'
import type { Kdf } from '../crypto/kdf.js'
import { expandWithLabel } from '../crypto/kdf.js'
import type { KeySchedule } from '../key-schedule.js'
import { encodeVarLenData } from '../codec/variable-length.js'
import { encodeUint16 } from '../codec/number.js'
import { AttachmentError } from './error.js'

const encoder = new TextEncoder()

/**
 * Provisional private-use ComponentID for attachment_encryption.
 * The IANA value in draft-sullivan-mls-attachments is not yet
 * allocated; replace this constant when it is.
 *
 * NOTE: This implementation assumes a 16-bit ComponentID and a
 * 16-level exporter tree per draft-ietf-mls-extensions-09. The
 * tree-walking logic in safeExportSecret and the key derivations
 * are hardcoded to these constraints. If either draft updates
 * these parameters, the CEK derivation must be re-verified and
 * attachmentCek must be extended with version threading to support
 * old derivations. Cross-version interop is not currently supported.
 */
export const ATTACHMENT_COMPONENT_ID = 0xF001

export const CEK_LENGTH = 32

/**
 * A CEK is exactly CEK_LENGTH octets. `attachmentCek` always yields
 * that, but every entry point that takes a caller-supplied CEK has to
 * check: HKDF accepts input keying material of any length, so a short
 * CEK would silently key the whole object off less entropy than the
 * design assumes, and a long one would seal under a key no other
 * implementation can reproduce. Rejecting is the only safe answer.
 */
export function assertCekLength (cek:Uint8Array):void {
    if (cek.length !== CEK_LENGTH) throw new AttachmentError()
}

export function componentOperationLabel (
    componentId:number,
    label:string,
):Uint8Array {
    if (!Number.isInteger(componentId) || componentId < 0 ||
        componentId > 0xFFFF) {
        throw new AttachmentError()
    }
    const base = encodeVarLenData(encoder.encode('MLS Component'))
    const id = encodeUint16(componentId)
    const op = encodeVarLenData(encoder.encode(label))
    const out = new Uint8Array(
        base.length + id.length + op.length,
    )
    out.set(base, 0)
    out.set(id, base.length)
    out.set(op, base.length + id.length)
    return out
}

/**
 * ExpandWithLabel with a byte-string Label: KDFLabel.label is
 * "MLS 1.0 " followed by the raw label bytes (RFC 9420 section 8
 * with the Label supplied as bytes).
 */
async function expandWithLabelBytes (
    secret:Uint8Array,
    labelBytes:Uint8Array,
    context:Uint8Array,
    length:number,
    kdf:Kdf,
):Promise<Uint8Array> {
    const prefix = encoder.encode('MLS 1.0 ')
    const label = new Uint8Array(prefix.length + labelBytes.length)
    label.set(prefix, 0)
    label.set(labelBytes, prefix.length)
    return kdf.expand(
        secret,
        new Uint8Array([
            ...encodeUint16(length),
            ...encodeVarLenData(label),
            ...encodeVarLenData(context),
        ]),
        length,
    )
}

/**
 * Walk the safe-extension exporter tree from its root
 * (application_export_secret) to the leaf for componentId: 16
 * levels, child chosen by each ComponentID bit, MSB first.
 * Children per RFC 9420 secret tree:
 * ExpandWithLabel(parent, "tree", "left" | "right", Nh).
 */
export async function safeExportSecret (
    applicationExportSecret:Uint8Array,
    componentId:number,
    kdf:Kdf,
):Promise<Uint8Array> {
    if (!Number.isInteger(componentId) || componentId < 0 ||
        componentId > 0xFFFF) {
        throw new AttachmentError()
    }
    let node = applicationExportSecret
    try {
        for (let bit = 15; bit >= 0; bit--) {
            const right = (componentId >> bit) & 1
            const child = await expandWithLabel(
                node,
                'tree',
                encoder.encode(right ? 'right' : 'left'),
                kdf.size,
                kdf,
            )
            // The root is the caller's buffer and is never ours to
            // wipe. Every other node was derived here, and once its
            // child exists it has no further use.
            if (node !== applicationExportSecret) node.fill(0)
            node = child
        }
    } catch (err) {
        // The walk is abandoned, so the node in hand is dead too --
        // but only if we derived it.
        if (node !== applicationExportSecret) node.fill(0)
        throw err
    }
    return node
}

export interface AttachmentCekOptions {
    componentId?:number
}

/**
 * mls-attachments section 4.1. The CEK is deterministic for
 * (epoch, objectId); the caller owns objectId uniqueness within
 * the epoch (1..255 octets, never reused across epochs).
 */
export async function attachmentCek (
    keySchedule:Pick<KeySchedule, 'applicationExportSecret'>,
    objectId:Uint8Array,
    cs:Pick<CiphersuiteImpl, 'kdf'>,
    opts?:AttachmentCekOptions,
):Promise<Uint8Array> {
    if (objectId.length < 1 || objectId.length > 255) {
        throw new AttachmentError()
    }
    const componentId = opts?.componentId ?? ATTACHMENT_COMPONENT_ID
    const root = keySchedule.applicationExportSecret
    if (!(root instanceof Uint8Array) || root.length !== cs.kdf.size) {
        throw new AttachmentError()
    }
    const componentSecret = await safeExportSecret(
        root, componentId, cs.kdf,
    )
    // componentSecret derives the CEK for every objectId in this
    // epoch, so it outweighs any single CEK. The `finally` wipes it
    // on the throw path as well, where it would otherwise be left in
    // memory with nobody holding a reference to clear it.
    try {
        return await expandWithLabelBytes(
            componentSecret,
            componentOperationLabel(componentId, 'attachment'),
            objectId,
            CEK_LENGTH,
            cs.kdf,
        )
    } finally {
        componentSecret.fill(0)
    }
}
