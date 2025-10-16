import { test } from '@substrate-system/tapzero'
import { encodeWelcome, decodeWelcome } from '../../src/welcome.js'
import { createRoundtripTest } from './roundtrip.js'

const roundtrip = createRoundtripTest(encodeWelcome, decodeWelcome)

test('Welcome roundtrip minimal', (t) => {
    roundtrip(t, {
        cipherSuite: 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519',
        secrets: [],
        encryptedGroupInfo: new Uint8Array([1]),
    }, 'should roundtrip minimal')
})

test('Welcome roundtrip nontrivial', (t) => {
    roundtrip(t, {
        cipherSuite: 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519',
        secrets: [
            {
                newMember: new Uint8Array([2, 3]),
                encryptedGroupSecrets: { kemOutput: new Uint8Array([4]), ciphertext: new Uint8Array([5, 6]) },
            },
        ],
        encryptedGroupInfo: new Uint8Array([7, 8, 9]),
    }, 'should roundtrip nontrivial')
})
