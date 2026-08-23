import { test } from '@substrate-system/tapzero'
import type {
    AttachmentRef,
} from '../../src/attachment/reference.js'
import {
    ATTACHMENT_REF_VERSION,
    encodeAttachmentRef,
    decodeAttachmentRef,
    validateAttachmentRef,
    refToAuthData,
    refFromAuthData,
} from '../../src/attachment/reference.js'
import { AttachmentError } from '../../src/attachment/error.js'

// AC3.3: Round-trip encoding and decoding
test('AC3.3: encode/decode AttachmentRef round-trip',
    t => {
        const ref:AttachmentRef = {
            version: ATTACHMENT_REF_VERSION,
            objectId: new TextEncoder().encode('test-object'),
            plaintextLength: BigInt(12345),
            snapshot: new Uint8Array(32).fill(0xAA),
            locator: new TextEncoder().encode('test-locator'),
        }

        const encoded = encodeAttachmentRef(ref)
        const decoded = decodeAttachmentRef(encoded)

        t.equal(
            decoded.version,
            ref.version,
            'version matches',
        )
        t.equal(
            decoded.objectId.toString(),
            ref.objectId.toString(),
            'objectId matches',
        )
        t.equal(
            decoded.plaintextLength.toString(),
            ref.plaintextLength.toString(),
            'plaintextLength matches',
        )
        t.equal(
            decoded.snapshot.toString(),
            ref.snapshot.toString(),
            'snapshot matches',
        )
        t.equal(
            decoded.locator.toString(),
            ref.locator.toString(),
            'locator matches',
        )
    },
)

// AC3.3: refToAuthData and refFromAuthData round-trip
test('AC3.3: refToAuthData/refFromAuthData round-trip',
    t => {
        const ref:AttachmentRef = {
            version: ATTACHMENT_REF_VERSION,
            objectId: new TextEncoder().encode('auth-test'),
            plaintextLength: BigInt(54321),
            snapshot: new Uint8Array(32).fill(0xBB),
            locator: new TextEncoder().encode('auth-locator'),
        }

        const encoded = refToAuthData(ref)
        const decoded = refFromAuthData(encoded)

        t.equal(
            decoded.version,
            ref.version,
            'version matches',
        )
        t.equal(
            decoded.objectId.toString(),
            ref.objectId.toString(),
            'objectId matches',
        )
        t.equal(
            decoded.plaintextLength.toString(),
            ref.plaintextLength.toString(),
            'plaintextLength matches',
        )
        t.equal(
            decoded.snapshot.toString(),
            ref.snapshot.toString(),
            'snapshot matches',
        )
        t.equal(
            decoded.locator.toString(),
            ref.locator.toString(),
            'locator matches',
        )
    },
)

// AC3.3: Truncated input rejects
test('AC3.3: truncated encoding rejects at decode',
    t => {
        const ref:AttachmentRef = {
            version: ATTACHMENT_REF_VERSION,
            objectId: new TextEncoder().encode('truncate-test'),
            plaintextLength: BigInt(999),
            snapshot: new Uint8Array(32).fill(0xCC),
            locator: new TextEncoder().encode('loc'),
        }

        const encoded = encodeAttachmentRef(ref)
        // Remove last byte
        const truncated = encoded.slice(0, -1)

        try {
            decodeAttachmentRef(truncated)
            t.ok(false, 'should throw AttachmentError')
        } catch (err) {
            t.ok(
                err instanceof AttachmentError,
                'truncated input throws AttachmentError',
            )
        }
    },
)

// AC3.3: Trailing garbage rejects
test('AC3.3: trailing garbage in encoding rejects at decode',
    t => {
        const ref:AttachmentRef = {
            version: ATTACHMENT_REF_VERSION,
            objectId: new TextEncoder().encode('garbage-test'),
            plaintextLength: BigInt(1111),
            snapshot: new Uint8Array(32).fill(0xDD),
            locator: new TextEncoder().encode('garbage-loc'),
        }

        const encoded = encodeAttachmentRef(ref)
        // Append extra byte
        const withGarbage = new Uint8Array(encoded.length + 1)
        withGarbage.set(encoded, 0)
        withGarbage[encoded.length] = 0xFF

        try {
            decodeAttachmentRef(withGarbage)
            t.ok(false, 'should throw AttachmentError')
        } catch (err) {
            t.ok(
                err instanceof AttachmentError,
                'trailing garbage throws AttachmentError',
            )
        }
    },
)

// Validation: zero-length objectId rejects
test('validation: zero-length objectId rejects at encode',
    t => {
        const ref:AttachmentRef = {
            version: ATTACHMENT_REF_VERSION,
            objectId: new Uint8Array(0),
            plaintextLength: BigInt(100),
            snapshot: new Uint8Array(32).fill(0xEE),
            locator: new TextEncoder().encode('loc'),
        }

        try {
            encodeAttachmentRef(ref)
            t.ok(false, 'should throw AttachmentError')
        } catch (err) {
            t.ok(
                err instanceof AttachmentError,
                'zero-length objectId throws AttachmentError at ' +
                'encode',
            )
        }
    },
)

// Validation: zero plaintextLength rejects
test('validation: zero plaintextLength rejects at encode',
    t => {
        const ref:AttachmentRef = {
            version: ATTACHMENT_REF_VERSION,
            objectId: new TextEncoder().encode('zero-length'),
            plaintextLength: BigInt(0),
            snapshot: new Uint8Array(32).fill(0xFF),
            locator: new TextEncoder().encode('loc'),
        }

        try {
            encodeAttachmentRef(ref)
            t.ok(false, 'should throw AttachmentError')
        } catch (err) {
            t.ok(
                err instanceof AttachmentError,
                'zero plaintextLength throws AttachmentError at ' +
                'encode',
            )
        }
    },
)

// Validation: unknown version 0 rejects
test('validation: version 0 rejects at encode',
    t => {
        const ref:AttachmentRef = {
            version: 0,
            objectId: new TextEncoder().encode('version-test'),
            plaintextLength: BigInt(500),
            snapshot: new Uint8Array(32).fill(0x11),
            locator: new TextEncoder().encode('loc'),
        }

        try {
            encodeAttachmentRef(ref)
            t.ok(false, 'should throw AttachmentError')
        } catch (err) {
            t.ok(
                err instanceof AttachmentError,
                'version 0 throws AttachmentError at encode',
            )
        }
    },
)

// Validation: unknown version 2 rejects
test('validation: version 2 rejects at encode',
    t => {
        const ref:AttachmentRef = {
            version: 2,
            objectId: new TextEncoder().encode('version-test'),
            plaintextLength: BigInt(500),
            snapshot: new Uint8Array(32).fill(0x11),
            locator: new TextEncoder().encode('loc'),
        }

        try {
            encodeAttachmentRef(ref)
            t.ok(false, 'should throw AttachmentError')
        } catch (err) {
            t.ok(
                err instanceof AttachmentError,
                'version 2 throws AttachmentError at encode',
            )
        }
    },
)

// Validation: objectId too long (> 255) rejects
test('validation: objectId length > 255 rejects at encode',
    t => {
        const ref:AttachmentRef = {
            version: ATTACHMENT_REF_VERSION,
            objectId: new Uint8Array(256).fill(0x42),
            plaintextLength: BigInt(100),
            snapshot: new Uint8Array(32).fill(0x22),
            locator: new TextEncoder().encode('loc'),
        }

        try {
            encodeAttachmentRef(ref)
            t.ok(false, 'should throw AttachmentError')
        } catch (err) {
            t.ok(
                err instanceof AttachmentError,
                'objectId > 255 bytes throws AttachmentError at ' +
                'encode',
            )
        }
    },
)

// Positive control: valid objectId at boundary (1 byte)
test('validation: objectId length 1 is valid',
    t => {
        const ref:AttachmentRef = {
            version: ATTACHMENT_REF_VERSION,
            objectId: new Uint8Array([0x42]),
            plaintextLength: BigInt(100),
            snapshot: new Uint8Array(32).fill(0x33),
            locator: new TextEncoder().encode('loc'),
        }

        const encoded = encodeAttachmentRef(ref)

        try {
            const decoded = decodeAttachmentRef(encoded)
            t.equal(
                decoded.objectId.length,
                1,
                'objectId length 1 is valid',
            )
        } catch (err) {
            t.ok(false, `should not throw for valid objectId: ${err}`)
        }
    },
)

// Positive control: valid objectId at boundary (255 bytes)
test('validation: objectId length 255 is valid',
    t => {
        const ref:AttachmentRef = {
            version: ATTACHMENT_REF_VERSION,
            objectId: new Uint8Array(255).fill(0x42),
            plaintextLength: BigInt(100),
            snapshot: new Uint8Array(32).fill(0x44),
            locator: new TextEncoder().encode('loc'),
        }

        const encoded = encodeAttachmentRef(ref)

        try {
            const decoded = decodeAttachmentRef(encoded)
            t.equal(
                decoded.objectId.length,
                255,
                'objectId length 255 is valid',
            )
        } catch (err) {
            t.ok(false, `should not throw for valid objectId: ${err}`)
        }
    },
)

// Positive control: plaintextLength > 0
test('validation: plaintextLength 1 is valid',
    t => {
        const ref:AttachmentRef = {
            version: ATTACHMENT_REF_VERSION,
            objectId: new TextEncoder().encode('valid-id'),
            plaintextLength: BigInt(1),
            snapshot: new Uint8Array(32).fill(0x55),
            locator: new TextEncoder().encode('loc'),
        }

        const encoded = encodeAttachmentRef(ref)

        try {
            const decoded = decodeAttachmentRef(encoded)
            t.equal(
                decoded.plaintextLength,
                BigInt(1),
                'plaintextLength 1 is valid',
            )
        } catch (err) {
            t.ok(false, `should not throw for valid plaintextLength: ${err}`)
        }
    },
)

// Positive control: valid version 1
test('validation: version 1 is valid',
    t => {
        const ref:AttachmentRef = {
            version: ATTACHMENT_REF_VERSION,
            objectId: new TextEncoder().encode('valid-version'),
            plaintextLength: BigInt(100),
            snapshot: new Uint8Array(32).fill(0x66),
            locator: new TextEncoder().encode('loc'),
        }

        try {
            validateAttachmentRef(ref)
            t.ok(true, 'version 1 validates successfully')
        } catch (err) {
            t.ok(false, `should not throw for version 1: ${err}`)
        }
    },
)

// IMPORTANT 3: plaintextLength range validation
test('IMPORTANT 3: plaintextLength 2^64 - 1 is valid',
    t => {
        const ref:AttachmentRef = {
            version: ATTACHMENT_REF_VERSION,
            objectId: new TextEncoder().encode('boundary-test'),
            plaintextLength: 0xFFFFFFFFFFFFFFFFn,
            snapshot: new Uint8Array(32).fill(0x77),
            locator: new TextEncoder().encode('loc'),
        }

        const encoded = encodeAttachmentRef(ref)

        try {
            const decoded = decodeAttachmentRef(encoded)
            t.equal(
                decoded.plaintextLength,
                0xFFFFFFFFFFFFFFFFn,
                'plaintextLength 2^64 - 1 is valid',
            )
        } catch (err) {
            t.ok(false, `should not throw for 2^64 - 1: ${err}`)
        }
    },
)

test('IMPORTANT 3: plaintextLength 2^64 + 5 rejects at encode',
    t => {
        const ref:AttachmentRef = {
            version: ATTACHMENT_REF_VERSION,
            objectId: new TextEncoder().encode('overflow-test'),
            plaintextLength: 0x10000000000000005n,
            snapshot: new Uint8Array(32).fill(0x88),
            locator: new TextEncoder().encode('loc'),
        }

        try {
            encodeAttachmentRef(ref)
            t.ok(false, 'encode should throw AttachmentError')
        } catch (err) {
            t.ok(
                err instanceof AttachmentError,
                'plaintextLength 2^64 + 5 throws AttachmentError at ' +
                'encode',
            )
        }
    },
)

test('IMPORTANT 3: plaintextLength 2^64 + 5 does not silently wrap',
    t => {
        const ref:AttachmentRef = {
            version: ATTACHMENT_REF_VERSION,
            objectId: new TextEncoder().encode('wrap-test'),
            plaintextLength: 0x10000000000000005n,
            snapshot: new Uint8Array(32).fill(0x89),
            locator: new TextEncoder().encode('loc'),
        }

        try {
            const encoded = encodeAttachmentRef(ref)
            // If somehow encoding bypassed validation, decoding also
            // should not silently yield 5n
            decodeAttachmentRef(encoded)
            t.ok(
                false,
                'round-trip should have thrown (encoding should ' +
                'have rejected the overflow)',
            )
        } catch (err) {
            t.ok(
                err instanceof AttachmentError,
                '2^64 + 5 rejects and does not silently wrap to 5',
            )
        }
    },
)

// IMPORTANT 4: Buffer aliasing test
test('IMPORTANT 4: decoded ref fields are not aliased to input buffer',
    t => {
        const ref:AttachmentRef = {
            version: ATTACHMENT_REF_VERSION,
            objectId: new TextEncoder().encode('alias-test'),
            plaintextLength: BigInt(12345),
            snapshot: new Uint8Array(32).fill(0x99),
            locator: new TextEncoder().encode('loc-alias'),
        }

        const encoded = encodeAttachmentRef(ref)
        const decoded = decodeAttachmentRef(encoded)

        // Mutate a byte INSIDE the snapshot field (near end of buffer)
        encoded[encoded.length - 3] = 0xFF

        // Verify snapshot is unchanged (proving it's not aliased)
        t.equal(
            decoded.snapshot[decoded.snapshot.length - 1],
            0x99,
            'snapshot[last] unchanged after buffer mutation',
        )

        // Direct buffer identity checks
        t.ok(
            decoded.objectId.buffer !== encoded.buffer,
            'objectId buffer is distinct',
        )
        t.ok(
            decoded.snapshot.buffer !== encoded.buffer,
            'snapshot buffer is distinct',
        )
        t.ok(
            decoded.locator.buffer !== encoded.buffer,
            'locator buffer is distinct',
        )
    },
)
