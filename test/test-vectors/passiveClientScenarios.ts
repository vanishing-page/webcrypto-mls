import { test } from '@substrate-system/tapzero'
import type { CiphersuiteId, CiphersuiteImpl } from '../../src/crypto/ciphersuite.js'
import { getCiphersuiteFromId } from '../../src/crypto/ciphersuite.js'
import { getCiphersuiteImpl } from '../../src/crypto/getCiphersuiteImpl.js'
import type { KeyPackage, PrivateKeyPackage } from '../../src/keyPackage.js'
import { hexToBytes } from '@noble/ciphers/utils.js'
import jsonCommit from '../../test_vectors/passive-client-handling-commit.json'
import jsonRandom from '../../test_vectors/passive-client-random.json'
import jsonWelcome from '../../test_vectors/passive-client-welcome.json'
import { hpkeKeysMatch, signatureKeysMatch } from '../crypto/keyMatch.js'
import { decodeMlsMessage } from '../../src/message.js'
import { decodeRatchetTree } from '../../src/ratchetTree.js'

import { joinGroup, makePskIndex } from '../../src/clientState.js'
import { processPrivateMessage, processPublicMessage } from '../../src/processMessages.js'
import { bytesToBase64 } from '../../src/util/byteArray.js'

for (const [index, x] of jsonCommit.map((x, index) => [index, x] as [number, typeof x])) {
    test(`passive-client-handling-commit test vectors ${index}`, async (t) => {
        const impl = await getCiphersuiteImpl(getCiphersuiteFromId(x.cipher_suite as CiphersuiteId))
        await testPassiveClientScenario(t, x, impl)
    })
}

for (const [index, x] of jsonRandom.map((x, index) => [index, x] as [number, typeof x])) {
    test(`passive-client-random test vectors ${index}`, async (t) => {
        const impl = await getCiphersuiteImpl(getCiphersuiteFromId(x.cipher_suite as CiphersuiteId))
        await testPassiveClientScenario(t, x, impl)
    })
}

for (const [index, x] of jsonWelcome.map((x, index) => [index, x] as [number, typeof x])) {
    test(`passive-client-welcome test vectors ${index}`, async (t) => {
        const impl = await getCiphersuiteImpl(getCiphersuiteFromId(x.cipher_suite as CiphersuiteId))
        await testPassiveClientScenario(t, x, impl)
    })
}

async function testPassiveClientScenario (t: any, data: MlsGroupState, impl: CiphersuiteImpl) {
    const kp = decodeMlsMessage(hexToBytes(data.key_package), 0)

    if (kp === undefined || kp[0].wireformat !== 'mls_key_package') throw new Error('Could not decode KeyPackage')
    await verifyKeys(t, data, kp[0].keyPackage, impl)

    const welcome = decodeMlsMessage(hexToBytes(data.welcome), 0)

    if (welcome === undefined || welcome[0].wireformat !== 'mls_welcome') throw new Error('Could not decode Welcome')

    const pks: PrivateKeyPackage = {
        hpkePrivateKey: hexToBytes(data.encryption_priv),
        initPrivateKey: hexToBytes(data.init_priv),
        signaturePrivateKey: hexToBytes(data.signature_priv),
    }

    const tree = data.ratchet_tree !== null ? decodeRatchetTree(hexToBytes(data.ratchet_tree), 0)?.[0] : undefined

    const psks: Record<string, Uint8Array> = data.external_psks.reduce(
        (acc, psk) => ({ ...acc, [bytesToBase64(hexToBytes(psk.psk_id))]: hexToBytes(psk.psk) }),
        {},
    )
    let state = await joinGroup(welcome[0].welcome, kp[0].keyPackage, pks, makePskIndex(undefined, psks), impl, tree)

    t.deepEqual(state.keySchedule.epochAuthenticator, hexToBytes(data.initial_epoch_authenticator), 'initial epoch authenticator should match')

    for (const epoch of data.epochs) {
        for (const proposal of epoch.proposals) {
            const mlsProposal = decodeMlsMessage(hexToBytes(proposal), 0)
            if (
                mlsProposal === undefined ||
        (mlsProposal[0].wireformat !== 'mls_private_message' && mlsProposal[0].wireformat !== 'mls_public_message')
            ) { throw new Error('Could not decode proposal message') }

            if (mlsProposal[0].wireformat === 'mls_private_message') {
                const res = await processPrivateMessage(state, mlsProposal[0].privateMessage, makePskIndex(state, psks), impl)

                state = res.newState
            } else {
                const res = await processPublicMessage(state, mlsProposal[0].publicMessage, makePskIndex(state, psks), impl)

                state = res.newState
            }
        }

        const mlsCommit = decodeMlsMessage(hexToBytes(epoch.commit), 0)
        if (
            mlsCommit === undefined ||
      (mlsCommit[0].wireformat !== 'mls_private_message' && mlsCommit[0].wireformat !== 'mls_public_message')
        ) { throw new Error('Could not decode commit message') }

        if (mlsCommit[0].wireformat === 'mls_private_message') {
            const res = await processPrivateMessage(state, mlsCommit[0].privateMessage, makePskIndex(state, psks), impl)

            state = res.newState
        } else {
            const res = await processPublicMessage(state, mlsCommit[0].publicMessage, makePskIndex(state, psks), impl)
            state = res.newState
        }

        t.deepEqual(state.keySchedule.epochAuthenticator, hexToBytes(epoch.epoch_authenticator), 'epoch authenticator should match after commit')
    }
}

async function verifyKeys (t: any, data: MlsGroupState, kp: KeyPackage, impl: CiphersuiteImpl) {
    const hpke = await hpkeKeysMatch(kp.leafNode.hpkePublicKey, hexToBytes(data.encryption_priv), impl.hpke)
    t.ok(hpke, 'HPKE keys should match')

    const hpkeInit = await hpkeKeysMatch(kp.initKey, hexToBytes(data.init_priv), impl.hpke)
    t.ok(hpkeInit, 'HPKE init keys should match')

    const sig = await signatureKeysMatch(kp.leafNode.signaturePublicKey, hexToBytes(data.signature_priv), impl.signature)
    t.ok(sig, 'signature keys should match')
    hexToBytes(data.init_priv)
}

type MlsGroupState = {
  cipher_suite: number
  external_psks: ExternalPsk[]
  key_package: string
  signature_priv: string
  encryption_priv: string
  init_priv: string
  welcome: string
  ratchet_tree: string | null
  initial_epoch_authenticator: string
  epochs: Epoch[]
}

type ExternalPsk = {
  psk_id: string
  psk: string
}

type Epoch = {
  proposals: string[]
  commit: string
  epoch_authenticator: string
}
