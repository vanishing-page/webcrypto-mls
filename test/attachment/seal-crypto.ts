import { test } from '@substrate-system/tapzero'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import { getCiphersuiteFromName } from '../../src/crypto/ciphersuite.js'
import {
    sealCryptoFromCiphersuite,
} from '../../src/attachment/crypto.js'
import { sealObject } from '../../src/attachment/object.js'
import {
    startSeal,
    sealSegment,
    openSegment,
    PROTOCOL_RO,
} from '../../src/attachment/schedule.js'

// I5: Test sealCryptoFromCiphersuite constructor wiring
test('I5: sealCryptoFromCiphersuite constructs correct bundle',
    async t => {
        // Use MLS_256_DHKEMP521_AES256GCM_SHA512_P521 where AEAD and KDF
        // code points differ (AES256GCM 0x0002, HKDF-SHA512 0x0003).
        // This lets us catch swapped aeadId/kdfId in the constructor.
        const cs = await getCipherSuite(getCiphersuiteFromName(
            'MLS_256_DHKEMP521_AES256GCM_SHA512_P521'
        ))

        const bundle = sealCryptoFromCiphersuite(cs)

        // Assert literal code points, not table lookups
        t.equal(
            bundle.aeadId,
            0x0002,
            'AES256GCM should have code point 0x0002',
        )
        t.equal(
            bundle.kdfId,
            0x0003,
            'HKDF-SHA512 should have code point 0x0003',
        )
        t.equal(
            bundle.keyLength,
            32,
            'AES-256 should have 32-byte key length',
        )
        t.equal(
            bundle.nonceLength,
            12,
            'GCM should have 12-byte nonce length',
        )
        t.equal(
            bundle.tagLength,
            16,
            'all AEADs should have 16-byte tag length',
        )
    },
)

// I5 bonus: End-to-end test that bundle actually works
test('I5: sealCryptoFromCiphersuite bundle works end-to-end',
    async t => {
        const cs = await getCipherSuite(getCiphersuiteFromName(
            'MLS_256_DHKEMP521_AES256GCM_SHA512_P521'
        ))
        const bundle = sealCryptoFromCiphersuite(cs)

        // Use the bundle to derive a schedule and seal/open a segment
        const cek = new Uint8Array(32)
        crypto.getRandomValues(cek)
        const params = {
            protocolId: PROTOCOL_RO,
            aeadId: bundle.aeadId,
            kdfId: bundle.kdfId,
            segmentMax: 16384,
            snapId: 0,
            nonceMode: 0,
            epochLength: 1,
            salt: new Uint8Array(32),
        }
        crypto.getRandomValues(params.salt)

        const state = await startSeal(cek, params, new Uint8Array(), bundle)

        const plaintext = new Uint8Array([1, 2, 3, 4, 5])
        const nonce = new Uint8Array(12)
        crypto.getRandomValues(nonce)

        const sealed = await sealSegment(state, {
            index: 0n,
            isFinal: false,
            plaintext,
            nonce,
        })

        t.ok(
            sealed.ciphertext.length > 0,
            'sealed ciphertext should be non-empty',
        )
        t.equal(
            sealed.tag.length,
            bundle.tagLength,
            'tag length should match bundle',
        )

        const opened = await openSegment(state, {
            index: 0n,
            isFinal: false,
            ciphertext: sealed.ciphertext,
            tag: sealed.tag,
            nonce: sealed.nonce,
        })

        t.equal(
            opened.length,
            plaintext.length,
            'opened plaintext length should match',
        )
        t.ok(
            opened.every((b, i) => b === plaintext[i]),
            'opened plaintext should match original',
        )
    },
)

// The seam AC3.1 actually rests on. The AC3.1 test in
// test/attachment/object.ts hand-spreads { ...bundle, rng: stub },
// which exercises sealObject's use of the field but bypasses the
// constructor that puts it there. sealCryptoFromCiphersuite is the
// only constructor production uses -- encryptAttachment,
// openAttachmentRangeForGroup and decryptAttachmentStreamForGroup all
// go through it -- so replacing `rng: cs.rng` with `rng: defaultRng`
// there would silently ignore a caller's CryptoProvider for the object
// salt, which is the exact defect this phase removes, and every test
// in the suite passed under that mutation.
//
// The stub goes on the CIPHERSUITE, not on the bundle. Comparing
// bundle.rng against cs.rng with a stock ciphersuite proves nothing:
// both providers set rng to the same defaultRng object, so the
// comparison holds under the mutation too.
test('AC3.1: the bundle carries the ciphersuite\'s rng through to ' +
    'the object salt',
async t => {
    const base = await getCipherSuite(getCiphersuiteFromName(
        'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519'
    ))
    const stubRng = {
        randomBytes (n:number) {
            return new Uint8Array(n).fill(0x07)
        },
    }
    const bundle = sealCryptoFromCiphersuite({ ...base, rng: stubRng })
    t.equal(bundle.rng, stubRng, 'bundle carries the supplied rng')

    const cek = new Uint8Array(32).fill(0xAA)
    const objectId = new TextEncoder().encode('rng-seam')
    const plaintext = new Uint8Array(100)
    const sealed = await sealObject(cek, objectId, plaintext, bundle)

    // Assert on the header bytes rather than sealed.salt: salt is the
    // same binding the stub returned, so asserting it is an identity
    // check on the stub's own output.
    t.equal(
        sealed.bytes.slice(0, 32).every(b => b === 0x07),
        true,
        'header salt comes from the supplied rng',
    )
})
