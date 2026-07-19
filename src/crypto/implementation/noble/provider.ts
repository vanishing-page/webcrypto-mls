import type { Ciphersuite, CiphersuiteImpl } from '../../ciphersuite.js'

import { makeHashImpl } from './make-hash-impl.js'
import { makeNobleSignatureImpl } from './make-noble-signature-impl.js'
import { makeHpke } from './make-hpke.js'
import { makeKdfImpl, makeKdf } from './make-kdf-impl.js'
import { defaultRng } from './rng.js'

export const nobleCryptoProvider = {
    async getCipherSuite (cs:Ciphersuite):Promise<CiphersuiteImpl> {
        return {
            kdf: makeKdfImpl(makeKdf(cs.hpke.kdf)),
            hash: makeHashImpl(cs.hash),
            signature: await makeNobleSignatureImpl(cs.signature),
            hpke: await makeHpke(cs.hpke),
            rng: defaultRng,
            name: cs.name,
        }
    },
}
