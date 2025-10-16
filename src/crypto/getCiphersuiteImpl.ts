import type { Ciphersuite, CiphersuiteImpl } from './ciphersuite.js'
import type { CryptoProvider } from './provider.js'
import { defaultCryptoProvider } from './implementation/default/provider.js'

export async function getCiphersuiteImpl (
    cs: Ciphersuite,
    provider: CryptoProvider = defaultCryptoProvider,
): Promise<CiphersuiteImpl> {
    return provider.getCiphersuiteImpl(cs)
}
