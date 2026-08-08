import { test } from '@substrate-system/tapzero'
import { createGroup, joinGroup } from '../../src/client-state.js'
import { createCommit } from '../../src/create-commit.js'
import { emptyPskIndex } from '../../src/psk-index.js'
import type { Credential } from '../../src/credential.js'
import type { CiphersuiteName } from '../../src/crypto/ciphersuite.js'
import {
    getCiphersuiteFromName,
    ciphersuites
} from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import { generateKeyPackage } from '../../src/key-package.js'
import type { Proposal, ProposalAdd } from '../../src/proposal.js'
import { defaultLifetime } from '../../src/lifetime.js'
import type { Capabilities } from '../../src/capabilities.js'
import { createProposal, processPrivateMessage } from '../../src/index.js'
import { ValidationError } from '../../src/mls-error.js'

for (const cs of Object.keys(ciphersuites)) {
    test(`Commit with unsupported custom proposal is rejected ${cs}`, async (t) => {
        try {
            await commitWithUnsupportedCustomProposalIsRejected(cs as CiphersuiteName, t)
        } catch (error:any) {
            if (error?.name === 'NotSupportedError' || error?.name === 'DependencyError') {
                t.comment(`Skipping ${cs}: ${error.message}`)
                return
            }
            throw error
        }
    })

    test(`Standalone custom proposal is accepted into unappliedProposals ${cs}`, async (t) => {
        try {
            await standaloneCustomProposalAcceptedIntoUnapplied(cs as CiphersuiteName, t)
        } catch (error:any) {
            if (error?.name === 'NotSupportedError' || error?.name === 'DependencyError') {
                t.comment(`Skipping ${cs}: ${error.message}`)
                return
            }
            throw error
        }
    })
}

async function setupAliceAndBob (cipherSuite:CiphersuiteName, customProposalType:number) {
    const impl = await getCipherSuite(getCiphersuiteFromName(cipherSuite))

    const capabilities:Capabilities = {
        extensions: [],
        credentials: ['basic'],
        proposals: [customProposalType],
        versions: ['mls10'],
        ciphersuites: [cipherSuite],
    }

    const aliceCredential:Credential = {
        credentialType: 'basic',
        identity: new TextEncoder().encode('alice')
    }
    const alice = await generateKeyPackage(aliceCredential, capabilities, defaultLifetime(), [], impl)

    const groupId = new TextEncoder().encode('group1')

    // note: no `supportedCustomProposalTypes` opt-in on the default clientConfig
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
    const bob = await generateKeyPackage(bobCredential, capabilities, defaultLifetime(), [], impl)

    const addBobProposal:ProposalAdd = {
        proposalType: 'add',
        add: { keyPackage: bob.publicPackage },
    }

    const addBobCommitResult = await createCommit(
        { state: aliceGroup, cipherSuite: impl },
        { extraProposals: [addBobProposal] },
    )

    aliceGroup = addBobCommitResult.newState

    const bobGroup = await joinGroup(
        addBobCommitResult.welcome!,
        bob.publicPackage,
        bob.privatePackage,
        emptyPskIndex,
        impl,
        aliceGroup.ratchetTree,
    )

    return { impl, aliceGroup, bobGroup }
}

async function commitWithUnsupportedCustomProposalIsRejected (
    cipherSuite:CiphersuiteName,
    t:any,
) {
    const customProposalType = 8
    const { impl, aliceGroup, bobGroup } = await setupAliceAndBob(cipherSuite, customProposalType)

    const customProposal:Proposal = {
        proposalType: customProposalType,
        proposalData: new TextEncoder().encode('custom proposal data'),
    }

    const createProposalResult = await createProposal(bobGroup, false, customProposal, impl)

    if (createProposalResult.message.wireformat !== 'mls_private_message') throw new Error('Expected private message')

    const processProposalResult = await processPrivateMessage(
        aliceGroup,
        createProposalResult.message.privateMessage,
        emptyPskIndex,
        impl,
        () => 'accept',
    )

    const aliceGroupWithProposal = processProposalResult.newState

    let thrown:unknown
    try {
        await createCommit({ state: aliceGroupWithProposal, cipherSuite: impl })
    } catch (error) {
        thrown = error
    }

    t.ok(thrown instanceof ValidationError, 'committing an unsupported custom proposal throws ValidationError')
}

async function standaloneCustomProposalAcceptedIntoUnapplied (
    cipherSuite:CiphersuiteName,
    t:any,
) {
    const customProposalType = 9
    const { impl, aliceGroup, bobGroup } = await setupAliceAndBob(cipherSuite, customProposalType)

    const customProposal:Proposal = {
        proposalType: customProposalType,
        proposalData: new TextEncoder().encode('another custom proposal'),
    }

    const createProposalResult = await createProposal(bobGroup, false, customProposal, impl)

    if (createProposalResult.message.wireformat !== 'mls_private_message') throw new Error('Expected private message')

    const processProposalResult = await processPrivateMessage(
        aliceGroup,
        createProposalResult.message.privateMessage,
        emptyPskIndex,
        impl,
        (p) => {
            if (p.kind !== 'proposal') throw new Error('Expected proposal')
            return 'accept'
        },
    )

    const aliceGroupWithProposal = processProposalResult.newState

    const unapplied = Object.values(aliceGroupWithProposal.unappliedProposals)
    t.equal(unapplied.length, 1, 'standalone custom proposal is stored in unappliedProposals')
    t.deepEqual(unapplied[0]?.proposal, customProposal, 'stored proposal matches the sent custom proposal')
}
