import { test } from '@substrate-system/tapzero'
import { applyProposals, createGroup, makePskIndex } from '../../src/client-state.js'
import { addUnappliedProposal } from '../../src/unapplied-proposals.js'
import { emptyPskIndex } from '../../src/psk-index.js'
import { bytesToBase64 } from '../../src/util/byte-array.js'
import type { Credential } from '../../src/credential.js'
import type { CiphersuiteName } from '../../src/crypto/ciphersuite.js'
import {
    getCiphersuiteFromName
} from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import { generateKeyPackage } from '../../src/key-package.js'
import type { Proposal, ProposalExternalInit, ProposalPSK } from '../../src/proposal.js'
import { defaultLifetime } from '../../src/lifetime.js'
import { defaultCapabilities } from '../../src/default-capabilities.js'
import { ValidationError } from '../../src/mls-error.js'
import { testCiphersuites } from '../helpers/suite-filter.js'
import { testClientConfig } from '../helpers/client-config.js'

for (const cs of testCiphersuites()) {
    test(`External commit rejects proposal delivered by reference ${cs}`, async (t) => {
        try {
            await externalCommitRejectsProposalByReference(cs as CiphersuiteName, t)
        } catch (error:any) {
            if (error?.name === 'NotSupportedError' || error?.name === 'DependencyError') {
                t.comment(`Skipping ${cs}: ${error.message}`)
                return
            }
            throw error
        }
    })

    test(`External commit rejects duplicate PSK proposal IDs ${cs}`, async (t) => {
        try {
            await externalCommitRejectsDuplicatePskIds(cs as CiphersuiteName, t)
        } catch (error:any) {
            if (error?.name === 'NotSupportedError' || error?.name === 'DependencyError') {
                t.comment(`Skipping ${cs}: ${error.message}`)
                return
            }
            throw error
        }
    })
}

async function setupSoloGroup (cipherSuite:CiphersuiteName) {
    const impl = await getCipherSuite(getCiphersuiteFromName(cipherSuite))

    const aliceCredential:Credential = {
        credentialType: 'basic',
        identity: new TextEncoder().encode('alice')
    }
    const alice = await generateKeyPackage(
        aliceCredential,
        defaultCapabilities(),
        defaultLifetime(),
        [],
        impl
    )

    const groupId = new TextEncoder().encode('group1')

    const aliceGroup = await createGroup(
        groupId,
        alice.publicPackage,
        alice.privatePackage,
        [],
        impl,
        testClientConfig
    )

    return { impl, aliceGroup }
}

async function externalCommitRejectsProposalByReference (cipherSuite:CiphersuiteName, t:any) {
    const { impl, aliceGroup } = await setupSoloGroup(cipherSuite)

    const externalInitProposal:ProposalExternalInit = {
        proposalType: 'external_init',
        externalInit: { kemOutput: new Uint8Array(32) },
    }

    const reference = new Uint8Array(32).fill(7)

    const stateWithUnapplied = {
        ...aliceGroup,
        unappliedProposals: addUnappliedProposal(
            reference,
            aliceGroup.unappliedProposals,
            externalInitProposal,
            undefined,
        ),
    }

    let thrown:unknown
    try {
        await applyProposals(
            stateWithUnapplied,
            [{ proposalOrRefType: 'reference', reference }],
            undefined,
            emptyPskIndex,
            false,
            impl,
            undefined,
            'new_member_commit',
        )
    } catch (error) {
        thrown = error
    }

    t.ok(thrown instanceof ValidationError, 'external commit referencing a proposal by reference throws ValidationError')
}

async function externalCommitRejectsDuplicatePskIds (cipherSuite:CiphersuiteName, t:any) {
    const { impl, aliceGroup } = await setupSoloGroup(cipherSuite)

    const externalInitProposal:ProposalExternalInit = {
        proposalType: 'external_init',
        externalInit: { kemOutput: new Uint8Array(32) },
    }

    const pskId = new Uint8Array(16).fill(3)

    const makePskProposal = ():ProposalPSK => ({
        proposalType: 'psk',
        psk: {
            preSharedKeyId: {
                psktype: 'external',
                pskId,
                pskNonce: new Uint8Array(impl.kdf.size).fill(9),
            },
        },
    })

    const proposals:Proposal[] = [externalInitProposal, makePskProposal(), makePskProposal()]

    const pskSearch = makePskIndex(undefined, { [bytesToBase64(pskId)]: new Uint8Array(impl.kdf.size).fill(4) })

    let thrown:unknown
    try {
        await applyProposals(
            aliceGroup,
            proposals.map((proposal) => ({ proposalOrRefType: 'proposal' as const, proposal })),
            undefined,
            pskSearch,
            false,
            impl,
            undefined,
            'new_member_commit',
        )
    } catch (error) {
        thrown = error
    }

    t.ok(thrown instanceof ValidationError, 'external commit with duplicate PSK IDs throws ValidationError')
}
