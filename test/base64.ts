import { test } from '@substrate-system/tapzero'
import { bytesToBase64, base64ToBytes } from '../src/util/byte-array.js'

test('bytes to base 64 - empty array', (t) => {
    const result = bytesToBase64(new Uint8Array())
    t.equal(result, '', 'should convert empty array to empty string')
})

test('bytes to base 64 - simple bytes', (t) => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    const result = bytesToBase64(bytes)
    t.equal(result, 'AQIDBA==', 'should convert simple bytes to base64')
})

test('bytes to base 64 - all zeros', (t) => {
    const bytes = new Uint8Array([0, 0, 0, 0])
    const result = bytesToBase64(bytes)
    t.equal(result, 'AAAAAA==', 'should convert bytes with all zeros')
})

test('bytes to base 64 - high values', (t) => {
    const bytes = new Uint8Array([255, 255, 255, 255])
    const result = bytesToBase64(bytes)
    t.equal(result, '/////w==', 'should convert bytes with high values')
})

test('bytes to base 64 - single byte', (t) => {
    const bytes = new Uint8Array([65]) // ASCII 'A'
    const result = bytesToBase64(bytes)
    t.equal(result, 'QQ==', 'should handle single byte')
})

test('bytes to base 64 - two bytes', (t) => {
    const bytes = new Uint8Array([65, 66]) // ASCII 'AB'
    const result = bytesToBase64(bytes)
    t.equal(result, 'QUI=', 'should handle two bytes')
})

test('base64 to bytes - empty string', (t) => {
    const result = base64ToBytes('')
    t.deepEqual(
        result,
        new Uint8Array(),
        'should convert empty string to empty array'
    )
})

test('base64 to bytes - simple base64', (t) => {
    const result = base64ToBytes('AQIDBA==')
    t.deepEqual(
        result,
        new Uint8Array([1, 2, 3, 4]),
        'should convert base64 to bytes'
    )
})

test('base64 to bytes - all zeros', (t) => {
    const result = base64ToBytes('AAAAAA==')
    t.deepEqual(
        result,
        new Uint8Array([0, 0, 0, 0]),
        'should convert base64 with all zeros'
    )
})

test('base64 to bytes - high values', (t) => {
    const result = base64ToBytes('/////w==')
    t.deepEqual(
        result,
        new Uint8Array([255, 255, 255, 255]),
        'should convert base64 with high values'
    )
})

test('base64 to bytes - single character', (t) => {
    const result = base64ToBytes('QQ==')
    t.deepEqual(
        result,
        new Uint8Array([65]),
        'should handle single character'
    )
})

test('base64 to bytes - two characters', (t) => {
    const result = base64ToBytes('QUI=')
    t.deepEqual(
        result,
        new Uint8Array([65, 66]),
        'should handle two characters'
    )
})

test('base64 roundtrip', (t) => {
    const original = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    const base64 = bytesToBase64(original)
    const converted = base64ToBytes(base64)
    t.deepEqual(converted, original, 'should roundtrip correctly')
})

test('base64 to bytes - browser atob path', (t) => {
    const originalBuffer = globalThis.Buffer
    const originalAtob = globalThis.atob

    console.log('aaaaaaaaaaa', originalBuffer)

    // Simulate browser: remove Buffer and add atob
    delete globalThis.Buffer
    globalThis.atob = (str:string) => {
        return originalBuffer.from(str, 'base64').toString('binary')
    }

    const original = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    const base64 = bytesToBase64(original)
    const converted = base64ToBytes(base64)

    // Restore globals
    globalThis.Buffer = originalBuffer
    globalThis.atob = originalAtob

    t.deepEqual(
        converted,
        original,
        'should decode using browser atob when Buffer is not defined'
    )
})
