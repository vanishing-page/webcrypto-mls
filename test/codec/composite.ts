import { test } from '@substrate-system/tapzero'
import { randomBytes } from '@noble/hashes/utils.js'
import {
    decodeUint16,
    decodeUint32,
    decodeUint8,
    encodeUint16,
    encodeUint32,
    encodeUint8,
} from '../../src/codec/number.js'
import type { Decoder } from '../../src/codec/tlsDecoder.js'
import { mapDecoders } from '../../src/codec/tlsDecoder.js'
import type { Encoder } from '../../src/codec/tlsEncoder.js'
import { composeEncoders } from '../../src/codec/tlsEncoder.js'
import { decodeVarLenData, encodeVarLenData } from '../../src/codec/variableLength.js'
import { decodeOptional, encodeOptional } from '../../src/codec/optional.js'
import type { Test } from '@substrate-system/tapzero'

test('composite codec roundtrip [uint8(0), uint32(48948430)]', (t) => {
    compositeRoundTrip(t, 0, 48948430, encodeUint8, decodeUint8, encodeUint32, decodeUint32)
})

test('composite codec roundtrip [uint16(256), randombytes(16)]', (t) => {
    compositeRoundTrip(t, 256, randomBytes(16), encodeUint16, decodeUint16, encodeVarLenData, decodeVarLenData)
})

test('composite codec roundtrip [randombytes(100), randombytes(16)]', (t) => {
    compositeRoundTrip(
        t,
        randomBytes(100),
        randomBytes(16),
        encodeVarLenData,
        decodeVarLenData,
        encodeVarLenData,
        decodeVarLenData,
    )
})

test('composite codec roundtrip [randombytes(100), optional randombytes(16)]', (t) => {
    compositeRoundTrip(
        t,
        randomBytes(100),
        randomBytes(16),
        encodeVarLenData,
        decodeVarLenData,
        encodeOptional(encodeVarLenData),
        decodeOptional(decodeVarLenData),
    )
})

test('composite codec roundtrip [randombytes(100), undefined]', (t) => {
    compositeRoundTrip(
        t,
        randomBytes(100),
        undefined,
        encodeVarLenData,
        decodeVarLenData,
        encodeOptional(encodeVarLenData),
        decodeOptional(decodeVarLenData),
    )
})

test('composite codec roundtrip [undefined, uint8(0)]', (t) => {
    compositeRoundTrip(
        t,
        undefined,
        0,
        encodeOptional(encodeVarLenData),
        decodeOptional(decodeVarLenData),
        encodeUint8,
        decodeUint8,
    )
})

test('composite codec roundtrip [undefined, uint16(128)]', (t) => {
    compositeRoundTrip(
        t,
        undefined,
        128,
        encodeOptional(encodeUint32),
        decodeOptional(decodeUint32),
        encodeUint16,
        decodeUint16,
    )
})

test('composite codec roundtrip [randombytes(8), undefined, uint32(99999)]', (t) => {
    compositeRoundTrip3(
        t,
        randomBytes(8),
        undefined,
        99999,
        encodeVarLenData,
        decodeVarLenData,
        encodeOptional(encodeUint32),
        decodeOptional(decodeUint32),
        encodeUint32,
        decodeUint32,
    )
})

test('composite codec roundtrip [uint8(0), undefined, undefined, randomBytes(128)]', (t) => {
    compositeRoundTrip4(
        t,
        0,
        undefined,
        undefined,
        randomBytes(8),
        encodeUint8,
        decodeUint8,
        encodeOptional(encodeUint8),
        decodeOptional(decodeUint8),
        encodeOptional(encodeUint32),
        decodeOptional(decodeUint32),
        encodeVarLenData,
        decodeVarLenData,
    )
})

test('composite codec roundtrip [undefined, undefined, undefined, randomBytes(999)]', (t) => {
    compositeRoundTrip4(
        t,
        undefined,
        undefined,
        undefined,
        randomBytes(999),
        encodeOptional(encodeUint8),
        decodeOptional(decodeUint8),
        encodeOptional(encodeUint8),
        decodeOptional(decodeUint8),
        encodeOptional(encodeUint32),
        decodeOptional(decodeUint32),
        encodeVarLenData,
        decodeVarLenData,
    )
})

test('composite codec roundtrip [randomBytes(999), randomBytes(999), undefined, randomBytes(999)]', (t) => {
    compositeRoundTrip4(
        t,
        randomBytes(999),
        randomBytes(999),
        undefined,
        randomBytes(999),
        encodeVarLenData,
        decodeVarLenData,
        encodeVarLenData,
        decodeVarLenData,
        encodeOptional(encodeUint32),
        decodeOptional(decodeUint32),
        encodeVarLenData,
        decodeVarLenData,
    )
})

function compositeRoundTrip<T, U> (testContext: Test, t: T, u: U, encT: Encoder<T>, decT: Decoder<T>, encU: Encoder<U>, decU: Decoder<U>) {
    const encoder = composeEncoders([encT, encU])
    const decoder = mapDecoders([decT, decU], (t, u) => [t, u] as const)
    const encoded = encoder([t, u])

    const decoded = decoder(encoded, 0)

    testContext.deepEqual(decoded?.[0], [t, u], 'should roundtrip composite values')
}

function compositeRoundTrip3<T, U, V> (
    testContext: Test,
    t: T,
    u: U,
    v: V,
    encT: Encoder<T>,
    decT: Decoder<T>,
    encU: Encoder<U>,
    decU: Decoder<U>,
    encV: Encoder<V>,
    decV: Decoder<V>,
) {
    const encoder = composeEncoders([encT, encU, encV])
    const decoder = mapDecoders([decT, decU, decV], (t, u, v) => [t, u, v] as const)
    const encoded = encoder([t, u, v])

    const decoded = decoder(encoded, 0)

    testContext.deepEqual(decoded?.[0], [t, u, v], 'should roundtrip composite values')
}

function compositeRoundTrip4<T, U, V, W> (
    testContext: Test,
    t: T,
    u: U,
    v: V,
    w: W,
    encT: Encoder<T>,
    decT: Decoder<T>,
    encU: Encoder<U>,
    decU: Decoder<U>,
    encV: Encoder<V>,
    decV: Decoder<V>,
    encW: Encoder<W>,
    decW: Decoder<W>,
) {
    const encoder = composeEncoders([encT, encU, encV, encW])
    const decoder = mapDecoders([decT, decU, decV, decW], (t, u, v, w) => [t, u, v, w] as const)
    const encoded = encoder([t, u, v, w])

    const decoded = decoder(encoded, 0)

    testContext.deepEqual(decoded?.[0], [t, u, v, w], 'should roundtrip composite values')
}
