import { test } from '@substrate-system/tapzero'
import type { CiphersuiteId, CiphersuiteImpl } from '../../src/crypto/ciphersuite.js'
import { getCiphersuiteFromId } from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import { hexToBytes } from '@noble/ciphers/utils.js'
import json from '../../test_vectors/welcome.json'
import { decodeMlsMessage } from '../../src/message.js'
import { makeKeyPackageRef } from '../../src/key-package.js'
import { constantTimeEqual } from '../../src/util/constant-time-compare.js'
import {
    verifyGroupInfoConfirmationTag,
    verifyGroupInfoSignature
} from '../../src/group-info.js'
import { decryptGroupInfo, decryptGroupSecrets } from '../../src/welcome.js'
import type { PrivateKey } from '../../src/crypto/hpke.js'

for (const [index, x] of json.map((x, index) => [index, x] as [number, typeof x])) {
    test(`welcome test vectors ${index}`, async (t) => {
        try {
            const impl = await getCipherSuite(getCiphersuiteFromId(x.cipher_suite as CiphersuiteId))
            await testWelcome(t, x.init_priv, x.key_package, x.signer_pub, x.welcome, impl)
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

async function testWelcome (
    t:any,
    initPriv:string,
    keyPackage:string,
    signerPub:string,
    welcome:string,
    impl:CiphersuiteImpl,
) {
    const x = decodeMlsMessage(hexToBytes(welcome), 0)
    if (x === undefined || x[0].wireformat !== 'mls_welcome') throw new Error("Couldn't decode to welcome")

    const w = x[0].welcome

    const y = decodeMlsMessage(hexToBytes(keyPackage), 0)
    if (y === undefined || y[0].wireformat !== 'mls_key_package') throw new Error("Couldn't decode to key package")

    const keyPackageRef = await makeKeyPackageRef(y[0].keyPackage, impl.hash)

    const secret = w.secrets.find((s) => constantTimeEqual(s.newMember, keyPackageRef))

    if (secret === undefined) throw new Error('No matching secret found')

    const privKey:PrivateKey = await impl.hpke.importPrivateKey(hexToBytes(initPriv))
    const groupSecrets = await decryptGroupSecrets(privKey, keyPackageRef, w, impl.hpke)

    if (groupSecrets === undefined) throw new Error('Could not decrypt group secrets')

    const pskSecret = new Uint8Array(impl.kdf.size)

    const gi = await decryptGroupInfo(w, groupSecrets.joinerSecret, pskSecret, impl)
    if (gi === undefined) throw new Error('Could not decrypt group info')

    const tagOk = await verifyGroupInfoConfirmationTag(gi, groupSecrets.joinerSecret, pskSecret, impl)
    t.ok(tagOk, 'confirmation tag should be valid')

    const signatureOk = await verifyGroupInfoSignature(gi, hexToBytes(signerPub), impl.signature)
    t.ok(signatureOk, 'signature should be valid')
}
