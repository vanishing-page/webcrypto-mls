import {
    ATTACHMENT_EPOCH_LENGTH, SEGMENT_MAX,
} from '../../src/attachment/schedule.js'
import type { LayoutParams, Layout } from
    '../../src/attachment/layout.js'
import { layout } from '../../src/attachment/layout.js'
import type { SealCrypto } from
    '../../src/attachment/crypto.js'
import type { AttachmentRef } from
    '../../src/attachment/reference.js'

/**
 * Build layout parameters and compute layout from plaintext length
 * and crypto context.
 */
export function buildLayout (
    plaintextLength:number,
    crypto:SealCrypto,
):{ layoutParams:LayoutParams, l:Layout } {
    const layoutParams = {
        plaintextLength,
        segmentMax: SEGMENT_MAX,
        epochLength: ATTACHMENT_EPOCH_LENGTH,
        nh: crypto.kdf.size,
    }
    const l = layout(layoutParams)
    return { layoutParams, l }
}

/**
 * Build an AttachmentRef from plaintext, objectId, and sealed object.
 */
export function buildRef (
    plaintext:Uint8Array,
    objectId:Uint8Array,
    sealed:{ snapshot:Uint8Array },
):AttachmentRef {
    return {
        version: 1,
        objectId: objectId.slice(),
        plaintextLength: BigInt(plaintext.length),
        snapshot: sealed.snapshot.slice(),
        locator: new Uint8Array(),
    }
}
