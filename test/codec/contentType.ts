import { test } from '@substrate-system/tapzero'
import type { ContentTypeName } from '../../src/contentType.js'
import { encodeContentType, decodeContentType } from '../../src/contentType.js'
import { createRoundtripTest } from './roundtrip.js'

const roundtrip = createRoundtripTest(encodeContentType, decodeContentType)

test('contentType roundtrip minimal', (t) => {
    roundtrip(t, 'application' as ContentTypeName, 'should roundtrip application content type')
})

test('contentType roundtrip nontrivial', (t) => {
    roundtrip(t, 'commit' as ContentTypeName, 'should roundtrip commit content type')
})
