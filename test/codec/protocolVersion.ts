import { test } from '@substrate-system/tapzero'
import type { ProtocolVersionName } from '../../src/protocolVersion.js'
import { encodeProtocolVersion, decodeProtocolVersion } from '../../src/protocolVersion.js'
import { createRoundtripTest } from './roundtrip.js'

const roundtrip = createRoundtripTest(encodeProtocolVersion, decodeProtocolVersion)

test('ProtocolVersionName roundtrip mls10', (t) => {
    roundtrip(t, 'mls10' as ProtocolVersionName, 'should roundtrip mls10')
})
