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
import { getCiphersuiteFromName } from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import { generateKeyPackage } from '../../src/key-package.js'
import type { Proposal, ProposalAdd } from '../../src/proposal.js'
import {
    createConfirmationTag,
    createContentCommitSignature
} from '../../src/framed-content.js'
import type { FramedContentAuthDataCommit } from '../../src/framed-content.js'
import { protectPublicMessage } from '../../src/message-protection-public.js'
import { toLeafIndex } from '../../src/treemath.js'
import { defaultLifetime } from '../../src/lifetime.js'
import type { Capabilities } from '../../src/capabilities.js'
import { testCiphersuites } from '../helpers/suite-filter.js'
import { testClientConfig } from '../helpers/client-config.js'

for (const cs of testCiphersuites()) {
    test('Custom-proposal commit requires UpdatePath ' + cs, async (t) => {
        try {
            await customProposalRequiresPath(t, cs as CiphersuiteName)
        } catch (error:any) {
            if (
                error?.name === 'NotSupportedError' ||
                error?.name === 'DependencyError'
            ) {
                t.comment(`Skipping ${cs}: ${error.message}`)
                return
            }
            throw error
        }
    })
}

/**
 * RFC 9420 SS12.4: a commit carrying any proposal other than add, psk or
 * reinit must include an UpdatePath. A custom (numeric) proposal type is
 * not one of the exceptions, so a custom-only commit has to rotate keys.
 */
async function customProposalRequiresPath (t:any, cipherSuite:CiphersuiteName) {
    const impl = await getCipherSuite(getCiphersuiteFromName(cipherSuite))

    const customProposalType:number = 8

    const capabilities:Capabilities = {
        extensions: [],
        credentials: ['basic'],
        proposals: [customProposalType],
        versions: ['mls10'],
        ciphersuites: [cipherSuite],
    }

    const clientConfig = {
        ...testClientConfig,
        supportedCustomProposalTypes: [customProposalType],
    }

    const aliceCredential:Credential = {
        credentialType: 'basic',
        identity: new TextEncoder().encode('alice'),
    }
    const alice = await generateKeyPackage(
        aliceCredential,
        capabilities,
        defaultLifetime(),
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
        clientConfig,
    )

    const bobCredential:Credential = {
        credentialType: 'basic',
        identity: new TextEncoder().encode('bob'),
    }
    const bob = await generateKeyPackage(
        bobCredential,
        capabilities,
        defaultLifetime(),
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

    const bobGroup = await joinGroup(
        addBobCommitResult.welcome!,
        bob.publicPackage,
        bob.privatePackage,
        emptyPskIndex,
        impl,
        aliceGroup.ratchetTree,
        undefined,
        clientConfig,
    )

    const customProposal:Proposal = {
        proposalType: customProposalType,
        proposalData: new TextEncoder().encode('custom proposal data'),
    }

    const applied = await applyProposals(
        aliceGroup,
        [{ proposalOrRefType: 'proposal', proposal: customProposal }],
        toLeafIndex(aliceGroup.privatePath.leafIndex),
        emptyPskIndex,
        true,
        impl,
    )

    t.ok(
        applied.needsUpdatePath,
        'a custom-only commit should require an update path',
    )

    // sending side: createCommit must generate the path
    const customCommitResult = await createCommit(
        { state: aliceGroup, cipherSuite: impl },
        { extraProposals: [customProposal], wireAsPublicMessage: true },
    )

    if (customCommitResult.commit.wireformat !== 'mls_public_message') {
        throw new Error('Expected public message')
    }

    t.ok(
        customCommitResult.commit.publicMessage.content.contentType ===
            'commit' &&
            customCommitResult.commit.publicMessage.content.commit.path !==
                undefined,
        'a custom-only commit should carry an UpdatePath',
    )

    // receiving side: a pathless custom-only commit must be rejected
    const noPathCommit = await createContentCommitSignature(
        aliceGroup.groupContext,
        'mls_public_message',
        {
            proposals: [
                { proposalOrRefType: 'proposal', proposal: customProposal },
            ],
            path: undefined,
        },
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

    await t.throws(
        async () => {
            await processPublicMessage(
                bobGroup,
                pm,
                makePskIndex(bobGroup, {}),
                impl,
            )
        },
        /Update path is required/,
        'should reject a custom-only commit with no UpdatePath',
    )

    // sanity: the well-formed commit (with path) is accepted normally
    const bobProcessResult = await processPublicMessage(
        bobGroup,
        customCommitResult.commit.publicMessage,
        makePskIndex(bobGroup, {}),
        impl,
    )

    t.equal(
        bobProcessResult.newState.groupContext.epoch,
        aliceGroup.groupContext.epoch + 1n,
        'bob should advance an epoch on the custom-proposal commit',
    )
}
