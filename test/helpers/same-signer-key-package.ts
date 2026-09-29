import type { Credential } from '../../src/credential.js'
import type { CiphersuiteImpl } from '../../src/crypto/ciphersuite.js'
import type {
    KeyPackage,
    PrivateKeyPackage
} from '../../src/key-package.js'
import { signKeyPackage } from '../../src/key-package.js'
import type { LeafNodeTBSKeyPackage } from '../../src/leaf-node.js'
import { signLeafNodeKeyPackage } from '../../src/leaf-node.js'
import { defaultCapabilities } from '../../src/default-capabilities.js'
import { defaultLifetime } from '../../src/lifetime.js'

/**
 * A fresh KeyPackage (new init and HPKE keys) for a member who keeps
 * their signature key pair -- the shape a member of a branched group
 * presents, since RFC 9420 SS11.3 requires the branch to hold only
 * members of the old group.
 */
export async function sameSignerKeyPackage (
    credential:Credential,
    signaturePublicKey:Uint8Array,
    signaturePrivateKey:PrivateKeyPackage['signaturePrivateKey'],
    cs:CiphersuiteImpl,
):Promise<{ publicPackage:KeyPackage; privatePackage:PrivateKeyPackage }> {
    const initKeys = await cs.hpke.generateKeyPair()
    const hpkeKeys = await cs.hpke.generateKeyPair()

    const leafNodeTbs:LeafNodeTBSKeyPackage = {
        leafNodeSource: 'key_package',
        hpkePublicKey: await cs.hpke.exportPublicKey(hpkeKeys.publicKey),
        signaturePublicKey,
        info: { leafNodeSource: 'key_package' },
        extensions: [],
        credential,
        capabilities: defaultCapabilities(),
        lifetime: defaultLifetime(),
    }

    const tbs:Omit<KeyPackage, 'signature'> = {
        version: 'mls10',
        cipherSuite: cs.name,
        initKey: await cs.hpke.exportPublicKey(initKeys.publicKey),
        leafNode: await signLeafNodeKeyPackage(
            leafNodeTbs,
            signaturePrivateKey,
            cs.signature
        ),
        extensions: [],
    }

    return {
        publicPackage: await signKeyPackage(
            tbs,
            signaturePrivateKey,
            cs.signature
        ),
        privatePackage: {
            initPrivateKey: await cs.hpke.exportPrivateKey(
                initKeys.privateKey
            ),
            hpkePrivateKey: await cs.hpke.exportPrivateKey(
                hpkeKeys.privateKey
            ),
            signaturePrivateKey,
        },
    }
}
