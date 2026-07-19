import { test } from '@substrate-system/tapzero'
import { createGroup } from '../../src/client-state.js'
import { createGroupInfoWithExternalPub } from '../../src/create-commit.js'
import { processPublicMessage } from '../../src/process-messages.js'
import { emptyPskIndex } from '../../src/psk-index.js'
import type { Credential } from '../../src/credential.js'
import type { CiphersuiteName } from '../../src/crypto/ciphersuite.js'
import {
    getCiphersuiteFromName,
    ciphersuites
} from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import { generateKeyPackage } from '../../src/key-package.js'
import { defaultLifetime } from '../../src/lifetime.js'
import { defaultCapabilities } from '../../src/default-capabilities.js'
import type { ExternalSender } from '../../src/external-sender.js'
import { encodeExternalSenders } from '../../src/external-sender.js'
import type { Extension } from '../../src/extension.js'
import { proposeAddExternal } from '../../src/external-proposal.js'

for (const cs of Object.keys(ciphersuites)) {
    test(`Cross-group replay rejected ${cs}`, async (t) => {
        try {
            await crossGroupReplayTest(cs as CiphersuiteName, t)
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

async function crossGroupReplayTest (cipherSuite:CiphersuiteName, t:any) {
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

    const bobCredential:Credential = {
        credentialType: 'basic',
        identity: new TextEncoder().encode('bob'),
    }
    const bob = await generateKeyPackage(
        bobCredential,
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

    // Group A: alice, external sender charlie
    const groupIdA = new TextEncoder().encode('groupA')
    const aliceGroup = await createGroup(
        groupIdA,
        alice.publicPackage,
        alice.privatePackage,
        [extension],
        impl,
    )

    // Group B: bob, same external sender charlie, different groupId
    const groupIdB = new TextEncoder().encode('groupB')
    const bobGroup = await createGroup(
        groupIdB,
        bob.publicPackage,
        bob.privatePackage,
        [extension],
        impl,
    )

    // charlie proposes to add itself in group A
    const groupInfoA = await createGroupInfoWithExternalPub(aliceGroup, [], impl)
    const addCharlieProposalA = await proposeAddExternal(
        groupInfoA,
        charlie.publicPackage,
        charlie.privatePackage,
        impl,
    )

    if (addCharlieProposalA.wireformat !== 'mls_public_message') {
        throw new Error('Expected public message')
    }

    // sanity check: group A itself accepts its own proposal
    const aliceProcessResult = await processPublicMessage(
        aliceGroup,
        addCharlieProposalA.publicMessage,
        emptyPskIndex,
        impl,
    )
    t.ok(aliceProcessResult.newState, 'group A accepts its own external proposal')

    // replaying group A's external-sender proposal into group B must be
    // rejected because the message's groupId doesn't match group B's
    let threw = false
    try {
        await processPublicMessage(
            bobGroup,
            addCharlieProposalA.publicMessage,
            emptyPskIndex,
            impl,
        )
    } catch (error:any) {
        threw = true
        t.equal(error.name, 'ValidationError', 'rejects cross-group replay with a ValidationError')
    }
    t.ok(threw, 'group B rejects a proposal replayed from group A')
}
