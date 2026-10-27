import type { Capabilities } from './capabilities.js'
import type { Credential } from './credential.js'
import type { CiphersuiteImpl } from './crypto/ciphersuite.js'
import { getCiphersuiteFromName } from './crypto/ciphersuite.js'
import type { SignatureSecretKey } from './crypto/signature.js'
import type { Extension } from './extension.js'
import { UsageError } from './mls-error.js'

/**
 * A signature key pair in either form the library accepts: the bytes
 * `cs.signature.keygen()` returns, or a WebCrypto `CryptoKeyPair`
 * (Ed25519 only, as with `GenerateKeyPackageOptions.signatureKeyPair`).
 */
export type SignatureKeyPair =
    | { publicKey:Uint8Array; signKey:SignatureSecretKey }
    | CryptoKeyPair

/**
 * Optional changes to the member's own leaf node. A field left out keeps
 * the value the leaf has now.
 */
export interface LeafNodePatch {
    credential?:Credential
    signatureKeyPair?:SignatureKeyPair
    capabilities?:Capabilities
    extensions?:Extension[]
}

/**
 * The patch with its key pair reduced to the public key bytes the leaf
 * carries and the secret key that signs for it.
 */
export interface ResolvedLeafNodePatch {
    credential?:Credential
    signature?:{ publicKey:Uint8Array; signKey:SignatureSecretKey }
    capabilities?:Capabilities
    extensions?:Extension[]
}

function isCryptoKeyPair (keys:SignatureKeyPair):keys is CryptoKeyPair {
    return 'privateKey' in keys
}

export async function resolveSignatureKeyPair (
    keys:SignatureKeyPair,
    cs:CiphersuiteImpl,
):Promise<{ publicKey:Uint8Array; signKey:SignatureSecretKey }> {
    if (!isCryptoKeyPair(keys)) return keys

    const alg = getCiphersuiteFromName(cs.name).signature
    if (alg !== 'Ed25519') {
        throw new UsageError(
            'signatureKeyPair is only supported for Ed25519 ' +
            `ciphersuites, not ${alg}`,
        )
    }

    const publicKey = new Uint8Array(
        await globalThis.crypto.subtle.exportKey('raw', keys.publicKey),
    )

    return { publicKey, signKey: keys.privateKey }
}

export async function resolveLeafNodePatch (
    patch:LeafNodePatch,
    cs:CiphersuiteImpl,
):Promise<ResolvedLeafNodePatch> {
    const { signatureKeyPair, ...rest } = patch

    return signatureKeyPair === undefined ?
        rest :
        {
            ...rest,
            signature: await resolveSignatureKeyPair(signatureKeyPair, cs),
        }
}
