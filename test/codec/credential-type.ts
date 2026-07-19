import { test } from '@substrate-system/tapzero'
import type { CredentialTypeName } from '../../src/credential-type.js'
import {
    encodeCredentialType,
    decodeCredentialType
} from '../../src/credential-type.js'
import { createRoundtripTest } from './roundtrip.js'

const roundtrip = createRoundtripTest(
    encodeCredentialType,
    decodeCredentialType
)

test('credentialType roundtrip basic', (t) => {
    roundtrip(t, 'basic' as CredentialTypeName, 'should roundtrip basic credential type')
})

test('credentialType roundtrip x509', (t) => {
    roundtrip(t, 'x509' as CredentialTypeName, 'should roundtrip x509 credential type')
})
