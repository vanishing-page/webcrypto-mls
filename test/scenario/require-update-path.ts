import { test } from '@substrate-system/tapzero'
import {
    applyProposals,
    createGroup,
    joinGroup,
    makePskIndex
} from '../../src/client-state.js'
import { createCommit } from '../../src/create-commit.js'
import { processPublicMessage } from '../../src/process-messages.js'
import { emptyPskIndex } from '../../src/psk-index.js'
import type { Credential } from '../../src/credential.js'
import type { CiphersuiteName } from '../../src/crypto/ciphersuite.js'
import {
    ciphersuites,
    getCiphersuiteFromName
} from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import { deriveSecret } from '../../src/crypto/kdf.js'
import { generateKeyPackage } from '../../src/key-package.js'
import type { ProposalAdd, ProposalRemove } from '../../src/proposal.js'
import { createConfirmationTag, createContentCommitSignature } from '../../src/framed-content.js'
import type { FramedContentAuthDataCommit } from '../../src/framed-content.js'
import { protectPublicMessage } from '../../src/message-protection-public.js'
import { createUpdatePath } from '../../src/update-path.js'
import { toLeafIndex } from '../../src/treemath.js'
import { defaultLifetime } from '../../src/lifetime.js'
import { defaultCapabilities } from '../../src/default-capabilities.js'

for (const cs of Object.keys(ciphersuites)) {
    test('Single-remove commit requires UpdatePath ' + cs, async (t) => {
        try {
            await singleRemoveRequiresPath(t, cs as CiphersuiteName)
        } catch (error:any) {
            if (error?.name === 'NotSupportedError' || error?.name === 'DependencyError') {
                t.comment(`Skipping ${cs}: ${error.message}`)
                return
            }
            throw error
        }
    })
}

async function singleRemoveRequiresPath (t:any, cipherSuite:CiphersuiteName) {
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

    const addBobProposal:ProposalAdd = {
        proposalType: 'add',
        add: { keyPackage: bob.publicPackage },
    }

    const addBobCommitResult = await createCommit(
        { state: aliceGroup, cipherSuite: impl },
        { extraProposals: [addBobProposal] },
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

    const removeBobProposal:ProposalRemove = {
        proposalType: 'remove',
        remove: { removed: bobGroup.privatePath.leafIndex },
    }

    // createCommit must generate an UpdatePath for a single-Remove commit
    const removeBobCommitResult = await createCommit(
        { state: aliceGroup, cipherSuite: impl },
        { extraProposals: [removeBobProposal], wireAsPublicMessage: true },
    )

    if (removeBobCommitResult.commit.wireformat !== 'mls_public_message') {
        throw new Error('Expected public message')
    }

    t.ok(
        removeBobCommitResult.commit.publicMessage.content.contentType === 'commit' &&
            removeBobCommitResult.commit.publicMessage.content.commit.path !== undefined,
        'a single-Remove commit should carry an UpdatePath',
    )

    // the commit secret used for the resulting epoch must be non-zero,
    // so the removed member cannot derive the new epoch secrets
    const applied = await applyProposals(
        aliceGroup,
        [{ proposalOrRefType: 'proposal', proposal: removeBobProposal }],
        toLeafIndex(aliceGroup.privatePath.leafIndex),
        emptyPskIndex,
        true,
        impl,
    )

    t.ok(applied.needsUpdatePath, 'a single Remove should require an update path')

    const [, , pathSecrets] = await createUpdatePath(
        applied.tree,
        toLeafIndex(aliceGroup.privatePath.leafIndex),
        aliceGroup.groupContext,
        aliceGroup.signaturePrivateKey,
        impl,
    )

    const lastPathSecret = pathSecrets.at(-1)
    t.ok(lastPathSecret !== undefined, 'an UpdatePath should produce path secrets')

    const commitSecret = await deriveSecret(lastPathSecret!.secret, 'path', impl.kdf)
    const isAllZero = commitSecret.every((byte) => byte === 0)
    t.ok(!isAllZero, 'commit secret should be non-zero when an UpdatePath is used')

    // process-messages must reject a received commit that covers a single
    // Remove and has no path
    const noPathCommit = await createContentCommitSignature(
        aliceGroup.groupContext,
        'mls_public_message',
        { proposals: [{ proposalOrRefType: 'proposal', proposal: removeBobProposal }], path: undefined },
        { senderType: 'member', leafIndex: aliceGroup.privatePath.leafIndex },
        new Uint8Array(),
        aliceGroup.signaturePrivateKey,
        impl.signature,
    )

    const fakeConfirmationTag = await createConfirmationTag(
        new Uint8Array(impl.kdf.size),
        await impl.hash.digest(new Uint8Array()),
        impl.hash,
    )

    const authData:FramedContentAuthDataCommit = {
        contentType: 'commit',
        signature: noPathCommit.signature,
        confirmationTag: fakeConfirmationTag,
    }

    const pm = await protectPublicMessage(
        aliceGroup.keySchedule.membershipKey,
        aliceGroup.groupContext,
        {
            wireformat: 'mls_public_message',
            content: noPathCommit.framedContent,
            auth: authData,
        },
        impl,
    )

    await t.throws(async () => {
        await processPublicMessage(bobGroup, pm, makePskIndex(bobGroup, {}), impl)
    }, 'should reject a single-Remove commit with no UpdatePath')

    // sanity: the well-formed commit (with path) is accepted normally
    if (removeBobCommitResult.commit.wireformat !== 'mls_public_message') throw new Error('unreachable')

    const bobProcessResult = await processPublicMessage(
        bobGroup,
        removeBobCommitResult.commit.publicMessage,
        makePskIndex(bobGroup, {}),
        impl,
    )

    bobGroup = bobProcessResult.newState

    t.deepEqual(bobGroup.groupActiveState, { kind: 'removedFromGroup' }, 'bob should be removed')
}
