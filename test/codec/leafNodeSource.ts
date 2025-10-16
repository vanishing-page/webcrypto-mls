import { test } from '@substrate-system/tapzero'
import type { LeafNodeSourceName } from '../../src/leafNodeSource.js'
import { encodeLeafNodeSource, decodeLeafNodeSource } from '../../src/leafNodeSource.js'
import { createRoundtripTest } from './roundtrip.js'

const roundtrip = createRoundtripTest(encodeLeafNodeSource, decodeLeafNodeSource)

test('LeafNodeSourceName roundtrip key_package', (t) => {
    roundtrip(t, 'key_package' as LeafNodeSourceName, 'should roundtrip key_package')
})

test('LeafNodeSourceName roundtrip commit', (t) => {
    roundtrip(t, 'commit' as LeafNodeSourceName, 'should roundtrip commit')
})

test('LeafNodeSourceName roundtrip update', (t) => {
    roundtrip(t, 'update' as LeafNodeSourceName, 'should roundtrip update')
})
