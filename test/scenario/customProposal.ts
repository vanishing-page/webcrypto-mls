import { test } from '@substrate-system/tapzero'
import { createGroup, joinGroup } from '../../src/clientState.js'
import { createCommit } from '../../src/createCommit.js'
import { emptyPskIndex } from '../../src/pskIndex.js'
import type { Credential } from '../../src/credential.js'
import type { CiphersuiteName } from '../../src/crypto/ciphersuite.js'
import { getCiphersuiteFromName, ciphersuites } from '../../src/crypto/ciphersuite.js'
import { getCiphersuiteImpl } from '../../src/crypto/getCiphersuiteImpl.js'
import { generateKeyPackage } from '../../src/keyPackage.js'
import type { Proposal, ProposalAdd } from '../../src/proposal.js'
import { testEveryoneCanMessageEveryone } from './common.js'
import { defaultLifetime } from '../../src/lifetime.js'
import type { Capabilities } from '../../src/capabilities.js'
import { createApplicationMessage, createProposal, processPrivateMessage } from '../../src/index.js'
import { UsageError } from '../../src/mlsError.js'

for (const cs of Object.keys(ciphersuites)) {
    test(`Custom Proposals ${cs}`, async (t) => {
        await customProposalTest(cs as CiphersuiteName, t)
    })
}

async function customProposalTest (cipherSuite: CiphersuiteName, t: any) {
    const impl = await getCiphersuiteImpl(getCiphersuiteFromName(cipherSuite))

    const customProposalType: number = 8

    const capabilities: Capabilities = {
        extensions: [],
        credentials: ['basic'],
        proposals: [customProposalType],
        versions: ['mls10'],
        ciphersuites: [cipherSuite],
    }

    const aliceCredential: Credential = { credentialType: 'basic', identity: new TextEncoder().encode('alice') }
    const alice = await generateKeyPackage(aliceCredential, capabilities, defaultLifetime, [], impl)

    const groupId = new TextEncoder().encode('group1')

    let aliceGroup = await createGroup(groupId, alice.publicPackage, alice.privatePackage, [], impl)

    const bobCredential: Credential = { credentialType: 'basic', identity: new TextEncoder().encode('bob') }
    const bob = await generateKeyPackage(bobCredential, capabilities, defaultLifetime, [], impl)

    const addBobProposal: ProposalAdd = {
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
        { extraProposals: [addBobProposal] },
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

    const proposalData = new TextEncoder().encode('custom proposal data')

    const customProposal: Proposal = {
        proposalType: 8,
        proposalData,
    }

    const createProposalResult = await createProposal(bobGroup, false, customProposal, impl)

    bobGroup = createProposalResult.newState

    if (createProposalResult.message.wireformat !== 'mls_private_message') throw new Error('Expected private message')

    const processProposalResult = await processPrivateMessage(
        aliceGroup,
        createProposalResult.message.privateMessage,
        emptyPskIndex,
        impl,
        (p) => {
            if (p.kind !== 'proposal') throw new Error('Expected proposal')
            t.deepEqual(p.proposal.proposal, customProposal, 'should receive custom proposal')
            return 'accept'
        },
    )

    aliceGroup = processProposalResult.newState

    // creating an application message will fail now
    let errorThrown = false
    try {
        await createApplicationMessage(aliceGroup, new Uint8Array([1, 2, 3]), impl)
    } catch (error) {
        errorThrown = error instanceof UsageError
    }
    t.ok(errorThrown, 'should throw UsageError when creating message with pending proposals')

    const createCommitResult = await createCommit({
        state: aliceGroup,

        cipherSuite: impl,
    })

    aliceGroup = createCommitResult.newState

    if (createCommitResult.commit.wireformat !== 'mls_private_message') throw new Error('Expected private message')

    const processCommitResult = await processPrivateMessage(
        bobGroup,
        createCommitResult.commit.privateMessage,
        emptyPskIndex,
        impl,
        (p) => {
            if (p.kind !== 'commit') throw new Error('Expected commit')
            t.deepEqual(p.proposals.map((p) => p.proposal), [customProposal], 'should commit custom proposal')
            return 'accept'
        },
    )

    bobGroup = processCommitResult.newState

    await testEveryoneCanMessageEveryone([aliceGroup, bobGroup], impl, t)
}
