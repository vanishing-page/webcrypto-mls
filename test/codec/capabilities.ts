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

test('capabilities with an unknown protocol version round-trip', (t) => {
    // versions<V> = [mls10 (1), 2], then four empty lists
    const bytes = new Uint8Array([
        0x04, 0x00, 0x01, 0x00, 0x02,
        0x00, 0x00, 0x00, 0x00,
    ])
    const decoded = decodeCapabilities(bytes, 0)
    t.ok(decoded, 'decodes a version newer than MLS 1.0')
    if (!decoded) return
    t.equal(decoded[1], bytes.length, 'consumes every byte')
    t.deepEqual(
        encodeCapabilities(decoded[0]),
        bytes,
        're-encodes to the same bytes'
    )
})
