import { test } from '@substrate-system/tapzero'
import { decodeUint64, decodeUint8, encodeUint64, encodeUint8 } from '../../src/codec/number.js'
import { decodeOptional, encodeOptional } from '../../src/codec/optional.js'
import { randomBytes } from '@noble/hashes/utils.js'
import type { Decoder } from '../../src/codec/tlsDecoder.js'
import type { Encoder } from '../../src/codec/tlsEncoder.js'
import { decodeVarLenData, encodeVarLenData } from '../../src/codec/variableLength.js'
import type { Test } from '@substrate-system/tapzero'

test('optional codec should return single 0 byte', (t) => {
    const e = encodeOptional(encodeUint8)(undefined)
    t.deepEqual(e, new Uint8Array([0]), 'uint8 optional should encode to single 0 byte')
    const e2 = encodeOptional(encodeUint64)(undefined)
    t.deepEqual(e2, new Uint8Array([0]), 'uint64 optional should encode to single 0 byte')
    const e3 = encodeOptional(encodeVarLenData)(undefined)
    t.deepEqual(e3, new Uint8Array([0]), 'varLenData optional should encode to single 0 byte')
})

test('optional codec roundtrip uint8: 255', (t) => {
    optionalRoundTrip(t, 255, encodeUint8, decodeUint8)
})

test('optional codec roundtrip uint64: 394245935729', (t) => {
    optionalRoundTrip(t, 394245935729n, encodeUint64, decodeUint64)
})

test('optional codec roundtrip uint64: 394245935729', (t) => {
    optionalRoundTrip(t, 394245935729n, encodeUint64, decodeUint64)
})

test('optional codec roundtrip randomBytes(8)', (t) => {
    optionalRoundTrip(t, randomBytes(8), encodeVarLenData, decodeVarLenData)
})

test('optional codec roundtrip randomBytes(128)', (t) => {
    optionalRoundTrip(t, randomBytes(128), encodeVarLenData, decodeVarLenData)
})

test('optional codec roundtrip randomBytes(500)', (t) => {
    optionalRoundTrip(t, randomBytes(500), encodeVarLenData, decodeVarLenData)
})

function optionalRoundTrip<T> (testContext: Test, value: T, enc: Encoder<T>, dec: Decoder<T>) {
    const encodedOptional = encodeOptional(enc)(value)
    const encoded = enc(value)

    testContext.equal(encoded.byteLength, encodedOptional.byteLength - 1, 'optional encoding should be 1 byte longer')

    const decodedOptional = decodeOptional(dec)(encodedOptional, 0)

    testContext.deepEqual(decodedOptional?.[0], value, 'should roundtrip optional value')

    const encodedNone = encodeOptional(enc)(undefined)

    const decodedNone = decodeOptional(dec)(encodedNone, 0)

    testContext.ok(decodedNone, 'decoded none should be defined')
    testContext.equal(decodedNone?.[0], undefined, 'decoded none should be undefined')
}
