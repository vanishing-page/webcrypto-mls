import { test } from '@substrate-system/tapzero'
import { createGroup, joinGroup } from '../../src/client-state.js'
import { createCommit } from '../../src/create-commit.js'
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
import { defaultLifetime } from '../../src/lifetime.js'
import { defaultCapabilities } from '../../src/default-capabilities.js'
import { createProposal } from '../../src/index.js'
import { processMessage } from '../../src/process-messages.js'
import { encodeExternalSenders } from '../../src/external-sender.js'
import type { WireformatName } from '../../src/wireformat.js'

for (const cs of Object.keys(ciphersuites)) {
    test('Reject incoming message ' + cs, async (t) => {
        try {
            await rejectIncomingMessagesTest(t, cs as CiphersuiteName, true)
        } catch (error:any) {
            // Skip ciphersuites not supported in the current environment (e.g., X448/Ed448 in browsers)
            if (error?.name === 'NotSupportedError' || error?.name === 'DependencyError') {
                t.comment(`Skipping ${cs}: ${error.message}`)
                return
            }
            throw error
        }
        await rejectIncomingMessagesTest(t, cs as CiphersuiteName, false)
    })
}

async function rejectIncomingMessagesTest (t:any, cipherSuite:CiphersuiteName, publicMessage:boolean) {
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
    const preferredWireformat:WireformatName = publicMessage ? 'mls_public_message' : 'mls_private_message'

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

    const addBobCommitResult = await createCommit(
        {
            state: aliceGroup,
            cipherSuite: impl,
        },
        {
            wireAsPublicMessage: publicMessage,
            extraProposals: [addBobProposal],
        },
    )

    aliceGroup = addBobCommitResult.newState

    let bobGroup = await joinGroup(
        addBobCommitResult.welcome!,
        bob.publicPackage,
        bob.privatePackage,
        emptyPskIndex,
        impl,
        aliceGroup.ratchetTree,
    )

    const bobProposeExtensions:Proposal = {
        proposalType: 'group_context_extensions',
        groupContextExtensions: {
            extensions: [
                {
                    extensionType: 'external_senders',
                    extensionData: encodeExternalSenders([{
                        credential: { credentialType: 'basic', identity: new Uint8Array() },
                        signaturePublicKey: new Uint8Array(),
                    }]),
                },
            ],
        },
    }

    const createExtensionsProposalResults = await createProposal(bobGroup, publicMessage, bobProposeExtensions, impl)

    bobGroup = createExtensionsProposalResults.newState

    if (createExtensionsProposalResults.message.wireformat !== preferredWireformat) { throw new Error(`Expected ${preferredWireformat} message`) }

    // alice rejects the proposal
    const aliceRejectsProposalResult = await processMessage(
        createExtensionsProposalResults.message,
        aliceGroup,
        emptyPskIndex,
        () => 'reject',
        impl,
    )

    aliceGroup = aliceRejectsProposalResult.newState

    t.deepEqual(aliceGroup.unappliedProposals, {}, 'alice should have no unapplied proposals after rejecting')

    // alice commits without the proposal
    const aliceCommitResult = await createCommit(
        {
            state: aliceGroup,
            cipherSuite: impl,
        },
        {
            wireAsPublicMessage: publicMessage,
        },
    )

    aliceGroup = aliceCommitResult.newState

    if (aliceCommitResult.commit.wireformat !== preferredWireformat) { throw new Error(`Expected ${preferredWireformat} message`) }

    const bobRejectsAliceCommitResult = await processMessage(
        aliceCommitResult.commit,
        bobGroup,
        emptyPskIndex,
        () => 'reject',
        impl,
    )

    // group context and keySchedule haven't changed since bob rejected the commit
    t.deepEqual(bobRejectsAliceCommitResult.newState.groupContext, bobGroup.groupContext, 'group context should not change after rejecting commit')
    t.deepEqual(bobRejectsAliceCommitResult.newState.keySchedule, bobGroup.keySchedule, 'key schedule should not change after rejecting commit')
}
