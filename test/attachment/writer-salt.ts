import { test } from '@substrate-system/tapzero'
import {
    encryptAttachmentForGroup, encryptAttachment,
} from '../../src/attachment/writer.js'
import { sealCryptoFromCiphersuite } from
    '../../src/attachment/crypto.js'
import { getCipherSuite } from
    '../../src/crypto/get-ciphersuite-impl.js'
import { getCiphersuiteFromName } from
    '../../src/crypto/ciphersuite.js'

const SUITE = 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519'

/**
 * `opts.salt` on the group wrapper would be a nonce-reuse footgun:
 * payloadKey, snapKey and nonceBase derive from (cek, salt) alone, so
 * a caller who pinned the salt and reused the CEK would XOR two
 * plaintexts together. The wrapper's option bag no longer carries the
 * field, and a caller who forces one past the type is ignored.
 */
test('encryptAttachmentForGroup ignores a salt passed past the type',
    async t => {
        const cs = await getCipherSuite(getCiphersuiteFromName(SUITE))
        const keySchedule = {
            applicationExportSecret: new Uint8Array(32).fill(0x07),
        }
        const objectId = new TextEncoder().encode('salt-footgun')
        const plaintext = new Uint8Array(4096).fill(0x11)
        const salt = new Uint8Array(32).fill(0x04)

        // A caller reaching past the option type with a fixed salt.
        const forced = { salt, locator: new Uint8Array() } as {
            locator?:Uint8Array
        }

        const a = await encryptAttachmentForGroup(
            keySchedule, objectId, plaintext, cs, forced,
        )
        const b = await encryptAttachmentForGroup(
            keySchedule, objectId, plaintext, cs, forced,
        )

        t.ok(
            a.bytes.length === b.bytes.length,
            'both seals have the same length',
        )
        t.ok(
            !a.bytes.every((byte, i) => byte === b.bytes[i]),
            'the two seals differ, so the forced salt was ignored',
        )
        t.ok(
            !a.bytes.slice(0, 32).every((byte) => byte === 0x04),
            'the header salt is not the forced one',
        )
    },
)

/**
 * The seam the vector generator uses stays open. `encryptAttachment`
 * takes the raw CEK, so the salt is the caller's to pin.
 */
test('encryptAttachment still honours an explicit salt', async t => {
    const cs = await getCipherSuite(getCiphersuiteFromName(SUITE))
    const crypto = sealCryptoFromCiphersuite(cs)
    const cek = new Uint8Array(32).fill(0x09)
    const objectId = new TextEncoder().encode('salt-seam')
    const plaintext = new Uint8Array(4096).fill(0x11)
    const salt = new Uint8Array(32).fill(0x04)

    const a = await encryptAttachment(
        cek, objectId, plaintext, crypto, { salt },
    )
    const b = await encryptAttachment(
        cek, objectId, plaintext, crypto, { salt },
    )

    t.deepEqual(
        Array.from(a.bytes), Array.from(b.bytes),
        'a pinned salt gives byte-identical output',
    )
})
