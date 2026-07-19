import { test } from '@substrate-system/tapzero'
import type { Extension } from '../../src/extension.js'
import { encodeExtension, decodeExtension } from '../../src/extension.js'
import { createRoundtripTest } from './roundtrip.js'

const roundtrip = createRoundtripTest(encodeExtension, decodeExtension)

test('extension roundtrip minimal', (t) => {
    const e:Extension = {
        extensionType: 'application_id',
        extensionData: new Uint8Array([]),
    }
    roundtrip(t, e, 'should roundtrip minimal extension')
})

test('extension roundtrip nontrivial', (t) => {
    const e:Extension = {
        extensionType: 'ratchet_tree',
        extensionData: new Uint8Array([1, 2, 3, 4]),
    }
    roundtrip(t, e, 'should roundtrip nontrivial extension')
})
