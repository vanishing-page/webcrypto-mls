import { test } from '@substrate-system/tapzero'
import { createGroup } from '../../src/client-state.js'
import { createGroupInfoWithExternalPub } from '../../src/create-commit.js'
import { processPublicMessage } from '../../src/process-messages.js'
import { proposeExternal } from '../../src/external-proposal.js'
import { emptyPskIndex } from '../../src/psk-index.js'
import { MlsError, UsageError } from '../../src/mls-error.js'
import type { Credential } from '../../src/credential.js'
import type { CiphersuiteName } from '../../src/crypto/ciphersuite.js'
import { ciphersuites, getCiphersuiteFromName } from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import { generateKeyPackage } from '../../src/key-package.js'
import type { Proposal } from '../../src/proposal.js'
import type { PublicMessage } from '../../src/public-message.js'
import type { ExternalSender } from '../../src/external-sender.js'
import { encodeExternalSenders } from '../../src/external-sender.js'
import type { Extension } from '../../src/extension.js'
import { defaultLifetime } from '../../src/lifetime.js'
import { defaultCapabilities } from '../../src/default-capabilities.js'

for (const cs of Object.keys(ciphersuites)) {
    test('external sender Update proposal rejected ' + cs, async (t) => {
        try {
            await externalUpdateRejected(t, cs as CiphersuiteName)
        } catch (error:any) {
            if (error?.name === 'NotSupportedError' || error?.name === 'DependencyError') {
                t.comment(`Skipping ${cs}: ${error.message}`)
                return
            }
            throw error
        }
    })

    test('external sender application message rejected ' + cs, async (t) => {
        try {
            await externalApplicationRejected(t, cs as CiphersuiteName)
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

    return { impl, aliceGroup, charlie }
}

async function externalUpdateRejected (t:any, cipherSuite:CiphersuiteName) {
    const { impl, aliceGroup, charlie } = await makeAliceGroupWithExternalSender(cipherSuite)

    const groupInfo = await createGroupInfoWithExternalPub(aliceGroup, [], impl)

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
            impl,
        )
    } catch (error) {
        threw = true
        t.ok(error instanceof UsageError, 'should throw a UsageError')
    }

    t.ok(threw, 'an external sender constructing an Update proposal should be rejected')
}

async function externalApplicationRejected (t:any, cipherSuite:CiphersuiteName) {
    const { impl, aliceGroup } = await makeAliceGroupWithExternalSender(cipherSuite)

    const externalApplicationMessage:PublicMessage = {
        content: {
            groupId: aliceGroup.groupContext.groupId,
            epoch: aliceGroup.groupContext.epoch,
            sender: { senderType: 'external', senderIndex: 0 },
            authenticatedData: new Uint8Array(),
            contentType: 'application',
            applicationData: new TextEncoder().encode('hello'),
        },
        auth: {
            contentType: 'application',
            signature: new Uint8Array(64),
        },
        senderType: 'external',
    }

    let threw = false
    try {
        await processPublicMessage(aliceGroup, externalApplicationMessage, emptyPskIndex, impl)
    } catch (error) {
        threw = true
        t.ok(error instanceof MlsError, 'should throw an MlsError')
    }

    t.ok(threw, 'an external sender sending an application message should be rejected')
}
