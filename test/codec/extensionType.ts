import { test } from '@substrate-system/tapzero'
import type { DefaultExtensionTypeName } from '../../src/defaultExtensionType.js'
import {
    encodeDefaultExtensionType,
    decodeDefaultExtensionType
} from '../../src/defaultExtensionType.js'
import { createRoundtripTest } from './roundtrip.js'

const roundtrip = createRoundtripTest(encodeDefaultExtensionType, decodeDefaultExtensionType)

test('extensionType roundtrip application_id', (t) => {
    roundtrip(t, 'application_id' as DefaultExtensionTypeName, 'should roundtrip application_id extension type')
})

test('extensionType roundtrip external_senders', (t) => {
    roundtrip(t, 'external_senders' as DefaultExtensionTypeName, 'should roundtrip external_senders extension type')
})
