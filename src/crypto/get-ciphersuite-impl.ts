import type { Ciphersuite, CiphersuiteImpl } from './ciphersuite.js'
import { getCiphersuiteFromName } from './ciphersuite.js'
import type { CryptoProvider } from './provider.js'
import { defaultCryptoProvider } from './implementation/default/provider.js'

// RFC 9420's mandatory-to-implement baseline (suite 0x0001). It has
// ~128-bit security (X25519 / Ed25519 / AES-128-GCM / SHA-256) and is the
// suite every major MLS implementation supports, so it maximizes interop.
export const DEFAULT_CIPHERSUITE:Ciphersuite = getCiphersuiteFromName(
    'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519',
)

export async function getCipherSuite (
    cs:Ciphersuite = DEFAULT_CIPHERSUITE,
    provider:CryptoProvider = defaultCryptoProvider,
):Promise<CiphersuiteImpl> {
    return provider.getCipherSuite(cs)
}
