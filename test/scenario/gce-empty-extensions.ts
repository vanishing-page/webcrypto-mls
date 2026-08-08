import { test } from '@substrate-system/tapzero'
import { createGroup, joinGroup, makePskIndex } from '../../src/client-state.js'
import { createCommit } from '../../src/create-commit.js'
import { processPrivateMessage } from '../../src/process-messages.js'
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
import type { Proposal } from '../../src/proposal.js'

for (const cs of Object.keys(ciphersuites)) {
    test('An empty GroupContextExtensions proposal clears group extensions ' + cs, async (t) => {
        try {
            await emptyGroupContextExtensionsClearsExtensions(t, cs as CiphersuiteName)
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

async function emptyGroupContextExtensionsClearsExtensions (
    t:any,
    cipherSuite:CiphersuiteName,
):Promise<void> {
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

    const groupId = new TextEncoder().encode('group1')

    // group_context_extensions/application_id in a default extension type,
    // so it is exempt from the extensionsSupportedByCapabilities check --
    // its presence at creation isn't what's under test.
    let aliceGroup = await createGroup(
        groupId,
        alice.publicPackage,
        alice.privatePackage,
        [{ extensionType: 'application_id', extensionData: new Uint8Array([1, 2, 3]) }],
        impl,
    )

    const bobCredential:Credential = {
        credentialType: 'basic',
        identity: new TextEncoder().encode('bob'),
    }
    const bob = await generateKeyPackage(
        bobCredential,
        defaultCapabilities(),
        defaultLifetime(),
        [],
        impl,
    )

    const addBobCommitResult = await createCommit(
        { state: aliceGroup, cipherSuite: impl },
        { extraProposals: [{ proposalType: 'add', add: { keyPackage: bob.publicPackage } }] },
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

    t.equal(aliceGroup.groupContext.extensions.length, 1, 'alice starts with one group extension')

    const emptyGceProposal:Proposal = {
        proposalType: 'group_context_extensions',
        groupContextExtensions: { extensions: [] },
    }

    const clearExtensionsCommitResult = await createCommit(
        { state: aliceGroup, cipherSuite: impl },
        { extraProposals: [emptyGceProposal] },
    )

    aliceGroup = clearExtensionsCommitResult.newState

    if (clearExtensionsCommitResult.commit.wireformat !== 'mls_private_message') {
        throw new Error('Expected private message')
    }

    const bobProcessResult = await processPrivateMessage(
        bobGroup,
        clearExtensionsCommitResult.commit.privateMessage,
        makePskIndex(bobGroup, {}),
        impl,
    )

    bobGroup = bobProcessResult.newState

    t.equal(aliceGroup.groupContext.extensions.length, 0, 'committer group context has no extensions')
    t.equal(bobGroup.groupContext.extensions.length, 0, 'receiver group context has no extensions')
    t.deepEqual(
        bobGroup.keySchedule.epochAuthenticator,
        aliceGroup.keySchedule.epochAuthenticator,
        'epoch authenticators should match',
    )
}
