import { test } from '@substrate-system/tapzero'
import {
    isLowOrderX25519,
    isLowOrderX448,
    isLowOrderKemPublicKey,
} from '../../src/crypto/small-order.js'
import { x25519 } from '@noble/curves/ed25519.js'
import { x448 } from '@noble/curves/ed448.js'
import type { KemAlgorithm } from '../../src/crypto/kem.js'

// Keys are written as little-endian hex, the wire order, so each value
// below is an independent literal rather than something the helper's
// own decoding produced.
function hex (s:string):Uint8Array {
    return Uint8Array.from(s.match(/../g)!, (h) => parseInt(h, 16))
}

function zeros (n:number):string {
    return '00'.repeat(n)
}

function ffs (n:number):string {
    return 'ff'.repeat(n)
}

// The X25519 low-order u values: 0, 1, p - 1 and the two order-8 points.
const X25519_LOW_ORDER:Record<string, string> = {
    'u = 0': zeros(32),
    'u = 1': '01' + zeros(31),
    'u = p - 1': 'ec' + ffs(30) + '7f',
    'order-8 u (1)':
        'e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800',
    'order-8 u (2)':
        '5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157',
}

function withTopBit (key:Uint8Array):Uint8Array {
    const out = key.slice()
    out[31]! |= 0x80
    return out
}

test('X25519: each low-order u value is low order', (t) => {
    for (const [name, h] of Object.entries(X25519_LOW_ORDER)) {
        t.equal(isLowOrderX25519(hex(h)), true, name)
    }
})

test('X25519: the top bit of the last byte is masked', (t) => {
    for (const [name, h] of Object.entries(X25519_LOW_ORDER)) {
        t.equal(isLowOrderX25519(withTopBit(hex(h))), true,
            name + ', top bit set')
    }
})

// u + p fits in 255 bits only for u = 0 and u = 1; p - 1 and the
// order-8 values overflow, so their only alternate form is the top bit.
const X25519_NON_CANONICAL:Record<string, string> = {
    'u = 0 + p': 'ed' + ffs(30) + '7f',
    'u = 1 + p': 'ee' + ffs(30) + '7f',
}

test('X25519: a non-canonical encoding of a low-order u', (t) => {
    for (const [name, h] of Object.entries(X25519_NON_CANONICAL)) {
        t.equal(isLowOrderX25519(hex(h)), true, name)
    }
})

// X448: p = 2^448 - 2^224 - 1, so p is 28 bytes of ff, then fe, then
// 27 more ff, little-endian. The low-order u values are 0, 1, p - 1;
// 0 + p and 1 + p still fit in 56 bytes.
const X448_LOW_ORDER:Record<string, string> = {
    'u = 0': zeros(56),
    'u = 1': '01' + zeros(55),
    'u = p - 1': 'fe' + ffs(27) + 'fe' + ffs(27),
    'u = 0 + p': ffs(28) + 'fe' + ffs(27),
    'u = 1 + p': zeros(28) + ffs(28),
}

test('X448: each low-order u value, and its non-canonical form', (t) => {
    for (const [name, h] of Object.entries(X448_LOW_ORDER)) {
        t.equal(isLowOrderX448(hex(h)), true, name)
    }
})

test('a freshly generated X25519 or X448 key is not low order', (t) => {
    t.equal(isLowOrderX25519(x25519.keygen().publicKey), false, 'X25519')
    t.equal(isLowOrderX448(x448.keygen().publicKey), false, 'X448')
})

test('a key of the wrong length is not low order', (t) => {
    // u = 0 at one byte short and one byte long: the value would match,
    // so only the length check can answer false.
    t.equal(isLowOrderX25519(new Uint8Array(31)), false, 'X25519, 31')
    t.equal(isLowOrderX25519(new Uint8Array(33)), false, 'X25519, 33')
    t.equal(isLowOrderX25519(new Uint8Array(1)), false, 'X25519, 1')
    t.equal(isLowOrderX448(new Uint8Array(55)), false, 'X448, 55')
    t.equal(isLowOrderX448(new Uint8Array(57)), false, 'X448, 57')
    t.equal(isLowOrderX448(new Uint8Array(32)), false, 'X448, 32')
})

// A Record so that a KEM added to the type must be classified here.
const KEM_CURVE:Record<KemAlgorithm, 'x25519'|'x448'|null> = {
    'DHKEM-X25519-HKDF-SHA256': 'x25519',
    'DHKEM-X448-HKDF-SHA512': 'x448',
    'DHKEM-P256-HKDF-SHA256': null,
    'DHKEM-P384-HKDF-SHA384': null,
    'DHKEM-P521-HKDF-SHA512': null,
    'ML-KEM-512': null,
    'ML-KEM-768': null,
    'ML-KEM-1024': null,
    'X-Wing': null,
}

test('the KEM dispatcher routes the two Montgomery KEMs', (t) => {
    t.equal(isLowOrderKemPublicKey('DHKEM-X25519-HKDF-SHA256',
        hex(X25519_LOW_ORDER['u = 0']!)), true, 'X25519, u = 0')
    t.equal(isLowOrderKemPublicKey('DHKEM-X25519-HKDF-SHA256',
        x25519.keygen().publicKey), false, 'X25519, fresh key')
    t.equal(isLowOrderKemPublicKey('DHKEM-X448-HKDF-SHA512',
        hex(X448_LOW_ORDER['u = 0']!)), true, 'X448, u = 0')
    t.equal(isLowOrderKemPublicKey('DHKEM-X448-HKDF-SHA512',
        x448.keygen().publicKey), false, 'X448, fresh key')
})

test('the KEM dispatcher answers false for NIST and PQ KEMs', (t) => {
    // Inputs a Montgomery check would refuse, plus odd lengths: none
    // of them may be called low order under a KEM without the check.
    const inputs = [
        new Uint8Array(0),
        new Uint8Array(1),
        ...Object.values(X25519_LOW_ORDER).map(hex),
        ...Object.values(X448_LOW_ORDER).map(hex),
        hex('04' + ffs(64)),
        new Uint8Array(1216),
    ]
    for (const [alg, curve] of Object.entries(KEM_CURVE)) {
        if (curve !== null) continue
        for (const key of inputs) {
            t.equal(isLowOrderKemPublicKey(alg as KemAlgorithm, key),
                false, `${alg}, ${key.length} bytes`)
        }
    }
})
