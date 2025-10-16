import { test } from '@substrate-system/tapzero'
import { encodeLifetime, decodeLifetime } from '../../src/lifetime.js'
import { createRoundtripTest } from './roundtrip.js'

const roundtrip = createRoundtripTest(encodeLifetime, decodeLifetime)

test('Lifetime roundtrip minimal', (t) => {
    roundtrip(t, { notBefore: 0n, notAfter: 0n }, 'should roundtrip minimal Lifetime')
})

test('Lifetime roundtrip nontrivial', (t) => {
    roundtrip(t, { notBefore: 123456789n, notAfter: 987654321n }, 'should roundtrip nontrivial Lifetime')
})
