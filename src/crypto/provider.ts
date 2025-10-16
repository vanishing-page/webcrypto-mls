import type { Ciphersuite, CiphersuiteImpl } from './ciphersuite.js'

export interface CryptoProvider {
  getCiphersuiteImpl(cs: Ciphersuite): Promise<CiphersuiteImpl>
}
