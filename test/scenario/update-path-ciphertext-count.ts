import { test } from '@substrate-system/tapzero'
import { createGroup, joinGroup, makePskIndex } from '../../src/client-state.js'
import { createCommit } from '../../src/create-commit.js'
import { createContentCommitSignature } from '../../src/framed-content.js'
import { protectPublicMessage } from '../../src/message-protection-public.js'
import { processPublicMessage } from '../../src/process-messages.js'
import { emptyPskIndex } from '../../src/psk-index.js'
import type { Credential } from '../../src/credential.js'
import type { CiphersuiteName } from '../../src/crypto/ciphersuite.js'
import { getCiphersuiteFromName } from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import { generateKeyPackage } from '../../src/key-package.js'
import type { ProposalAdd } from '../../src/proposal.js'
import { defaultLifetime } from '../../src/lifetime.js'
import { defaultCapabilities } from '../../src/default-capabilities.js'
import type { FramedContentAuthDataCommit } from '../../src/framed-content.js'
import type { AuthenticatedContentCommit } from '../../src/authenticated-content.js'
import { ValidationError } from '../../src/mls-error.js'
import { testCiphersuites } from '../helpers/suite-filter.js'

// Regression test for US-004: a malicious committer can truncate an
// UpdatePathNode's encrypted_path_secret vector below what the copath
// resolution requires. Before the fix, the receiver's
// applyUpdatePathSecret used non-null assertions to index into that
// vector and the missing resolution overlap, throwing a raw TypeError
// (or worse, silently reading undefined) instead of a ValidationError.
for (const cs of testCiphersuites()) {
    test(`UpdatePathNode with too few ciphertexts is rejected ${cs}`, async (t) => {
        try {
            await tooFewCiphertextsTest(cs as CiphersuiteName, t)
        } catch (error:any) {
            if (error?.name === 'NotSupportedError' || error?.name === 'DependencyError') {
                t.comment(`Skipping ${cs}: ${error.message}`)
                return
            }
            throw error
        }
    })
}

async function tooFewCiphertextsTest (cipherSuite:CiphersuiteName, t:any) {
    const impl = await getCipherSuite(getCiphersuiteFromName(cipherSuite))

    async function makeMember (name:string) {
        const credential:Credential = {
            credentialType: 'basic',
            identity: new TextEncoder().encode(name),
        }
        return generateKeyPackage(
            credential,
            defaultCapabilities(),
            defaultLifetime(),
            [],
            impl,
        )
    }

    const alice = await makeMember('alice')
    const bob = await makeMember('bob')
    const charlie = await makeMember('charlie')
    const dave = await makeMember('dave')

    const groupId = new TextEncoder().encode('group1')

    let aliceGroup = await createGroup(groupId, alice.publicPackage, alice.privatePackage, [], impl)

    const addBobProposal:ProposalAdd = { proposalType: 'add', add: { keyPackage: bob.publicPackage } }
    const addCharlieProposal:ProposalAdd = { proposalType: 'add', add: { keyPackage: charlie.publicPackage } }
    const addDaveProposal:ProposalAdd = { proposalType: 'add', add: { keyPackage: dave.publicPackage } }

    // Reach a 4-leaf tree so at least one UpdatePathNode's copath
    // resolution has more than one entry (more than one ciphertext
    // required), giving room to truncate below the required count.
    const addAllCommitResult = await createCommit(
        { state: aliceGroup, cipherSuite: impl },
        { extraProposals: [addBobProposal, addCharlieProposal, addDaveProposal] },
    )

    aliceGroup = addAllCommitResult.newState

    const bobGroup = await joinGroup(
        addAllCommitResult.welcome!,
        bob.publicPackage,
        bob.privatePackage,
        emptyPskIndex,
        impl,
        aliceGroup.ratchetTree,
    )

    // A plain, empty-proposal commit still carries an UpdatePath.
    const preTamperGroupContext = aliceGroup.groupContext
    const membershipKey = aliceGroup.keySchedule.membershipKey

    const updatePathCommitResult = await createCommit(
        { state: aliceGroup, cipherSuite: impl },
        { wireAsPublicMessage: true },
    )

    if (updatePathCommitResult.commit.wireformat !== 'mls_public_message') {
        throw new Error('Expected public message')
    }

    const originalContent = updatePathCommitResult.commit.publicMessage.content
    const originalAuth = updatePathCommitResult.commit.publicMessage.auth
    if (originalContent.contentType !== 'commit' || originalContent.commit.path === undefined) {
        throw new Error('Expected a commit with an UpdatePath')
    }
    if (originalAuth.contentType !== 'commit') {
        throw new Error('Expected commit auth data')
    }

    const nodeToTamperIndex = originalContent.commit.path.nodes.findIndex(
        (n) => n.encryptedPathSecret.length > 0,
    )
    t.ok(nodeToTamperIndex >= 0, 'at least one UpdatePathNode should require a ciphertext')

    const tamperedNodes = originalContent.commit.path.nodes.map((n, idx) =>
        idx === nodeToTamperIndex
            ? { ...n, encryptedPathSecret: n.encryptedPathSecret.slice(0, -1) }
            : n,
    )

    const tamperedContent = {
        ...originalContent,
        commit: {
            ...originalContent.commit,
            path: { ...originalContent.commit.path, nodes: tamperedNodes },
        },
    }

    // Re-sign the tampered content with the committer's real key, and
    // recompute the membership tag, so the receiver's authenticity
    // checks pass and the tampered ciphertext count is what's actually
    // being tested.
    const { signature } = await createContentCommitSignature(
        preTamperGroupContext,
        'mls_public_message',
        tamperedContent.commit,
        tamperedContent.sender,
        tamperedContent.authenticatedData,
        alice.privatePackage.signaturePrivateKey,
        impl.signature,
    )

    const authData:FramedContentAuthDataCommit = {
        contentType: 'commit',
        signature,
        confirmationTag: originalAuth.confirmationTag,
    }

    const authenticatedContent:AuthenticatedContentCommit = {
        wireformat: 'mls_public_message',
        content: tamperedContent,
        auth: authData,
    }

    const tamperedPublicMessage = await protectPublicMessage(
        membershipKey,
        preTamperGroupContext,
        authenticatedContent,
        impl,
    )

    let thrown:unknown
    try {
        await processPublicMessage(bobGroup, tamperedPublicMessage, makePskIndex(bobGroup, {}), impl)
    } catch (error) {
        thrown = error
    }

    t.ok(thrown instanceof ValidationError,
        'commit with an UpdatePathNode missing required ciphertexts throws ValidationError')
}
