import { encodeVarLenData } from '../codec/variable-length.js'
import { concatUint8Arrays } from '../util/byte-array.js'

// Opaque signature secret key: WebCrypto CryptoKey (Ed25519) or raw seed
// bytes (all other suites). Callers never inspect the internals.
export type SignatureSecretKey = CryptoKey | Uint8Array

export interface Signature {
    sign(signKey:SignatureSecretKey, message:Uint8Array):Promise<Uint8Array>
    verify(publicKey:Uint8Array, message:Uint8Array, signature:Uint8Array):Promise<boolean>
    keygen():Promise<{ publicKey:Uint8Array; signKey:SignatureSecretKey }>
    // Wrap a raw seed into whatever this impl's sign expects.
    // Ed25519 -> imports bytes to a CryptoKey (via PKCS8, extractable:false).
    // noble suites -> returns the bytes unchanged (identity).
    importSignatureKey(seed:Uint8Array):Promise<SignatureSecretKey>
}

export type SignatureAlgorithm = 'Ed25519' | 'Ed448' | 'P256' | 'P384' | 'P521' | 'ML-DSA-87'

export async function signWithLabel (
    signKey:SignatureSecretKey,
    label:string,
    content:Uint8Array,
    s:Signature,
):Promise<Uint8Array> {
    return s.sign(
        signKey,
        concatUint8Arrays(encodeVarLenData(new TextEncoder().encode(`MLS 1.0 ${label}`)), encodeVarLenData(content)),
    )
}

export async function verifyWithLabel (
    publicKey:Uint8Array,
    label:string,
    content:Uint8Array,
    signature:Uint8Array,
    s:Signature,
):Promise<boolean> {
    return s.verify(
        publicKey,
        concatUint8Arrays(encodeVarLenData(new TextEncoder().encode(`MLS 1.0 ${label}`)), encodeVarLenData(content)),
        signature,
    )
}
