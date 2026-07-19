import { test } from '@substrate-system/tapzero'
import { applyProposals, createGroup } from '../../src/client-state.js'
import { emptyPskIndex } from '../../src/psk-index.js'
import { ValidationError } from '../../src/mls-error.js'
import type { Credential } from '../../src/credential.js'
import type { CiphersuiteName } from '../../src/crypto/ciphersuite.js'
import { ciphersuites, getCiphersuiteFromName } from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import { generateKeyPackage } from '../../src/key-package.js'
import type { ProposalExternalInit } from '../../src/proposal.js'
import { toLeafIndex } from '../../src/treemath.js'
import { defaultLifetime } from '../../src/lifetime.js'
import { defaultCapabilities } from '../../src/default-capabilities.js'

for (const cs of Object.keys(ciphersuites)) {
    test('external_init proposal rejected from a member sender ' + cs, async (t) => {
        try {
            await memberSenderWithExternalInitRejected(t, cs as CiphersuiteName)
        } catch (error:any) {
            if (error?.name === 'NotSupportedError' || error?.name === 'DependencyError') {
                t.comment(`Skipping ${cs}: ${error.message}`)
                return
            }
            throw error
        }
    })

    test('new_member_commit lacking external_init rejected ' + cs, async (t) => {
        try {
            await newMemberCommitWithoutExternalInitRejected(t, cs as CiphersuiteName)
        } catch (error:any) {
            if (error?.name === 'NotSupportedError' || error?.name === 'DependencyError') {
                t.comment(`Skipping ${cs}: ${error.message}`)
                return
            }
            throw error
        }
    })
}

async function makeAliceGroup (cipherSuite:CiphersuiteName) {
    const impl = await getCipherSuite(getCiphersuiteFromName(cipherSuite))

    const aliceCredential:Credential = {
        credentialType: 'basic',
        identity: new TextEncoder().encode('alice'),
    }
    const alice = await generateKeyPackage(
        aliceCredential,
        defaultCapabilities(),
        defaultLifetime,
        [],
        impl,
    )

    const groupId = new TextEncoder().encode('group1')

    const aliceGroup = await createGroup(
        groupId,
        alice.publicPackage,
        alice.privatePackage,
        [],
        impl,
    )

    return { impl, aliceGroup }
}

async function memberSenderWithExternalInitRejected (t:any, cipherSuite:CiphersuiteName) {
    const { impl, aliceGroup } = await makeAliceGroup(cipherSuite)

    const externalInitProposal:ProposalExternalInit = {
        proposalType: 'external_init',
        externalInit: { kemOutput: new Uint8Array(impl.kdf.size) },
    }

    let threw = false
    try {
        await applyProposals(
            aliceGroup,
            [{ proposalOrRefType: 'proposal', proposal: externalInitProposal }],
            toLeafIndex(aliceGroup.privatePath.leafIndex),
            emptyPskIndex,
            true,
            impl,
            undefined,
            'member',
        )
    } catch (error) {
        threw = true
        t.ok(error instanceof ValidationError, 'should throw a ValidationError')
    }

    t.ok(threw, 'a member sender committing an external_init proposal should be rejected')
}

async function newMemberCommitWithoutExternalInitRejected (t:any, cipherSuite:CiphersuiteName) {
    const { impl, aliceGroup } = await makeAliceGroup(cipherSuite)

    let threw = false
    try {
        await applyProposals(
            aliceGroup,
            [],
            undefined,
            emptyPskIndex,
            false,
            impl,
            undefined,
            'new_member_commit',
        )
    } catch (error) {
        threw = true
        t.ok(error instanceof ValidationError, 'should throw a ValidationError')
    }

    t.ok(threw, 'a new_member_commit lacking exactly one external_init proposal should be rejected')
}
