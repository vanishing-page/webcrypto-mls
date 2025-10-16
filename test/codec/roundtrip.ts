import type { Decoder } from '../../src/codec/tlsDecoder.js'
import type { Encoder } from '../../src/codec/tlsEncoder.js'
import type { Test } from '@substrate-system/tapzero'

export function createRoundtripTest<T> (enc: Encoder<T>, dec: Decoder<T>): (testContext: Test, value: T, message?: string) => void {
    return (testContext, value, message = 'roundtrip should succeed') => {
        const encoded = enc(value)
        const decoded = dec(encoded, 0)?.[0] as T
        testContext.deepEqual(decoded, value, message)
    }
}
