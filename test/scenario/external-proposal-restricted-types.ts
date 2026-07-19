import { test } from '@substrate-system/tapzero'
import { createGroup } from '../../src/client-state.js'
import { createGroupInfoWithExternalPub } from '../../src/create-commit.js'
import { proposeExternal } from '../../src/external-proposal.js'
import { UsageError } from '../../src/mls-error.js'
import type { Credential } from '../../src/credential.js'
import type { CiphersuiteName } from '../../src/crypto/ciphersuite.js'
import { ciphersuites, getCiphersuiteFromName } from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import { generateKeyPackage } from '../../src/key-package.js'
import type { Proposal } from '../../src/proposal.js'
import type { ExternalSender } from '../../src/external-sender.js'
import { encodeExternalSenders } from '../../src/external-sender.js'
import type { Extension } from '../../src/extension.js'
import { defaultLifetime } from '../../src/lifetime.js'
import { defaultCapabilities } from '../../src/default-capabilities.js'

for (const cs of Object.keys(ciphersuites)) {
    test('proposeExternal rejects Update proposal at construction ' + cs, async (t) => {
        try {
            await proposeExternalUpdateRejected(t, cs as CiphersuiteName)
        } catch (error:any) {
            if (error?.name === 'NotSupportedError' || error?.name === 'DependencyError') {
                t.comment(`Skipping ${cs}: ${error.message}`)
                return
            }
            throw error
        }
    })

    test('proposeExternal rejects ExternalInit proposal at construction ' + cs, async (t) => {
        try {
            await proposeExternalExternalInitRejected(t, cs as CiphersuiteName)
        } catch (error:any) {
            if (error?.name === 'NotSupportedError' || error?.name === 'DependencyError') {
                t.comment(`Skipping ${cs}: ${error.message}`)
                return
            }
            throw error
        }
    })
}

async function makeAliceGroupWithExternalSender (cipherSuite:CiphersuiteName) {
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

    const charlieCredential:Credential = {
        credentialType: 'basic',
        identity: new TextEncoder().encode('charlie'),
    }
    const charlie = await generateKeyPackage(
        charlieCredential,
        defaultCapabilities(),
        defaultLifetime,
        [],
        impl,
    )

    const externalSender:ExternalSender = {
        credential: charlieCredential,
        signaturePublicKey: charlie.publicPackage.leafNode.signaturePublicKey,
    }

    const extension:Extension = {
        extensionType: 'external_senders',
        extensionData: encodeExternalSenders([externalSender]),
    }

    const groupId = new TextEncoder().encode('group1')

    const aliceGroup = await createGroup(groupId, alice.publicPackage, alice.privatePackage, [extension], impl)

    const groupInfo = await createGroupInfoWithExternalPub(aliceGroup, [], impl)

    return { impl, groupInfo, charlie }
}

async function proposeExternalUpdateRejected (t:any, cipherSuite:CiphersuiteName) {
    const { groupInfo, charlie } = await makeAliceGroupWithExternalSender(cipherSuite)

    const updateProposal:Proposal = {
        proposalType: 'update',
        update: {
            leafNode: {
                ...charlie.publicPackage.leafNode,
                leafNodeSource: 'update' as const,
            },
        },
    }

    let threw = false
    try {
        await proposeExternal(
            groupInfo,
            updateProposal,
            charlie.publicPackage.leafNode.signaturePublicKey,
            charlie.privatePackage.signaturePrivateKey,
            (await getCipherSuite(getCiphersuiteFromName(cipherSuite))),
        )
    } catch (error) {
        threw = true
        t.ok(error instanceof UsageError, 'should throw a UsageError')
    }

    t.ok(threw, 'constructing an external Update proposal should throw')
}

async function proposeExternalExternalInitRejected (t:any, cipherSuite:CiphersuiteName) {
    const { groupInfo, charlie } = await makeAliceGroupWithExternalSender(cipherSuite)

    const externalInitProposal:Proposal = {
        proposalType: 'external_init',
        externalInit: {
            kemOutput: new Uint8Array(32),
        },
    }

    let threw = false
    try {
        await proposeExternal(
            groupInfo,
            externalInitProposal,
            charlie.publicPackage.leafNode.signaturePublicKey,
            charlie.privatePackage.signaturePrivateKey,
            (await getCipherSuite(getCiphersuiteFromName(cipherSuite))),
        )
    } catch (error) {
        threw = true
        t.ok(error instanceof UsageError, 'should throw a UsageError')
    }

    t.ok(threw, 'constructing an external ExternalInit proposal should throw')
}
