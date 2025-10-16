import { test } from '@substrate-system/tapzero'
import json from '../../test_vectors/psk_secret.json'
import type { CiphersuiteId, CiphersuiteImpl } from '../../src/crypto/ciphersuite.js'
import { getCiphersuiteFromId } from '../../src/crypto/ciphersuite.js'
import { getCiphersuiteImpl } from '../../src/crypto/getCiphersuiteImpl.js'
import type { PreSharedKeyIdExternal } from '../../src/presharedkey.js'
import { computePskSecret } from '../../src/presharedkey.js'
import { bytesToHex, hexToBytes } from '@noble/ciphers/utils.js'

for (const [index, x] of json.map((x, index) => [index, x] as [number, typeof x])) {
    test(`psk_secret test vectors ${index}`, async (t) => {
        const impl = await getCiphersuiteImpl(getCiphersuiteFromId(x.cipher_suite as CiphersuiteId))
        await testPskSecret(t, x.psk_secret, x.psks, impl)
    })
}

type Psk = {
  psk_id: string
  psk: string
  psk_nonce: string
}

function toExternalPsk (p: Psk): [PreSharedKeyIdExternal, Uint8Array] {
    return [{ psktype: 'external', pskId: hexToBytes(p.psk_id), pskNonce: hexToBytes(p.psk_nonce) }, hexToBytes(p.psk)]
}

async function testPskSecret (t: any, secret: string, psks: Psk[], impl: CiphersuiteImpl) {
    const computedSecret = await computePskSecret(psks.map(toExternalPsk), impl)
    t.equal(bytesToHex(computedSecret), secret, 'computed secret should match expected')
}
