import { test } from '@substrate-system/tapzero'
import type { Capabilities } from '../../src/capabilities.js'
import {
    encodeCapabilities,
    decodeCapabilities
} from '../../src/capabilities.js'
import { createRoundtripTest } from './roundtrip.js'

const roundtrip = createRoundtripTest(
    encodeCapabilities,
    decodeCapabilities
)

test('capabilities roundtrip minimal', (t) => {
    const c:Capabilities = {
        versions: [],
        ciphersuites: [],
        extensions: [],
        proposals: [],
        credentials: [],
    }
    roundtrip(t, c, 'should roundtrip minimal capabilities')
})

test('capabilities roundtrip nontrivial', (t) => {
    const c:Capabilities = {
        versions: ['mls10'],
        ciphersuites: [
            'MLS_256_XWING_AES256GCM_SHA512_Ed25519'
        ],
        extensions: [8, 9],
        proposals: [10, 21],
        credentials: ['basic', 'x509'],
    }
    roundtrip(t, c, 'should roundtrip nontrivial capabilities')
})
