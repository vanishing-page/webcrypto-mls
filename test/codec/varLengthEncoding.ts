import { test } from '@substrate-system/tapzero'
import { randomBytes } from '@noble/hashes/utils.js'
import {
    decodeVarLenData,
    decodeVarLenType,
    determineLength,
    encodeLength,
    encodeVarLenData,
    encodeVarLenType,
} from '../../src/codec/variableLength.js'
import { createRoundtripTest } from './roundtrip.js'
import type { Encoder } from '../../src/codec/tlsEncoder.js'
import type { Decoder } from '../../src/codec/tlsDecoder.js'
import { decodeUint64, decodeUint8, encodeUint64, encodeUint8 } from '../../src/codec/number.js'
import { decodeOptional, encodeOptional } from '../../src/codec/optional.js'
import { CodecError as _CodecError } from '../../src/mlsError.js'

const varLenRoundtrip = createRoundtripTest(encodeVarLenData, decodeVarLenData)

test('varLength encode and decode works for 1 random byte', (t) => {
    varLenRoundtrip(t, randomBytes(1), 'should roundtrip 1 byte')
})

test('varLength encode and decode works for 2 random bytes', (t) => {
    varLenRoundtrip(t, randomBytes(2), 'should roundtrip 2 bytes')
})

test('varLength encode and decode works for 3 random bytes', (t) => {
    varLenRoundtrip(t, randomBytes(3), 'should roundtrip 3 bytes')
})

test('varLength encode and decode works for 4 random bytes', (t) => {
    varLenRoundtrip(t, randomBytes(4), 'should roundtrip 4 bytes')
})

test('varLength encode and decode works for 8 random bytes', (t) => {
    varLenRoundtrip(t, randomBytes(8), 'should roundtrip 8 bytes')
})

test('varLength encode and decode works for 16 random bytes', (t) => {
    varLenRoundtrip(t, randomBytes(16), 'should roundtrip 16 bytes')
})

test('varLength encode and decode works for 64 random bytes', (t) => {
    varLenRoundtrip(t, randomBytes(64), 'should roundtrip 64 bytes')
})

test('varLength encode and decode works for 256 random bytes', (t) => {
    varLenRoundtrip(t, randomBytes(256), 'should roundtrip 256 bytes')
})

test('varLength encode and decode works for 1024 random bytes', (t) => {
    varLenRoundtrip(t, randomBytes(1024), 'should roundtrip 1024 bytes')
})

test('varLength encode and decode works for 9999 random bytes', (t) => {
    varLenRoundtrip(t, randomBytes(9999), 'should roundtrip 9999 bytes')
})

test('varLength encode and decode works for 9999 random bytes', (t) => {
    varLenRoundtrip(t, randomBytes(9999), 'should roundtrip 9999 bytes')
})

test('varLength encode and decode works for array of random bytes', (t) => {
    arrayRoundtrip(t, encodeVarLenData, decodeVarLenData, [
        randomBytes(9999),
        randomBytes(9999),
        randomBytes(9999),
        randomBytes(9999),
    ])
})

test('varLength encode and decode works for array of uint8', (t) => {
    arrayRoundtrip(t, encodeUint8, decodeUint8, [1, 2, 3, 4, 5])
})

test('varLength encode and decode works for array of uint64', (t) => {
    arrayRoundtrip(t, encodeUint64, decodeUint64, [1n, 2n, 3n, 4n, 5n, 18446744073709551615n])
})

test('varLength encode and decode works for array of optional random bytes', (t) => {
    arrayRoundtrip(t, encodeOptional(encodeVarLenData), decodeOptional(decodeVarLenData), [
        randomBytes(99),
        undefined,
        randomBytes(99),
        undefined,
        undefined,
        randomBytes(99),
        randomBytes(99),
    ])
})

test("varLength decode doesn't work if offset is too large", (t) => {
    t.throws(() => decodeVarLenData(new Uint8Array(0), 2), 'should throw for too large offset')
})

test("varLength determineLength doesn't work if offset is too large", (t) => {
    t.throws(() => determineLength(new Uint8Array(0), 2), 'should throw for too large offset')
})

test("varLength determineLength doesn't work if prefix is too large", (t) => {
    t.throws(() => determineLength(encodeLength(50000000000), 1), 'should throw for too large prefix')
})

test("varLength determineLength doesn't work if offset is ffsd large", (t) => {
    t.throws(() => determineLength(new Uint8Array([0xff, 0xff]), 0), 'should throw for invalid offset')
})

test("varLength decode doesn't work if length is too large", (t) => {
    const e = encodeVarLenData(randomBytes(64))
    e[1] = 0xff
    t.throws(() => decodeVarLenData(e, 0), 'should throw for too large length')
})

test("varLength decodeVarLenType doesn't work if underlying decoder doesn't work", (t) => {
    const brokenDecoder: Decoder<number> = () => undefined

    t.equal(decodeVarLenType(brokenDecoder)(encodeVarLenData(randomBytes(16)), 0), undefined, 'should return undefined for broken decoder')
})

function arrayRoundtrip<T> (testContext: any, enc: Encoder<T>, dec: Decoder<T>, ts: T[]) {
    return createRoundtripTest(encodeVarLenType(enc), decodeVarLenType(dec))(testContext, ts, 'should roundtrip array')
}
