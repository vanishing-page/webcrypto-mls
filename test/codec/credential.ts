import { test } from '@substrate-system/tapzero'
import type { Credential } from '../../src/credential.js'
import { encodeCredential, decodeCredential } from '../../src/credential.js'
import { createRoundtripTest } from './roundtrip.js'

const minimal: Credential = { credentialType: 'basic', identity: new Uint8Array([1, 2, 3]) }

const nontrivial: Credential = {
    credentialType: 'x509',
    certificates: [new Uint8Array([4, 5, 6]), new Uint8Array([7, 8, 9, 10])],
}

const roundtrip = createRoundtripTest(encodeCredential, decodeCredential)

test('credential roundtrip minimal', (t) => {
    roundtrip(t, minimal, 'should roundtrip minimal credential')
})

test('credential roundtrip nontrivial', (t) => {
    roundtrip(t, nontrivial, 'should roundtrip nontrivial credential')
})
