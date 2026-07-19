import { test } from '@substrate-system/tapzero'
import { createGroup, joinGroup, makePskIndex } from '../../src/client-state.js'
import { createCommit } from '../../src/create-commit.js'
import { processPrivateMessage } from '../../src/process-messages.js'
import { emptyPskIndex } from '../../src/psk-index.js'
import type { Credential } from '../../src/credential.js'
import type { CiphersuiteName } from '../../src/crypto/ciphersuite.js'
import {
    ciphersuites,
    getCiphersuiteFromName
} from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import { generateKeyPackage } from '../../src/key-package.js'
import type { Proposal, ProposalAdd } from '../../src/proposal.js'
import { bytesToBase64 } from '../../src/util/byte-array.js'
import { checkHpkeKeysMatch } from '../crypto/key-match.js'
import { testEveryoneCanMessageEveryone } from './common.js'
import { defaultLifetime } from '../../src/lifetime.js'
import { defaultCapabilities } from '../../src/default-capabilities.js'

for (const cs of Object.keys(ciphersuites)) {
    test(`External PSK ${cs}`, async (t) => {
        try {
            await externalPsk(cs as CiphersuiteName, t)
        } catch (error:any) {
            // Skip ciphersuites not supported in the current environment (e.g., X448/Ed448 in browsers)
            if (error?.name === 'NotSupportedError' || error?.name === 'DependencyError') {
                t.comment(`Skipping ${cs}: ${error.message}`)
                return
            }
            throw error
        }
    })
}

async function externalPsk (cipherSuite:CiphersuiteName, t:any) {
    const impl = await getCipherSuite(getCiphersuiteFromName(cipherSuite))

    const aliceCredential:Credential = {
        credentialType: 'basic',
        identity: new TextEncoder().encode('alice')
    }
    const alice = await generateKeyPackage(
        aliceCredential,
        defaultCapabilities(),
        defaultLifetime,
        [],
        impl
    )

    const groupId = new TextEncoder().encode('group1')

    let aliceGroup = await createGroup(
        groupId,
        alice.publicPackage,
        alice.privatePackage,
        [],
        impl
    )

    const bobCredential:Credential = {
        credentialType: 'basic',
        identity: new TextEncoder().encode('bob')
    }
    const bob = await generateKeyPackage(
        bobCredential,
        defaultCapabilities(),
        defaultLifetime,
        [],
        impl
    )

    const addBobProposal:ProposalAdd = {
        proposalType: 'add',
        add: {
            keyPackage: bob.publicPackage,
        },
    }

    const commitResult = await createCommit(
        {
            state: aliceGroup,
            cipherSuite: impl,
        },
        {
            extraProposals: [addBobProposal],
        },
    )

    aliceGroup = commitResult.newState

    let bobGroup = await joinGroup(
        commitResult.welcome!,
        bob.publicPackage,
        bob.privatePackage,
        emptyPskIndex,
        impl,
        aliceGroup.ratchetTree,
    )

    const pskSecret1 = impl.rng.randomBytes(impl.kdf.size)
    const pskSecret2 = impl.rng.randomBytes(impl.kdf.size)
    const pskNonce1 = impl.rng.randomBytes(impl.kdf.size)
    const pskNonce2 = impl.rng.randomBytes(impl.kdf.size)

    const pskId1 = new TextEncoder().encode('psk-1')
    const pskId2 = new TextEncoder().encode('psk-1')

    const pskProposal1:Proposal = {
        proposalType: 'psk',
        psk: {
            preSharedKeyId: {
                psktype: 'external',
                pskId: pskId1,
                pskNonce: pskNonce1,
            },
        },
    }

    const pskProposal2:Proposal = {
        proposalType: 'psk',
        psk: {
            preSharedKeyId: {
                psktype: 'external',
                pskId: pskId2,
                pskNonce: pskNonce2,
            },
        },
    }

    const base64PskId1 = bytesToBase64(pskId1)

    const base64PskId2 = bytesToBase64(pskId2)

    const sharedPsks = { [base64PskId1]: pskSecret1, [base64PskId2]: pskSecret2 }

    const pskCommitResult = await createCommit(
        {
            state: aliceGroup,
            pskIndex: makePskIndex(aliceGroup, sharedPsks),
            cipherSuite: impl,
        },
        {
            extraProposals: [pskProposal1, pskProposal2],
        },
    )

    aliceGroup = pskCommitResult.newState

    if (pskCommitResult.commit.wireformat !== 'mls_private_message') throw new Error('Expected private message')

    const processPskResult = await processPrivateMessage(
        bobGroup,
        pskCommitResult.commit.privateMessage,
        makePskIndex(bobGroup, sharedPsks),
        impl,
    )

    bobGroup = processPskResult.newState

    await testEveryoneCanMessageEveryone([aliceGroup, bobGroup], impl, t)
    await checkHpkeKeysMatch(aliceGroup, impl, t)
    await checkHpkeKeysMatch(bobGroup, impl, t)
}
