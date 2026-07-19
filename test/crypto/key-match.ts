import type { ClientState } from '../../src/client-state.js'
import type { CiphersuiteImpl } from '../../src/crypto/ciphersuite.js'
import type { Hpke } from '../../src/crypto/hpke.js'
import type { Signature } from '../../src/crypto/signature.js'
import { getHpkePublicKey } from '../../src/ratchet-tree.js'

export async function hpkeKeysMatch (
    publicKey:Uint8Array,
    privateKey:Uint8Array,
    hpke:Hpke
):Promise<boolean> {
    const encoder = new TextEncoder()
    const plaintext = encoder.encode('test')
    const info = encoder.encode('key check')

    const { ct, enc } = await hpke.seal(
        await hpke.importPublicKey(publicKey), plaintext, info)

    const decrypted = await hpke.open(
        await hpke.importPrivateKey(privateKey), enc, ct, info)

    return new TextDecoder().decode(decrypted) === 'test'
}

export async function signatureKeysMatch (
    publicKey:Uint8Array,
    privateKey:Uint8Array,
    s:Signature,
):Promise<boolean> {
    const testMessage = new TextEncoder().encode('test')
    const signature = await s.sign(privateKey, testMessage)
    return s.verify(publicKey, testMessage, signature)
}

export async function checkHpkeKeysMatch (
    group:ClientState,
    impl:CiphersuiteImpl,
    t:any
):Promise<void> {
    for (const [nodeIndex, privateKey] of Object.entries(
        group.privatePath.privateKeys
    )) {
        const pub = getHpkePublicKey(group.ratchetTree[Number(nodeIndex)]!)
        const x = await hpkeKeysMatch(pub, privateKey, impl.hpke)
        t.ok(x, `HPKE keys should match for node ${nodeIndex}`)
    }
}
