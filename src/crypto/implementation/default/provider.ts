import type { Ciphersuite, CiphersuiteImpl } from '../../ciphersuite.js'
import { makeHashImpl } from './make-hash-impl.js'
import { makeHpke } from './make-hpke.js'
import { makeKdf, makeKdfImpl } from './make-kdf-impl.js'
import { defaultRng } from './rng.js'
import { makeSignatureImpl } from './make-signature-impl.js'

const webcrypto = globalThis.crypto

export const defaultCryptoProvider = {
    async getCipherSuite (cs:Ciphersuite):Promise<CiphersuiteImpl> {
        const subtle = webcrypto.subtle

        return {
            kdf: makeKdfImpl(makeKdf(cs.hpke.kdf)),
            hash: makeHashImpl(subtle, cs.hash),
            signature: await makeSignatureImpl(cs.signature),
            hpke: await makeHpke(cs.hpke),
            rng: defaultRng,
            name: cs.name,
        }
    },
}
