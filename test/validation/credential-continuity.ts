import { test } from '@substrate-system/tapzero'
import {
    createGroup,
    joinGroup,
    validateLeafNodeUpdateOrCommit
} from '../../src/client-state.js'
import { createCommit } from '../../src/create-commit.js'
import { createProposal } from '../../src/create-message.js'
import { processMessage } from '../../src/process-messages.js'
import { acceptAll } from '../../src/incoming-message-action.js'
import { emptyPskIndex } from '../../src/psk-index.js'
import type { AuthenticationService } from '../../src/authentication-service.js'
import {
    unsafeAcceptAllAuthenticationService
} from '../../src/authentication-service.js'
import type { ClientState } from '../../src/client-state.js'
import type { Credential } from '../../src/credential.js'
import type { CiphersuiteName, CiphersuiteImpl } from '../../src/crypto/ciphersuite.js'
import { getCiphersuiteFromName } from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import { signWithLabel } from '../../src/crypto/signature.js'
import type { LeafNodeUpdate } from '../../src/leaf-node.js'
import { encodeLeafNodeTBS, signLeafNodeCommit } from '../../src/leaf-node.js'
import { generateKeyPackage } from '../../src/key-package.js'
import type { Proposal, ProposalAdd } from '../../src/proposal.js'
import { defaultLifetime } from '../../src/lifetime.js'
import { defaultCapabilities } from '../../src/default-capabilities.js'
import { ValidationError } from '../../src/mls-error.js'
import { constantTimeEqual } from '../../src/util/constant-time-compare.js'
import { sampleCiphersuites } from '../helpers/suite-filter.js'
import { testClientConfig } from '../helpers/client-config.js'

// RFC 9420 leaves identity continuity to the application, but it can only
// enforce it if it is told what the leaf used to say. Before this check the
// AuthenticationService saw the *new* credential alone, so member Bob could
// send an Update whose credential.identity is "alice" and every peer would
// then attribute Bob's leaf to Alice. The service now receives the credential
// currently at that leaf as a third argument.
for (const cs of sampleCiphersuites()) {
    test('a continuity-enforcing AuthenticationService rejects an ' +
        'identity-changing Update - ' + cs, async (t) => {
        try {
            await identityChangeRejected(t, cs as CiphersuiteName)
        } catch (error:any) {
            if (isUnsupported(error)) {
                t.comment(`Skipping ${cs}: ${error.message}`)
                return
            }
            throw error
        }
    })

    test('the same Update is accepted by a service that permits ' +
        'identity changes - ' + cs, async (t) => {
        try {
            await identityChangeAllowed(t, cs as CiphersuiteName)
        } catch (error:any) {
            if (isUnsupported(error)) {
                t.comment(`Skipping ${cs}: ${error.message}`)
                return
            }
            throw error
        }
    })

    test('a commit UpdatePath leaf is checked against the credential it ' +
        'replaces - ' + cs, async (t) => {
        try {
            await commitPathLeafSeesPriorCredential(t, cs as CiphersuiteName)
        } catch (error:any) {
            if (isUnsupported(error)) {
                t.comment(`Skipping ${cs}: ${error.message}`)
                return
            }
            throw error
        }
    })
}

function isUnsupported (error:any):boolean {
    return error?.name === 'NotSupportedError' ||
        error?.name === 'DependencyError'
}

/**
 * Rejects any leaf replacement whose credential is not byte-identical to the
 * one already at that leaf. This is the hook the audit finding says an
 * application must be able to write, and it is only expressible if
 * `priorCredential` is supplied.
 */
const continuityService:AuthenticationService = {
    async validateCredential (credential, _key, priorCredential) {
        if (priorCredential === undefined) return true
        if (priorCredential.credentialType !== credential.credentialType) {
            return false
        }
        if (
            priorCredential.credentialType === 'basic' &&
            credential.credentialType === 'basic'
        ) {
            return constantTimeEqual(
                priorCredential.identity,
                credential.identity,
            )
        }
        return true
    },
}

function withAuthService (
    state:ClientState,
    authService:AuthenticationService,
):ClientState {
    return {
        ...state,
        clientConfig: { ...state.clientConfig, authService },
    }
}

async function makeMember (name:string, impl:CiphersuiteImpl) {
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

/**
 * Alice and Bob in one group, plus a signed Update from Bob whose credential
 * claims Alice's identity. The Update is minted with Bob's own signing key so
 * the leaf self-signature is genuinely valid -- otherwise the commit would
 * fail on the signature check and the test would pass for the wrong reason.
 */
async function aliceAndBobWithImpostorUpdate (cipherSuite:CiphersuiteName) {
    const impl = await getCipherSuite(getCiphersuiteFromName(cipherSuite))

    const alice = await makeMember('alice', impl)
    const bob = await makeMember('bob', impl)

    const aliceGroup = await createGroup(
        new TextEncoder().encode('group1'),
        alice.publicPackage,
        alice.privatePackage,
        [],
        impl,
        testClientConfig
    )

    const addBob:ProposalAdd = {
        proposalType: 'add',
        add: { keyPackage: bob.publicPackage },
    }

    const addCommit = await createCommit(
        { state: aliceGroup, cipherSuite: impl },
        { extraProposals: [addBob], ratchetTreeExtension: true },
    )

    const bobGroup = await joinGroup(
        addCommit.welcome!,
        bob.publicPackage,
        bob.privatePackage,
        emptyPskIndex,
        impl,
        undefined,
        undefined,
        testClientConfig
    )

    // a fresh encryption key, so the update does not trip the key-uniqueness
    // check for reasons unrelated to the credential
    const bobRotated = await makeMember('bob', impl)

    const tbs = {
        leafNodeSource: 'update' as const,
        hpkePublicKey: bobRotated.publicPackage.leafNode.hpkePublicKey,
        signaturePublicKey: bob.publicPackage.leafNode.signaturePublicKey,
        credential: alice.publicPackage.leafNode.credential,
        capabilities: bob.publicPackage.leafNode.capabilities,
        extensions: bob.publicPackage.leafNode.extensions,
        info: {
            leafNodeSource: 'update' as const,
            groupId: bobGroup.groupContext.groupId,
            leafIndex: bobGroup.privatePath.leafIndex,
        },
    }

    const impostorLeaf:LeafNodeUpdate = {
        ...tbs,
        signature: await signWithLabel(
            bob.privatePackage.signaturePrivateKey,
            'LeafNodeTBS',
            encodeLeafNodeTBS(tbs),
            impl.signature,
        ),
    }

    const update:Proposal = {
        proposalType: 'update',
        update: { leafNode: impostorLeaf },
    }

    const proposalResult = await createProposal(bobGroup, false, update, impl)

    if (proposalResult.message.wireformat !== 'mls_private_message') {
        throw new Error('Expected a private message')
    }

    return {
        impl,
        alice,
        bob,
        bobLeafIndex: bobGroup.privatePath.leafIndex,
        aliceGroup: addCommit.newState,
        proposalMessage: proposalResult.message,
    }
}

async function identityChangeRejected (t:any, cipherSuite:CiphersuiteName) {
    const { impl, aliceGroup, proposalMessage } =
        await aliceAndBobWithImpostorUpdate(cipherSuite)

    const received = await processMessage(
        proposalMessage,
        withAuthService(aliceGroup, continuityService),
        emptyPskIndex,
        acceptAll,
        impl,
    )

    try {
        await createCommit(
            { state: received.newState, cipherSuite: impl },
            { ratchetTreeExtension: true },
        )
        t.fail('the identity-changing Update should have been rejected')
    } catch (error) {
        t.ok(
            error instanceof ValidationError,
            'should throw ValidationError when an Update changes the ' +
                'identity at a leaf',
        )
    }
}

async function identityChangeAllowed (t:any, cipherSuite:CiphersuiteName) {
    const { impl, aliceGroup, proposalMessage } =
        await aliceAndBobWithImpostorUpdate(cipherSuite)

    const received = await processMessage(
        proposalMessage,
        aliceGroup,
        emptyPskIndex,
        acceptAll,
        impl,
    )

    const commit = await createCommit(
        { state: received.newState, cipherSuite: impl },
        { ratchetTreeExtension: true },
    )

    t.ok(
        commit.newState.groupContext.epoch >
            aliceGroup.groupContext.epoch,
        'the permissive default service still accepts the Update',
    )
}

/**
 * The commit direction. `validateLeafNodeUpdateOrCommit` is the same entry
 * point `processMessage` uses for a commit's UpdatePath leaf, called against
 * the tree as it stands before the path is merged, so this exercises the
 * lookup that gives the service the outgoing credential.
 */
async function commitPathLeafSeesPriorCredential (
    t:any,
    cipherSuite:CiphersuiteName,
) {
    const { impl, alice, bob, bobLeafIndex, aliceGroup } =
        await aliceAndBobWithImpostorUpdate(cipherSuite)

    const rotated = await makeMember('bob', impl)

    const pathLeaf = await signLeafNodeCommit(
        {
            leafNodeSource: 'commit',
            parentHash: new Uint8Array([1, 2, 3]),
            hpkePublicKey: rotated.publicPackage.leafNode.hpkePublicKey,
            signaturePublicKey: bob.publicPackage.leafNode.signaturePublicKey,
            credential: alice.publicPackage.leafNode.credential,
            capabilities: bob.publicPackage.leafNode.capabilities,
            extensions: bob.publicPackage.leafNode.extensions,
            info: {
                leafNodeSource: 'commit',
                groupId: aliceGroup.groupContext.groupId,
                leafIndex: bobLeafIndex,
            },
        },
        bob.privatePackage.signaturePrivateKey,
        impl.signature,
    )

    const rejected = await validateLeafNodeUpdateOrCommit(
        pathLeaf,
        bobLeafIndex,
        aliceGroup.groupContext,
        aliceGroup.ratchetTree,
        continuityService,
        impl.signature,
    )

    t.ok(
        rejected instanceof ValidationError,
        'a commit path leaf claiming another identity should be rejected',
    )

    const accepted = await validateLeafNodeUpdateOrCommit(
        pathLeaf,
        bobLeafIndex,
        aliceGroup.groupContext,
        aliceGroup.ratchetTree,
        unsafeAcceptAllAuthenticationService,
        impl.signature,
    )

    t.equal(
        accepted,
        undefined,
        'the same leaf passes under a service that ignores continuity',
    )
}
