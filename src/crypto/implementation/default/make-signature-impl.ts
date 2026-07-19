import type { SignatureAlgorithm, Signature } from '../../signature.js'
import { makeNobleSignatureImpl } from './make-noble-signature-impl.js'
import { makeWebCryptoSignatureImpl } from './make-webcrypto-signature-impl.js'

/**
 * Create keypairs using WebCrypto API iff the algorithm is `Ed25519`,
 * else create via Noble package.
 * @param {SignatureAlgorithm} alg Algorithm
 * @returns {Promise<Signature>} The signing keypair
 */
export async function makeSignatureImpl (
    alg:SignatureAlgorithm,
):Promise<Signature> {
    if (alg === 'Ed25519') return makeWebCryptoSignatureImpl()
    return makeNobleSignatureImpl(alg)
}
