import { test } from '@substrate-system/tapzero'
import { randomBytes } from '@noble/hashes/utils.js'
import {
    decodeVarLenData,
    decodeVarLenType,
    determineLength,
    encodeLength,
    encodeVarLenData,
    encodeVarLenType,
} from '../../src/codec/variable-length.js'
import { createRoundtripTest } from './roundtrip.js'
import type { Encoder } from '../../src/codec/tls-encoder.js'
import type { Decoder } from '../../src/codec/tls-decoder.js'
import {
    decodeUint64,
    decodeUint8,
    encodeUint64,
    encodeUint8
} from '../../src/codec/number.js'
import {
    decodeOptional,
    encodeOptional
} from '../../src/codec/optional.js'
import { CodecError as _CodecError } from '../../src/mls-error.js'

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

test(
    'varLength encode and decode works for array of uint64',
    (t) => {
        arrayRoundtrip(
            t, encodeUint64, decodeUint64,
            [1n, 2n, 3n, 4n, 5n, 18446744073709551615n]
        )
    }
)

test(
    'varLength encode and decode works for array of optional random bytes',
    (t) => {
        arrayRoundtrip(
            t,
            encodeOptional(encodeVarLenData),
            decodeOptional(decodeVarLenData),
            [
                randomBytes(99),
                undefined,
                randomBytes(99),
                undefined,
                undefined,
                randomBytes(99),
                randomBytes(99),
            ]
        )
    }
)

test("varLength decode doesn't work if offset is too large", (t) => {
    t.throws(
        () => decodeVarLenData(new Uint8Array(0), 2),
        'should throw for too large offset'
    )
})

test(
    "varLength determineLength doesn't work if offset is too large",
    (t) => {
        t.throws(
            () => determineLength(new Uint8Array(0), 2),
            'should throw for too large offset'
        )
    }
)

test(
    "varLength determineLength doesn't work if prefix is too large",
    (t) => {
        t.throws(
            () => determineLength(encodeLength(50000000000), 1),
            'should throw for too large prefix'
        )
    }
)

test(
    "varLength determineLength doesn't work if offset is ffsd large",
    (t) => {
        t.throws(
            () => determineLength(new Uint8Array([0xff, 0xff]), 0),
            'should throw for invalid offset'
        )
    }
)

test("varLength decode doesn't work if length is too large", (t) => {
    const e = encodeVarLenData(randomBytes(64))
    e[1] = 0xff
    t.throws(() => decodeVarLenData(e, 0), 'should throw for too large length')
})

test(
    'varLength determineLength rejects non-minimal 2-byte encoding of a ' +
    '1-byte value',
    (t) => {
        // prefix 01, value 5 -- fits in the 1-byte (00) form
        const overlong = new Uint8Array([0b01000000, 5])
        t.throws(
            () => determineLength(overlong, 0),
            'should throw for non-minimal 2-byte length'
        )
    }
)

test(
    'varLength determineLength rejects non-minimal 4-byte encoding of a ' +
    '1-byte value',
    (t) => {
        // prefix 10, value 5 -- fits in the 1-byte (00) form
        const overlong = new Uint8Array([0b10000000, 0, 0, 5])
        t.throws(
            () => determineLength(overlong, 0),
            'should throw for non-minimal 4-byte length'
        )
    }
)

test(
    'varLength determineLength rejects non-minimal 4-byte encoding of a ' +
    '2-byte value',
    (t) => {
        // prefix 10, value 5000 -- fits in the 2-byte (01) form
        const overlong = new Uint8Array([0b10000000, 0, 0b00010011, 0b10001000])
        t.throws(
            () => determineLength(overlong, 0),
            'should throw for non-minimal 4-byte length'
        )
    }
)

test(
    'varLength determineLength accepts the minimal encoding of a boundary ' +
    'value (63, the largest 1-byte value)',
    (t) => {
        const minimal = encodeLength(63)
        const { length, lengthFieldSize } = determineLength(minimal, 0)
        t.equal(length, 63, 'should decode the correct length')
        t.equal(lengthFieldSize, 1, 'should use the 1-byte form')
    }
)

test(
    'varLength determineLength accepts the minimal encoding of a boundary ' +
    'value (16383, the largest 2-byte value)',
    (t) => {
        const minimal = encodeLength(16383)
        const { length, lengthFieldSize } = determineLength(minimal, 0)
        t.equal(length, 16383, 'should decode the correct length')
        t.equal(lengthFieldSize, 2, 'should use the 2-byte form')
    }
)

test(
    'varLength decodeVarLenData rejects data with a non-minimal length ' +
    'prefix',
    (t) => {
        const overlong = new Uint8Array([0b01000000, 5, 1, 2, 3, 4, 5])
        t.throws(
            () => decodeVarLenData(overlong, 0),
            'should throw for non-minimal length prefix'
        )
    }
)

test(
    "varLength decodeVarLenType doesn't work if underlying decoder doesn't work",
    (t) => {
        const brokenDecoder:Decoder<number> = () => undefined

        t.equal(
            decodeVarLenType(brokenDecoder)(
                encodeVarLenData(randomBytes(16)), 0
            ),
            undefined,
            'should return undefined for broken decoder'
        )
    }
)

test(
    'varLength decodeVarLenType rejects an item decoder that consumes ' +
    'zero bytes instead of hanging',
    (t) => {
        const zeroLenDecoder:Decoder<number> = (_b, _offset) => [0, 0]

        const encoded = encodeVarLenData(randomBytes(4))

        t.equal(
            decodeVarLenType(zeroLenDecoder)(encoded, 0),
            undefined,
            'should return undefined instead of looping forever'
        )
    }
)

function arrayRoundtrip<T> (
    testContext:any,
    enc:Encoder<T>,
    dec:Decoder<T>,
    ts:T[]
) {
    return createRoundtripTest(
        encodeVarLenType(enc),
        decodeVarLenType(dec)
    )(testContext, ts, 'should roundtrip array')
}
