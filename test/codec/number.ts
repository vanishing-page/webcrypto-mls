import { test } from '@substrate-system/tapzero'
import {
    encodeUint8,
    encodeUint16,
    decodeUint8,
    decodeUint16,
    encodeUint32,
    decodeUint32,
    encodeUint64,
    decodeUint64,
} from '../../src/codec/number.js'

test('encode and decode works for uint8: 0', (t) => {
    uint8RoundTrip(t, 0)
})

test('encode and decode works for uint8: 16', (t) => {
    uint8RoundTrip(t, 16)
})

test('encode and decode works for uint8: 255', (t) => {
    uint8RoundTrip(t, 255)
})

test('encode and decode works for uint16: 0', (t) => {
    uint16RoundTrip(t, 0)
})

test('encode and decode works for uint16: 256', (t) => {
    uint16RoundTrip(t, 256)
})

test('encode and decode works for uint16: 65535', (t) => {
    uint16RoundTrip(t, 65535)
})

test('encode and decode works for uint32: 0', (t) => {
    uint32RoundTrip(t, 0)
})

test('encode and decode works for uint32: 65536', (t) => {
    uint32RoundTrip(t, 65536)
})

test('encode and decode works for uint32: 4294967295', (t) => {
    uint32RoundTrip(t, 4294967295)
})

test('encode and decode works for uint64: 0', (t) => {
    uint64RoundTrip(t, 0n)
})

test('encode and decode works for uint64: 4294967296', (t) => {
    uint64RoundTrip(t, 4294967295n)
})

test('encode and decode works for uint64: 18446744073709551615', (t) => {
    uint64RoundTrip(t, 18446744073709551615n)
})

test("decodeUint8 fails for an array that's empty", (t) => {
    t.equal(
        decodeUint8(new Uint8Array([]), 0),
        undefined,
        'should return undefined for empty array'
    )
})

test("decodeUint16 fails for an array that's too small", (t) => {
    t.equal(
        decodeUint16(new Uint8Array([0]), 0),
        undefined,
        'should return undefined for too small array'
    )
})

test("decodeUint32 fails for an array that's too small", (t) => {
    t.equal(
        decodeUint32(new Uint8Array([0, 1]), 0),
        undefined,
        'should return undefined for too small array'
    )
})

test("decodeUint64 fails for an array that's too small", (t) => {
    t.equal(
        decodeUint64(new Uint8Array([0, 1, 2, 3]), 0),
        undefined,
        'should return undefined for too small array'
    )
})

function uint8RoundTrip (t:any, num:number) {
    const encoded = encodeUint8(num)
    const decoded = decodeUint8(encoded, 0)
    t.equal(decoded?.[0], num, 'decoded value should match')
    t.equal(decoded?.[1], 1, 'decoded offset should be 1')
}

function uint16RoundTrip (t:any, num:number) {
    const encoded = encodeUint16(num)
    const decoded = decodeUint16(encoded, 0)
    t.equal(decoded?.[0], num, 'decoded value should match')
    t.equal(decoded?.[1], 2, 'decoded offset should be 2')
}

function uint32RoundTrip (t:any, num:number) {
    const encoded = encodeUint32(num)
    const decoded = decodeUint32(encoded, 0)
    t.equal(decoded?.[0], num, 'decoded value should match')
    t.equal(decoded?.[1], 4, 'decoded offset should be 4')
}

function uint64RoundTrip (t:any, num:bigint) {
    const encoded = encodeUint64(num)
    const decoded = decodeUint64(encoded, 0)
    t.deepEqual(decoded?.[0], num, 'decoded value should match')
    t.equal(decoded?.[1], 8, 'decoded offset should be 8')
}
