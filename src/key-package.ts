import type { Decoder } from './codec/tls-decoder.js'
import { mapDecoders } from './codec/tls-decoder.js'
import type { Encoder } from './codec/tls-encoder.js'
import { contramapEncoders } from './codec/tls-encoder.js'
import { decodeVarLenData, decodeVarLenType, encodeVarLenData, encodeVarLenType } from './codec/variable-length.js'
import type { CiphersuiteImpl, CiphersuiteName } from './crypto/ciphersuite.js'
import { decodeCiphersuite, encodeCiphersuite, getCiphersuiteFromName } from './crypto/ciphersuite.js'
import type { Hash } from './crypto/hash.js'
import { refhash } from './crypto/hash.js'
import type { Signature, SignatureSecretKey } from './crypto/signature.js'
import { signWithLabel, verifyWithLabel } from './crypto/signature.js'
import type { Extension } from './extension.js'
import { decodeExtension, encodeExtension } from './extension.js'
import type { ProtocolVersionName } from './protocol-version.js'
import { decodeProtocolVersion, encodeProtocolVersion } from './protocol-version.js'
import type {
    LeafNodeKeyPackage,
    LeafNodeTBSKeyPackage
} from './leaf-node.js'
import {
    decodeLeafNodeKeyPackage,
    encodeLeafNode,
    signLeafNodeKeyPackage,
} from './leaf-node.js'
import type { Capabilities } from './capabilities.js'
import type { Lifetime } from './lifetime.js'
import type { Credential } from './credential.js'
import { UsageError } from './mls-error.js'

type KeyPackageTBS = {
    version:ProtocolVersionName
    cipherSuite:CiphersuiteName
    initKey:Uint8Array
    leafNode:LeafNodeKeyPackage
    extensions:Extension[]
}

export const encodeKeyPackageTBS:Encoder<KeyPackageTBS> = contramapEncoders(
    [
        encodeProtocolVersion,
        encodeCiphersuite,
        encodeVarLenData,
        encodeLeafNode,
        encodeVarLenType(encodeExtension)
    ],
    (keyPackageTBS) => [
        keyPackageTBS.version,
        keyPackageTBS.cipherSuite,
        keyPackageTBS.initKey,
        keyPackageTBS.leafNode,
        keyPackageTBS.extensions,
    ] as const,
)

export const decodeKeyPackageTBS:Decoder<KeyPackageTBS> = mapDecoders(
    [
        decodeProtocolVersion,
        decodeCiphersuite,
        decodeVarLenData,
        decodeLeafNodeKeyPackage,
        decodeVarLenType(decodeExtension),
    ],
    (version, cipherSuite, initKey, leafNode, extensions) => ({
        version,
        cipherSuite,
        initKey,
        leafNode,
        extensions,
    }),
)

export type KeyPackage = KeyPackageTBS & { signature:Uint8Array }

export const encodeKeyPackage:Encoder<KeyPackage> = contramapEncoders(
    [encodeKeyPackageTBS, encodeVarLenData],
    (keyPackage) => [keyPackage, keyPackage.signature] as const,
)

export const decodeKeyPackage:Decoder<KeyPackage> = mapDecoders(
    [decodeKeyPackageTBS, decodeVarLenData],
    (keyPackageTBS, signature) => ({
        ...keyPackageTBS,
        signature,
    }),
)

export async function signKeyPackage (tbs:KeyPackageTBS, signKey:SignatureSecretKey, s:Signature):Promise<KeyPackage> {
    return { ...tbs, signature: await signWithLabel(signKey, 'KeyPackageTBS', encodeKeyPackageTBS(tbs), s) }
}

export async function verifyKeyPackage (kp:KeyPackage, s:Signature):Promise<boolean> {
    return verifyWithLabel(kp.leafNode.signaturePublicKey, 'KeyPackageTBS', encodeKeyPackageTBS(kp), kp.signature, s)
}

export function makeKeyPackageRef (value:KeyPackage, h:Hash) {
    return refhash('MLS 1.0 KeyPackage Reference', encodeKeyPackage(value), h)
}

export interface PrivateKeyPackage {
    initPrivateKey:Uint8Array
    hpkePrivateKey:Uint8Array
    signaturePrivateKey:SignatureSecretKey
}

export interface GenerateKeyPackageOptions {
    signatureKeyPair?:CryptoKeyPair
}

export async function generateKeyPackage (
    credential:Credential,
    capabilities:Capabilities,
    lifetime:Lifetime,
    extensions:Extension[],
    cs:CiphersuiteImpl,
    options?:GenerateKeyPackageOptions,
):Promise<{ publicPackage:KeyPackage; privatePackage:PrivateKeyPackage }> {
    let signaturePublicKey:Uint8Array
    let signKey:SignatureSecretKey
    if (options?.signatureKeyPair) {
        const alg = getCiphersuiteFromName(cs.name).signature
        if (alg !== 'Ed25519') {
            throw new UsageError(
                'signatureKeyPair is only supported for Ed25519 ' +
                `ciphersuites, not ${alg}`,
            )
        }
        signaturePublicKey = new Uint8Array(
            await globalThis.crypto.subtle.exportKey(
                'raw',
                options.signatureKeyPair.publicKey,
            ),
        )
        signKey = options.signatureKeyPair.privateKey
    } else {
        const sigKeys = await cs.signature.keygen()
        signaturePublicKey = sigKeys.publicKey
        signKey = sigKeys.signKey
    }

    const initKeys = await cs.hpke.generateKeyPair()
    const hpkeKeys = await cs.hpke.generateKeyPair()

    const privatePackage = {
        initPrivateKey: await cs.hpke.exportPrivateKey(initKeys.privateKey),
        hpkePrivateKey: await cs.hpke.exportPrivateKey(hpkeKeys.privateKey),
        signaturePrivateKey: signKey,
    }

    const leafNodeTbs:LeafNodeTBSKeyPackage = {
        leafNodeSource: 'key_package',
        hpkePublicKey: await cs.hpke.exportPublicKey(hpkeKeys.publicKey),
        signaturePublicKey,
        info: { leafNodeSource: 'key_package' },
        extensions,
        credential,
        capabilities,
        lifetime,
    }

    const tbs:KeyPackageTBS = {
        version: 'mls10',
        cipherSuite: cs.name,
        initKey: await cs.hpke.exportPublicKey(initKeys.publicKey),
        leafNode: await signLeafNodeKeyPackage(leafNodeTbs, signKey, cs.signature),
        extensions,
    }

    return { publicPackage: await signKeyPackage(tbs, signKey, cs.signature), privatePackage }
}
