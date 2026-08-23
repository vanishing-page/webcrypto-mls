import { test } from '@substrate-system/tapzero'
import type { AttachmentRangeRead } from
    '../../src/attachment/range.js'
import {
    openAttachmentRange, openAttachmentRangeForGroup,
} from '../../src/attachment/range.js'
import { encryptAttachment } from '../../src/attachment/writer.js'
import { attachmentCek } from '../../src/attachment/keys.js'
import { getCipherSuite } from
    '../../src/crypto/get-ciphersuite-impl.js'
import { getCiphersuiteFromName } from
    '../../src/crypto/ciphersuite.js'
import { sealCryptoFromCiphersuite } from
    '../../src/attachment/crypto.js'

/**
 * The keys of `T` that a value must supply. A key declared `k?:` is
 * absent from this union, because `Pick<T, k>` is then satisfied by
 * `{}`.
 */
type RequiredKeys<T> = {
    [K in keyof T]-?:object extends Pick<T, K> ? never : K
}[keyof T]

/**
 * `true` only while `close` is a required member. If `close` goes
 * back to `close?:`, this resolves to `never` and the initializer
 * below stops typechecking. That is the real assertion in this file:
 * the runtime check that follows cannot see the difference, because
 * an optional member holding a function passes it either way.
 */
type CloseIsRequired = 'close' extends RequiredKeys<AttachmentRangeRead> ?
    true :
    never

/**
 * `true` only while the member's type excludes `undefined`. Required
 * and non-undefined are separate properties -- `close:(() => void)|
 * undefined` is required yet still forces callers to guard.
 */
type CloseIsNeverUndefined = undefined extends AttachmentRangeRead['close'] ?
    never :
    true

const closeIsRequired:CloseIsRequired = true
const closeIsNeverUndefined:CloseIsNeverUndefined = true

test('AttachmentRangeRead.close is a required member', t => {
    t.equal(closeIsRequired, true, 'close is not optional')
    t.equal(
        closeIsNeverUndefined,
        true,
        'close cannot be undefined',
    )
})

test('close is present on both open paths', async t => {
    const cs = await getCipherSuite(getCiphersuiteFromName(
        'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519',
    ))
    const keySchedule = {
        applicationExportSecret: new Uint8Array(32),
    }
    const objectId = new TextEncoder().encode('close-required')
    const plaintext = new Uint8Array(1000)

    const cek = await attachmentCek(keySchedule, objectId, cs)
    const crypto = sealCryptoFromCiphersuite(cs)
    const encrypted = await encryptAttachment(
        cek, objectId, plaintext, crypto,
    )

    const direct = await openAttachmentRange(
        cek, encrypted.reference, { offset: 0, length: 100 }, crypto,
    )
    t.equal(
        typeof direct.close,
        'function',
        'openAttachmentRange returns a close()',
    )
    direct.close()

    const forGroup = await openAttachmentRangeForGroup(
        keySchedule, encrypted.reference, { offset: 0, length: 100 }, cs,
    )
    t.equal(
        typeof forGroup.close,
        'function',
        'openAttachmentRangeForGroup returns a close()',
    )
    forGroup.close()

    cek.fill(0)
})
