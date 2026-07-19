import { CipherSuite } from '@hpke/core'
import type { Hpke, HpkeAlgorithm } from '../../hpke.js'
import { makeGenericHpke } from '../hpke.js'
import { makeAead } from './make-aead.js'
import { makeKdf } from './make-kdf-impl.js'
import { makeDhKem } from './make-dh-kem.js'

export async function makeHpke (hpkealg:HpkeAlgorithm):Promise<Hpke> {
    const [aead, aeadInterface] = await makeAead(hpkealg.aead)
    const cs = new CipherSuite({
        kem: await makeDhKem(hpkealg.kem),
        kdf: makeKdf(hpkealg.kdf),
        aead: aeadInterface,
    })

    return makeGenericHpke(hpkealg, aead, cs)
}
