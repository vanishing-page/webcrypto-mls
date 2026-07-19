import type { Ciphersuite, CiphersuiteImpl } from './ciphersuite.js'

export interface CryptoProvider {
    getCipherSuite(cs:Ciphersuite):Promise<CiphersuiteImpl>
}
