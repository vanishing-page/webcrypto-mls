import { test } from '@substrate-system/tapzero'
import {
    makeAead as defaultMakeAead
} from '../../src/crypto/implementation/default/make-aead.js'
import {
    makeAead as nobleMakeAead
} from '../../src/crypto/implementation/noble/make-aead.js'
import { randomBytes } from '@noble/hashes/utils.js'

const key128 = randomBytes(16)
const key256 = randomBytes(32)
const nonce = randomBytes(12)
const aad = randomBytes(12)
const plaintext = new TextEncoder().encode('Hello world!')

test('Default aead - AES128-GCM encryption and decryption', async (t) => {
    const aead = await defaultMakeAead('AES128GCM')
    const ciphertext = await aead[0]
        .encrypt(key128, nonce, new Uint8Array(), plaintext)
    const decrypted = await aead[0]
        .decrypt(key128, nonce, new Uint8Array(), ciphertext)

    t.equal(new TextDecoder().decode(decrypted), 'Hello world!',
        'should encrypt and decrypt with AES128-GCM')
})

test('Default aead - AES256-GCM encryption and decryption', async (t) => {
    const aead = await defaultMakeAead('AES256GCM')
    const ciphertext = await aead[0]
        .encrypt(key256, nonce, new Uint8Array(), plaintext)
    const decrypted = await aead[0]
        .decrypt(key256, nonce, new Uint8Array(), ciphertext)

    t.equal(new TextDecoder().decode(decrypted), 'Hello world!',
        'should encrypt and decrypt with AES256-GCM')
})

test(
    'Default aead - ChaCha20-Poly1305 encryption and decryption',
    async (t) => {
        const aead = await defaultMakeAead('CHACHA20POLY1305')
        const ciphertext = await aead[0]
            .encrypt(key256, nonce, new Uint8Array(), plaintext)
        const decrypted = await aead[0]
            .decrypt(key256, nonce, new Uint8Array(), ciphertext)

        t.equal(new TextDecoder().decode(decrypted), 'Hello world!',
            'should encrypt and decrypt with ChaCha20-Poly1305')
    }
)

test(
    'Default aead - AES128-GCM encryption and decryption with aad',
    async (t) => {
        const aead = await defaultMakeAead('AES128GCM')
        const ciphertext = await aead[0]
            .encrypt(key128, nonce, aad, plaintext)
        const decrypted = await aead[0]
            .decrypt(key128, nonce, aad, ciphertext)

        t.equal(new TextDecoder().decode(decrypted), 'Hello world!',
            'should encrypt and decrypt with AES128-GCM and aad')
    }
)

test(
    'Default aead - AES256-GCM encryption and decryption with aad',
    async (t) => {
        const aead = await defaultMakeAead('AES256GCM')
        const ciphertext = await aead[0]
            .encrypt(key256, nonce, aad, plaintext)
        const decrypted = await aead[0]
            .decrypt(key256, nonce, aad, ciphertext)

        t.equal(new TextDecoder().decode(decrypted), 'Hello world!',
            'should encrypt and decrypt with AES256-GCM and aad')
    }
)

test(
    'Default aead - ChaCha20-Poly1305 encryption and decryption with aad',
    async (t) => {
        const aead = await defaultMakeAead('CHACHA20POLY1305')
        const ciphertext = await aead[0].encrypt(key256, nonce, aad, plaintext)
        const decrypted = await aead[0].decrypt(key256, nonce, aad, ciphertext)

        t.equal(new TextDecoder().decode(decrypted), 'Hello world!',
            'should encrypt and decrypt with ChaCha20-Poly1305 and aad')
    }
)

test(
    'Noble aead implementation - AES128-GCM encryption and decryption',
    async (t) => {
        const aead = await nobleMakeAead('AES128GCM')
        const ciphertext = await aead[0]
            .encrypt(key128, nonce, new Uint8Array(), plaintext)
        const decrypted = await aead[0]
            .decrypt(key128, nonce, new Uint8Array(), ciphertext)

        t.equal(new TextDecoder().decode(decrypted),
            'Hello world!', 'should encrypt and decrypt with AES128-GCM')
    }
)

test(
    'Noble aead implementation - AES256-GCM encryption and decryption',
    async (t) => {
        const aead = await nobleMakeAead('AES256GCM')
        const ciphertext = await aead[0]
            .encrypt(key256, nonce, new Uint8Array(), plaintext)
        const decrypted = await aead[0]
            .decrypt(key256, nonce, new Uint8Array(), ciphertext)

        t.equal(new TextDecoder().decode(decrypted), 'Hello world!',
            'should encrypt and decrypt with AES256-GCM')
    }
)

test(
    'Noble aead implementation - ChaCha20-Poly1305 encryption and decryption',
    async (t) => {
        const aead = await nobleMakeAead('CHACHA20POLY1305')
        const ciphertext = await aead[0]
            .encrypt(key256, nonce, new Uint8Array(), plaintext)
        const decrypted = await aead[0]
            .decrypt(key256, nonce, new Uint8Array(), ciphertext)

        t.equal(new TextDecoder().decode(decrypted), 'Hello world!',
            'should encrypt and decrypt with ChaCha20-Poly1305')
    }
)

test(
    'Noble aead implementation - AES128-GCM encryption and decryption with aad',
    async (t) => {
        const aead = await nobleMakeAead('AES128GCM')
        const ciphertext = await aead[0]
            .encrypt(key128, nonce, aad, plaintext)
        const decrypted = await aead[0]
            .decrypt(key128, nonce, aad, ciphertext)

        t.equal(new TextDecoder().decode(decrypted), 'Hello world!',
            'should encrypt and decrypt with AES128-GCM and aad')
    }
)

test(
    'Noble aead implementation - AES256-GCM encryption and decryption with aad',
    async (t) => {
        const aead = await nobleMakeAead('AES256GCM')
        const ciphertext = await aead[0]
            .encrypt(key256, nonce, aad, plaintext)
        const decrypted = await aead[0]
            .decrypt(key256, nonce, aad, ciphertext)

        t.equal(new TextDecoder().decode(decrypted), 'Hello world!',
            'should encrypt and decrypt with AES256-GCM and aad')
    }
)

test(
    'Noble aead implementation - ChaCha20-Poly1305 encryption and decryption with aad',
    async (t) => {
        const aead = await nobleMakeAead('CHACHA20POLY1305')
        const ciphertext = await aead[0]
            .encrypt(key256, nonce, aad, plaintext)
        const decrypted = await aead[0]
            .decrypt(key256, nonce, aad, ciphertext)

        t.equal(new TextDecoder().decode(decrypted), 'Hello world!',
            'should encrypt and decrypt with ChaCha20-Poly1305 and aad')
    }
)
