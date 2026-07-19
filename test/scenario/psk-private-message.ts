import { test } from '@substrate-system/tapzero'
import { createGroup, joinGroup, makePskIndex } from '../../src/client-state.js'
import { createCommit } from '../../src/create-commit.js'
import { processMessage } from '../../src/process-messages.js'
import { acceptAll } from '../../src/incoming-message-action.js'
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
    test(`PSK commit via processMessage (PrivateMessage) ${cs}`, async (t) => {
        try {
            await pskViaProcessMessage(cs as CiphersuiteName, t)
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

async function pskViaProcessMessage (cipherSuite:CiphersuiteName, t:any) {
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

    const pskSecret = impl.rng.randomBytes(impl.kdf.size)
    const pskNonce = impl.rng.randomBytes(impl.kdf.size)
    const pskId = new TextEncoder().encode('psk-1')

    const pskProposal:Proposal = {
        proposalType: 'psk',
        psk: {
            preSharedKeyId: {
                psktype: 'external',
                pskId,
                pskNonce,
            },
        },
    }

    const base64PskId = bytesToBase64(pskId)
    const sharedPsks = { [base64PskId]: pskSecret }

    const pskCommitResult = await createCommit(
        {
            state: aliceGroup,
            pskIndex: makePskIndex(aliceGroup, sharedPsks),
            cipherSuite: impl,
        },
        {
            extraProposals: [pskProposal],
        },
    )

    aliceGroup = pskCommitResult.newState

    if (pskCommitResult.commit.wireformat !== 'mls_private_message') throw new Error('Expected private message')

    // Route through processMessage (the wireformat-dispatching entry point)
    // rather than calling processPrivateMessage directly, so that a
    // regression where processMessage drops the caller's pskIndex on the
    // PrivateMessage path is caught.
    const processPskResult = await processMessage(
        pskCommitResult.commit,
        bobGroup,
        makePskIndex(bobGroup, sharedPsks),
        acceptAll,
        impl,
    )

    if (processPskResult.kind !== 'newState') throw new Error('Expected newState result')

    bobGroup = processPskResult.newState

    await testEveryoneCanMessageEveryone([aliceGroup, bobGroup], impl, t)
    await checkHpkeKeysMatch(aliceGroup, impl, t)
    await checkHpkeKeysMatch(bobGroup, impl, t)
}
