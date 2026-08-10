import { test } from '@substrate-system/tapzero'
import { createGroup } from '../../src/client-state.js'
import { createGroupInfoWithExternalPub } from '../../src/create-commit.js'
import { processPublicMessage } from '../../src/process-messages.js'
import { emptyPskIndex } from '../../src/psk-index.js'
import type { Credential } from '../../src/credential.js'
import type { CiphersuiteName } from '../../src/crypto/ciphersuite.js'
import { getCiphersuiteFromName } from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import { generateKeyPackage } from '../../src/key-package.js'
import type { Proposal } from '../../src/proposal.js'
import { defaultLifetime } from '../../src/lifetime.js'
import { defaultCapabilities } from '../../src/default-capabilities.js'
import type { ExternalSender } from '../../src/external-sender.js'
import { encodeExternalSenders } from '../../src/external-sender.js'
import type { Extension } from '../../src/extension.js'
import type { FramedContent } from '../../src/framed-content.js'
import { signFramedContentApplicationOrProposal } from '../../src/framed-content.js'
import type { ExternalPublicMessage } from '../../src/public-message.js'
import { ValidationError } from '../../src/mls-error.js'
import { testCiphersuites } from '../helpers/suite-filter.js'
import { testClientConfig } from '../helpers/client-config.js'

for (const cs of testCiphersuites()) {
    test(`Proposal with future epoch is rejected ${cs}`, async (t) => {
        try {
            await futureEpochProposalTest(cs as CiphersuiteName, t)
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

async function futureEpochProposalTest (cipherSuite:CiphersuiteName, t:any) {
    const impl = await getCipherSuite(getCiphersuiteFromName(cipherSuite))

    const aliceCredential:Credential = {
        credentialType: 'basic',
        identity: new TextEncoder().encode('alice'),
    }
    const alice = await generateKeyPackage(
        aliceCredential,
        defaultCapabilities(),
        defaultLifetime(),
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
        defaultLifetime(),
        [],
        impl,
    )

    const groupId = new TextEncoder().encode('group1')

    const externalSender:ExternalSender = {
        credential: charlieCredential,
        signaturePublicKey: charlie.publicPackage.leafNode.signaturePublicKey,
    }

    const extension:Extension = {
        extensionType: 'external_senders',
        extensionData: encodeExternalSenders([externalSender]),
    }

    const aliceGroup = await createGroup(groupId, alice.publicPackage, alice.privatePackage, [extension], impl, testClientConfig)

    // external pub not really necessary here
    const groupInfo = await createGroupInfoWithExternalPub(aliceGroup, [], impl)

    const removeNobodyProposal:Proposal = {
        proposalType: 'remove',
        remove: {
            removed: 0,
        },
    }

    // Forge a proposal claiming a future epoch (current + 1), while signing
    // over the real, current groupContext -- so the signature verifies
    // against the receiver's actual state even though the epoch field the
    // receiver would cache the proposal under does not match.
    const framedContent:FramedContent = {
        groupId: groupInfo.groupContext.groupId,
        epoch: groupInfo.groupContext.epoch + 1n,
        sender: { senderType: 'external', senderIndex: 0 },
        contentType: 'proposal',
        authenticatedData: new Uint8Array(),
        proposal: removeNobodyProposal,
    }

    const tbs = {
        protocolVersion: groupInfo.groupContext.version,
        wireformat: 'mls_public_message',
        content: framedContent,
        senderType: 'external',
        context: groupInfo.groupContext,
    } as const

    const auth = await signFramedContentApplicationOrProposal(
        charlie.privatePackage.signaturePrivateKey,
        tbs,
        impl,
    )

    const forgedMessage:ExternalPublicMessage = {
        content: framedContent,
        auth,
        senderType: 'external',
    }

    let thrown:unknown
    try {
        await processPublicMessage(aliceGroup, forgedMessage, emptyPskIndex, impl)
    } catch (error) {
        thrown = error
    }

    t.ok(thrown instanceof ValidationError, 'proposal framed for a future epoch throws ValidationError')
}
