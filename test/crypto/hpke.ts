import { test } from '@substrate-system/tapzero'
import type { Hpke as _Hpke } from '../../src/crypto/hpke.js'
import { makeHpke as defaultMakeHpke } from '../../src/crypto/implementation/default/makeHpke.js'
import { makeHpke as nobleMakeHpke } from '../../src/crypto/implementation/noble/makeHpke.js'
import { CryptoError } from '../../src/mlsError.js'

// Use a minimal valid algorithm config (using a likely supported one)
const hpkeAlg = {
    kem: 'DHKEM-P256-HKDF-SHA256',
    kdf: 'HKDF-SHA256',
    aead: 'AES128GCM',
} as const

test('Default hpke error handling - throws CryptoError from open (invalid ciphertext)', async (t) => {
    const hpke = await defaultMakeHpke(hpkeAlg)
    try {
        await hpke.open({} as any, new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3]))
        t.fail('should have thrown CryptoError')
    } catch (error) {
        t.ok(error instanceof CryptoError, 'should throw CryptoError from open')
    }
})

test('Default hpke error handling - throws CryptoError from importSecret (invalid kemOutput)', async (t) => {
    const hpke = await defaultMakeHpke(hpkeAlg)
    try {
        await hpke.importSecret({} as any, new Uint8Array([1]), new Uint8Array([2]), 16, new Uint8Array([3]))
        t.fail('should have thrown CryptoError')
    } catch (error) {
        t.ok(error instanceof CryptoError, 'should throw CryptoError from importSecret')
    }
})

test('Default hpke error handling - throws CryptoError from importPrivateKey (invalid key)', async (t) => {
    const hpke = await defaultMakeHpke(hpkeAlg)
    try {
        await hpke.importPrivateKey(new Uint8Array([1, 2, 3]))
        t.fail('should have thrown CryptoError')
    } catch (error) {
        t.ok(error instanceof CryptoError, 'should throw CryptoError from importPrivateKey')
    }
})

test('Default hpke error handling - throws CryptoError from importPublicKey (invalid key)', async (t) => {
    const hpke = await defaultMakeHpke(hpkeAlg)
    try {
        await hpke.importPublicKey(new Uint8Array([1, 2, 3]))
        t.fail('should have thrown CryptoError')
    } catch (error) {
        t.ok(error instanceof CryptoError, 'should throw CryptoError from importPublicKey')
    }
})

test('Default hpke error handling - throws CryptoError from decryptAead (invalid key/nonce)', async (t) => {
    const hpke = await defaultMakeHpke(hpkeAlg)
    try {
        await hpke.decryptAead(new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3]), new Uint8Array([4]))
        t.fail('should have thrown CryptoError')
    } catch (error) {
        t.ok(error instanceof CryptoError, 'should throw CryptoError from decryptAead')
    }
})

test('Default hpke happy path - can seal and open a message', async (t) => {
    const hpke = await defaultMakeHpke(hpkeAlg)
    const { publicKey, privateKey } = await hpke.generateKeyPair()
    const plaintext = new TextEncoder().encode('hello world')
    const info = new TextEncoder().encode('test info')
    const { ct, enc } = await hpke.seal(publicKey, plaintext, info)
    const decrypted = await hpke.open(privateKey, enc, ct, info)
    t.equal(new TextDecoder().decode(decrypted), 'hello world', 'should seal and open a message')
})

test('Default hpke happy path - can seal and open a message with aad', async (t) => {
    const hpke = await defaultMakeHpke(hpkeAlg)
    const { publicKey, privateKey } = await hpke.generateKeyPair()
    const plaintext = new TextEncoder().encode('hello world')
    const info = new TextEncoder().encode('test info')
    const aad = new TextEncoder().encode('additional data')
    const { ct, enc } = await hpke.seal(publicKey, plaintext, info, aad)
    const decrypted = await hpke.open(privateKey, enc, ct, info, aad)
    t.equal(new TextDecoder().decode(decrypted), 'hello world', 'should seal and open a message with aad')
})

test('Default hpke happy path - can encrypt and decrypt with AEAD', async (t) => {
    const hpke = await defaultMakeHpke(hpkeAlg)
    const key = new Uint8Array(hpke.keyLength)
    const nonce = new Uint8Array(hpke.nonceLength)
    const aad = new TextEncoder().encode('aad')
    const plaintext = new TextEncoder().encode('secret')
    const ciphertext = await hpke.encryptAead(key, nonce, aad, plaintext)
    const decrypted = await hpke.decryptAead(key, nonce, aad, ciphertext)
    t.equal(new TextDecoder().decode(decrypted), 'secret', 'should encrypt and decrypt with AEAD')
})

test('Noble hpke error handling - throws CryptoError from open (invalid ciphertext)', async (t) => {
    const hpke = await nobleMakeHpke(hpkeAlg)
    try {
        await hpke.open({} as any, new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3]))
        t.fail('should have thrown CryptoError')
    } catch (error) {
        t.ok(error instanceof CryptoError, 'should throw CryptoError from open')
    }
})

test('Noble hpke error handling - throws CryptoError from importSecret (invalid kemOutput)', async (t) => {
    const hpke = await nobleMakeHpke(hpkeAlg)
    try {
        await hpke.importSecret({} as any, new Uint8Array([1]), new Uint8Array([2]), 16, new Uint8Array([3]))
        t.fail('should have thrown CryptoError')
    } catch (error) {
        t.ok(error instanceof CryptoError, 'should throw CryptoError from importSecret')
    }
})

test('Noble hpke error handling - throws CryptoError from importPrivateKey (invalid key)', async (t) => {
    const hpke = await nobleMakeHpke(hpkeAlg)
    try {
        await hpke.importPrivateKey(new Uint8Array([1, 2, 3]))
        t.fail('should have thrown CryptoError')
    } catch (error) {
        t.ok(error instanceof CryptoError, 'should throw CryptoError from importPrivateKey')
    }
})

test('Noble hpke error handling - throws CryptoError from importPublicKey (invalid key)', async (t) => {
    const hpke = await nobleMakeHpke(hpkeAlg)
    try {
        await hpke.importPublicKey(new Uint8Array([1, 2, 3]))
        t.fail('should have thrown CryptoError')
    } catch (error) {
        t.ok(error instanceof CryptoError, 'should throw CryptoError from importPublicKey')
    }
})

test('Noble hpke error handling - throws CryptoError from decryptAead (invalid key/nonce)', async (t) => {
    const hpke = await nobleMakeHpke(hpkeAlg)
    try {
        await hpke.decryptAead(new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3]), new Uint8Array([4]))
        t.fail('should have thrown CryptoError')
    } catch (error) {
        t.ok(error instanceof CryptoError, 'should throw CryptoError from decryptAead')
    }
})

test('Noble hpke happy path - can seal and open a message', async (t) => {
    const hpke = await nobleMakeHpke(hpkeAlg)
    const { publicKey, privateKey } = await hpke.generateKeyPair()
    const plaintext = new TextEncoder().encode('hello world')
    const info = new TextEncoder().encode('test info')
    const { ct, enc } = await hpke.seal(publicKey, plaintext, info)
    const decrypted = await hpke.open(privateKey, enc, ct, info)
    t.equal(new TextDecoder().decode(decrypted), 'hello world', 'should seal and open a message')
})

test('Noble hpke happy path - can encrypt and decrypt with AEAD', async (t) => {
    const hpke = await nobleMakeHpke(hpkeAlg)
    const key = new Uint8Array(hpke.keyLength)
    const nonce = new Uint8Array(hpke.nonceLength)
    const aad = new TextEncoder().encode('aad')
    const plaintext = new TextEncoder().encode('secret')
    const ciphertext = await hpke.encryptAead(key, nonce, aad, plaintext)
    const decrypted = await hpke.decryptAead(key, nonce, aad, ciphertext)
    t.equal(new TextDecoder().decode(decrypted), 'secret', 'should encrypt and decrypt with AEAD')
})

test('Noble hpke happy path - can seal and open a message with aad', async (t) => {
    const hpke = await nobleMakeHpke(hpkeAlg)
    const { publicKey, privateKey } = await hpke.generateKeyPair()
    const plaintext = new TextEncoder().encode('hello world')
    const info = new TextEncoder().encode('test info')
    const aad = new TextEncoder().encode('additional data')
    const { ct, enc } = await hpke.seal(publicKey, plaintext, info, aad)
    const decrypted = await hpke.open(privateKey, enc, ct, info, aad)
    t.equal(new TextDecoder().decode(decrypted), 'hello world', 'should seal and open a message with aad')
})
