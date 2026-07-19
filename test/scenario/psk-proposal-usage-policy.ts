import { test } from '@substrate-system/tapzero'
import { applyProposals, createGroup, makePskIndex } from '../../src/client-state.js'
import { createCommit } from '../../src/create-commit.js'
import { ValidationError } from '../../src/mls-error.js'
import type { Credential } from '../../src/credential.js'
import type { CiphersuiteName } from '../../src/crypto/ciphersuite.js'
import { ciphersuites, getCiphersuiteFromName } from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import { generateKeyPackage } from '../../src/key-package.js'
import type { Proposal } from '../../src/proposal.js'
import { toLeafIndex } from '../../src/treemath.js'
import { defaultLifetime } from '../../src/lifetime.js'
import { defaultCapabilities } from '../../src/default-capabilities.js'

for (const cs of Object.keys(ciphersuites)) {
    test('PreSharedKey proposal with resumption usage branch rejected ' + cs, async (t) => {
        try {
            await resumptionUsageBranchRejected(t, cs as CiphersuiteName)
        } catch (error:any) {
            if (error?.name === 'NotSupportedError' || error?.name === 'DependencyError') {
                t.comment(`Skipping ${cs}: ${error.message}`)
                return
            }
            throw error
        }
    })

    test('PreSharedKey proposal with resumption usage reinit rejected ' + cs, async (t) => {
        try {
            await resumptionUsageReinitRejected(t, cs as CiphersuiteName)
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

    let aliceGroup = await createGroup(
        groupId,
        alice.publicPackage,
        alice.privatePackage,
        [],
        impl,
    )

    // Advance past epoch 0 -- reinit/branch resumption-PSK usages are only
    // valid in the commit that creates a group's first epoch (RFC 9420
    // SS11.1/11.2), so ordinary commits must be at a later epoch to exercise
    // the "otherwise must be application usage" branch of the check.
    const advanceCommitResult = await createCommit(
        { state: aliceGroup, cipherSuite: impl },
        {},
    )

    aliceGroup = advanceCommitResult.newState

    return { impl, aliceGroup }
}

async function pskProposalWithUsageRejected (t:any, cipherSuite:CiphersuiteName, usage:'branch' | 'reinit') {
    const { impl, aliceGroup } = await makeAliceGroup(cipherSuite)

    const pskProposal:Proposal = {
        proposalType: 'psk',
        psk: {
            preSharedKeyId: {
                psktype: 'resumption',
                usage,
                pskGroupId: aliceGroup.groupContext.groupId,
                pskEpoch: aliceGroup.groupContext.epoch,
                pskNonce: impl.rng.randomBytes(impl.kdf.size),
            },
        },
    }

    let threw = false
    try {
        await applyProposals(
            aliceGroup,
            [{ proposalOrRefType: 'proposal', proposal: pskProposal }],
            toLeafIndex(aliceGroup.privatePath.leafIndex),
            makePskIndex(aliceGroup, {}),
            true,
            impl,
        )
    } catch (error) {
        threw = true
        t.ok(error instanceof ValidationError, 'should throw a ValidationError')
    }

    t.ok(threw, `a resumption PreSharedKey proposal with usage ${usage} should be rejected in a commit`)
}

async function resumptionUsageBranchRejected (t:any, cipherSuite:CiphersuiteName) {
    await pskProposalWithUsageRejected(t, cipherSuite, 'branch')
}

async function resumptionUsageReinitRejected (t:any, cipherSuite:CiphersuiteName) {
    await pskProposalWithUsageRejected(t, cipherSuite, 'reinit')
}
