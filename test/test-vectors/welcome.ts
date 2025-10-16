import { test } from '@substrate-system/tapzero'
import type { CiphersuiteId, CiphersuiteImpl } from '../../src/crypto/ciphersuite.js'
import { getCiphersuiteFromId } from '../../src/crypto/ciphersuite.js'
import { getCiphersuiteImpl } from '../../src/crypto/getCiphersuiteImpl.js'
import { hexToBytes } from '@noble/ciphers/utils.js'
import json from '../../test_vectors/welcome.json'
import { decodeMlsMessage } from '../../src/message.js'
import { makeKeyPackageRef } from '../../src/keyPackage.js'
import { constantTimeEqual } from '../../src/util/constantTimeCompare.js'
import { verifyGroupInfoConfirmationTag, verifyGroupInfoSignature } from '../../src/groupInfo.js'
import { decryptGroupInfo, decryptGroupSecrets } from '../../src/welcome.js'
import type { PrivateKey } from '../../src/crypto/hpke.js'

for (const [index, x] of json.map((x, index) => [index, x] as [number, typeof x])) {
    test(`welcome test vectors ${index}`, async (t) => {
        const impl = await getCiphersuiteImpl(getCiphersuiteFromId(x.cipher_suite as CiphersuiteId))
        await testWelcome(t, x.init_priv, x.key_package, x.signer_pub, x.welcome, impl)
    })
}

async function testWelcome (
    t: any,
    init_priv: string,
    key_package: string,
    signer_pub: string,
    welcome: string,
    impl: CiphersuiteImpl,
) {
    const x = decodeMlsMessage(hexToBytes(welcome), 0)
    if (x === undefined || x[0].wireformat !== 'mls_welcome') throw new Error("Couldn't decode to welcome")

    const w = x[0].welcome

    const y = decodeMlsMessage(hexToBytes(key_package), 0)
    if (y === undefined || y[0].wireformat !== 'mls_key_package') throw new Error("Couldn't decode to key package")

    const keyPackageRef = await makeKeyPackageRef(y[0].keyPackage, impl.hash)

    const secret = w.secrets.find((s) => constantTimeEqual(s.newMember, keyPackageRef))

    if (secret === undefined) throw new Error('No matching secret found')

    const privKey: PrivateKey = await impl.hpke.importPrivateKey(hexToBytes(init_priv))
    const groupSecrets = await decryptGroupSecrets(privKey, keyPackageRef, w, impl.hpke)

    if (groupSecrets === undefined) throw new Error('Could not decrypt group secrets')

    const pskSecret = new Uint8Array(impl.kdf.size)

    const gi = await decryptGroupInfo(w, groupSecrets.joinerSecret, pskSecret, impl)
    if (gi === undefined) throw new Error('Could not decrypt group info')

    const tagOk = await verifyGroupInfoConfirmationTag(gi, groupSecrets.joinerSecret, pskSecret, impl)
    t.ok(tagOk, 'confirmation tag should be valid')

    const signatureOk = await verifyGroupInfoSignature(gi, hexToBytes(signer_pub), impl.signature)
    t.ok(signatureOk, 'signature should be valid')
}
