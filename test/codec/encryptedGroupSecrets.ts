import { test } from '@substrate-system/tapzero'
import { encodeEncryptedGroupSecrets, decodeEncryptedGroupSecrets } from '../../src/welcome.js'
import { createRoundtripTest } from './roundtrip.js'

const roundtrip = createRoundtripTest(encodeEncryptedGroupSecrets, decodeEncryptedGroupSecrets)

test('encryptedGroupSecrets roundtrip minimal', (t) => {
    roundtrip(t, {
        newMember: new Uint8Array([1]),
        encryptedGroupSecrets: { kemOutput: new Uint8Array([2]), ciphertext: new Uint8Array([3]) },
    }, 'should roundtrip minimal encrypted group secrets')
})

test('encryptedGroupSecrets roundtrip nontrivial', (t) => {
    roundtrip(t, {
        newMember: new Uint8Array([4, 5, 6]),
        encryptedGroupSecrets: { kemOutput: new Uint8Array([7, 8]), ciphertext: new Uint8Array([9, 10, 11]) },
    }, 'should roundtrip nontrivial encrypted group secrets')
})
