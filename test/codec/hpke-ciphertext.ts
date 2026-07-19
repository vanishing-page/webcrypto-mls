import { test } from '@substrate-system/tapzero'
import type { HPKECiphertext } from '../../src/hpke-ciphertext.js'
import {
    encodeHpkeCiphertext,
    decodeHpkeCiphertext
} from '../../src/hpke-ciphertext.js'
import { createRoundtripTest } from './roundtrip.js'

const dummy:HPKECiphertext = {
    kemOutput: new Uint8Array([1, 2, 3]),
    ciphertext: new Uint8Array([4, 5, 6]),
}

const roundtrip = createRoundtripTest(
    encodeHpkeCiphertext,
    decodeHpkeCiphertext
)

test('hpkeCiphertext roundtrip', (t) => {
    roundtrip(t, dummy, 'should roundtrip HPKE ciphertext')
})
