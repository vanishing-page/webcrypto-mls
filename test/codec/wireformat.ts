import { test } from '@substrate-system/tapzero'
import type { WireformatName } from '../../src/wireformat.js'
import { encodeWireformat, decodeWireformat } from '../../src/wireformat.js'
import { createRoundtripTest } from './roundtrip.js'

const roundtrip = createRoundtripTest(encodeWireformat, decodeWireformat)

test('WireformatName roundtrip mls_public_message', (t) => {
    roundtrip(t, 'mls_public_message' as WireformatName, 'should roundtrip mls_public_message')
})

test('WireformatName roundtrip mls_private_message', (t) => {
    roundtrip(t, 'mls_private_message' as WireformatName, 'should roundtrip mls_private_message')
})

test('WireformatName roundtrip mls_welcome', (t) => {
    roundtrip(t, 'mls_welcome' as WireformatName, 'should roundtrip mls_welcome')
})

test('WireformatName roundtrip group_info', (t) => {
    roundtrip(t, 'mls_group_info' as WireformatName, 'should roundtrip group_info')
})

test('WireformatName roundtrip mls_key_package', (t) => {
    roundtrip(t, 'mls_key_package' as WireformatName, 'should roundtrip mls_key_package')
})
