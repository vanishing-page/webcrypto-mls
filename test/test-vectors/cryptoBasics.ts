import { test } from '@substrate-system/tapzero'
import json from '../../test_vectors/crypto-basics.json'
import type { CiphersuiteId, CiphersuiteImpl } from '../../src/crypto/ciphersuite.js'
import { getCiphersuiteFromId } from '../../src/crypto/ciphersuite.js'
import { getCiphersuiteImpl } from '../../src/crypto/getCiphersuiteImpl.js'
import { bytesToHex, hexToBytes } from '@noble/ciphers/utils.js'
import { signWithLabel, verifyWithLabel } from '../../src/crypto/signature.js'
import { refhash } from '../../src/crypto/hash.js'
import { deriveSecret, deriveTreeSecret, expandWithLabel } from '../../src/crypto/kdf.js'
import { decryptWithLabel, encryptWithLabel } from '../../src/crypto/hpke.js'

for (const [index, x] of json.map((x, index) => [index, x] as [number, typeof x])) {
    test(`crypto-basics test vectors ${index}`, async (t) => {
        const impl = await getCiphersuiteImpl(getCiphersuiteFromId(x.cipher_suite as CiphersuiteId))
        await testRefHash(t, impl, x.ref_hash)
        await testDeriveSecret(t, impl, x.derive_secret)
        await testDeriveTreeSecret(t, impl, x.derive_tree_secret)
        await testExpandWithLabel(t, impl, x.expand_with_label)
        await testEncryptWithLabel(t, impl, x.encrypt_with_label)
        await testSignWithLabel(t, impl, x.sign_with_label)
    })
}

async function testDeriveSecret (t: any, impl: CiphersuiteImpl, o: { label: string; secret: string; out: string }) {
    // out == DeriveSecret(secret, label)
    const res = await deriveSecret(hexToBytes(o.secret), o.label, impl.kdf)
    t.equal(bytesToHex(res), o.out, 'derived secret should match expected')
}

async function testDeriveTreeSecret (
    t: any,
    impl: CiphersuiteImpl,
    o: { label: string; secret: string; generation: number; out: string },
) {
    // out == DeriveTreeSecret(secret, label, generation, length)
    const res = await deriveTreeSecret(hexToBytes(o.secret), o.label, o.generation, impl.kdf.size, impl.kdf)
    t.equal(bytesToHex(res), o.out, 'derived tree secret should match expected')
}

async function testExpandWithLabel (
    t: any,
    impl: CiphersuiteImpl,
    o: { label: string; secret: string; length: number; context: string; out: string },
) {
    // out == ExpandWithLabel(secret, label, context, length)
    const res = await expandWithLabel(hexToBytes(o.secret), o.label, hexToBytes(o.context), o.length, impl.kdf)
    t.equal(bytesToHex(res), o.out, 'expanded label should match expected')
}

async function testRefHash (t: any, impl: CiphersuiteImpl, o: { label: string; value: string; out: string }) {
    // out == RefHash(label, value)
    const res = await refhash(o.label, hexToBytes(o.value), impl.hash)
    t.equal(bytesToHex(res), o.out, 'refhash should match expected')
}

async function testSignWithLabel (
    t: any,
    impl: CiphersuiteImpl,
    o: { label: string; content: string; priv: string; pub: string; signature: string },
) {
    // VerifyWithLabel(pub, label, content, signature) == true
    const v = await verifyWithLabel(
        hexToBytes(o.pub),
        o.label,
        hexToBytes(o.content),
        hexToBytes(o.signature),
        impl.signature,
    )
    t.ok(v, 'signature should verify')

    // VerifyWithLabel(pub, label, content, SignWithLabel(priv, label, content)) == true
    const signature = await signWithLabel(hexToBytes(o.priv), o.label, hexToBytes(o.content), impl.signature)
    const v2 = await verifyWithLabel(hexToBytes(o.pub), o.label, hexToBytes(o.content), signature, impl.signature)
    t.ok(v2, 'generated signature should verify')
}

async function testEncryptWithLabel (
    t: any,
    impl: CiphersuiteImpl,
    o: {
    ciphertext: string
    context: string
    kem_output: string
    label: string
    plaintext: string
    priv: string
    pub: string
  },
) {
    const privateKey = await impl.hpke.importPrivateKey(hexToBytes(o.priv))
    const publicKey = await impl.hpke.importPublicKey(hexToBytes(o.pub))

    // DecryptWithLabel(priv, label, context, kem_output, ciphertext) == plaintext
    const decrypted = await decryptWithLabel(
        privateKey,
        o.label,
        hexToBytes(o.context),
        hexToBytes(o.kem_output),
        hexToBytes(o.ciphertext),
        impl.hpke,
    )

    t.equal(bytesToHex(new Uint8Array(decrypted)), o.plaintext, 'decrypted plaintext should match expected')

    // kem_output_candidate, ciphertext_candidate = EncryptWithLabel(pub, label, context, plaintext)
    const { ct: ctCandidate, enc: encCandidate } = await encryptWithLabel(
        publicKey,
        o.label,
        hexToBytes(o.context),
        hexToBytes(o.plaintext),
        impl.hpke,
    )

    // DecryptWithLabel(priv, label, context, kem_output_candidate, ciphertext_candidate) == plaintext
    const plaintext = await decryptWithLabel(
        privateKey,
        o.label,
        hexToBytes(o.context),
        encCandidate,
        ctCandidate,
        impl.hpke,
    )
    t.equal(bytesToHex(new Uint8Array(plaintext)), o.plaintext, 'roundtrip plaintext should match expected')
}
