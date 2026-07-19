import { test } from '@substrate-system/tapzero'
import json from '../../test_vectors/psk_secret.json'
import type { CiphersuiteId, CiphersuiteImpl } from '../../src/crypto/ciphersuite.js'
import { getCiphersuiteFromId } from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import type { PreSharedKeyIdExternal } from '../../src/presharedkey.js'
import { computePskSecret } from '../../src/presharedkey.js'
import { bytesToHex, hexToBytes } from '@noble/ciphers/utils.js'

for (const [index, x] of json.map((x, index) => [index, x] as [number, typeof x])) {
    test(`psk_secret test vectors ${index}`, async (t) => {
        try {
            const impl = await getCipherSuite(getCiphersuiteFromId(x.cipher_suite as CiphersuiteId))
            await testPskSecret(t, x.psk_secret, x.psks, impl)
        } catch (error:any) {
        // Skip ciphersuites not supported in the current environment (e.g., X448/Ed448 in browsers)
            if (error?.name === 'NotSupportedError' || error?.name === 'DependencyError' || error?.name === 'CryptoError' || error?.name === 'DeriveKeyPairError' || error?.message?.includes('SubtleCrypto') || error?.message?.includes('Unrecognized name')) {
                t.comment(`Skipping: ${error.message}`)
                return
            }
            throw error
        }
    })
}

type Psk = {
    psk_id:string
    psk:string
    psk_nonce:string
}

function toExternalPsk (p:Psk):[PreSharedKeyIdExternal, Uint8Array] {
    return [{ psktype: 'external', pskId: hexToBytes(p.psk_id), pskNonce: hexToBytes(p.psk_nonce) }, hexToBytes(p.psk)]
}

async function testPskSecret (t:any, secret:string, psks:Psk[], impl:CiphersuiteImpl) {
    const computedSecret = await computePskSecret(psks.map(toExternalPsk), impl)
    t.equal(bytesToHex(computedSecret), secret, 'computed secret should match expected')
}
