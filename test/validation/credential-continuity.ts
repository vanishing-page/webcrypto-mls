import { test } from '@substrate-system/tapzero'
import { skipReason } from '../helpers/skip.js'
import {
    createGroup,
    joinGroup,
    makePskIndex,
    validateLeafNodeUpdateOrCommit
} from '../../src/client-state.js'
import {
    createCommit,
    createGroupInfoWithExternalPubAndRatchetTree,
    joinGroupExternal,
} from '../../src/create-commit.js'
import { createProposal } from '../../src/create-message.js'
import {
    processMessage,
    processPublicMessage,
} from '../../src/process-messages.js'
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
import type {
    LeafNodeKeyPackage,
    LeafNodeTBSKeyPackage,
    LeafNodeUpdate,
} from '../../src/leaf-node.js'
import { encodeLeafNodeTBS, signLeafNodeCommit } from '../../src/leaf-node.js'
import type { KeyPackage } from '../../src/key-package.js'
import { generateKeyPackage, signKeyPackage } from '../../src/key-package.js'
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
                t.comment(`Skipping ${cs}: ${skipReason(error)}`)
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
                t.comment(`Skipping ${cs}: ${skipReason(error)}`)
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
                t.comment(`Skipping ${cs}: ${skipReason(error)}`)
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

    // an Update is validated when it arrives, so the refusal comes from
    // processMessage rather than from the next commit that would bundle it
    try {
        await processMessage(
            proposalMessage,
            withAuthService(aliceGroup, continuityService),
            emptyPskIndex,
            acceptAll,
            impl,
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

// An external commit that carries a Remove is a resync: the joiner replaces
// its own prior leaf. The Remove only demands an equal signature key, so
// without the prior credential the service cannot see a resync that also
// changes the identity.
for (const cs of sampleCiphersuites()) {
    test('a resync shows the service the removed leaf\'s credential - ' +
        cs, async (t) => {
        try {
            await resyncSeesPriorCredential(t, cs as CiphersuiteName)
        } catch (error:any) {
            if (isUnsupported(error)) {
                t.comment(`Skipping ${cs}: ${skipReason(error)}`)
                return
            }
            throw error
        }
    })

    test('every member rejects an identity-changing resync - ' + cs,
        async (t) => {
            try {
                await resyncIdentityChangeRejected(
                    t,
                    cs as CiphersuiteName,
                )
            } catch (error:any) {
                if (isUnsupported(error)) {
                    t.comment(`Skipping ${cs}: ${skipReason(error)}`)
                    return
                }
                throw error
            }
        })

    test('a resync under the same identity is accepted - ' + cs,
        async (t) => {
            try {
                await resyncSameIdentityAccepted(t, cs as CiphersuiteName)
            } catch (error:any) {
                if (isUnsupported(error)) {
                    t.comment(`Skipping ${cs}: ${skipReason(error)}`)
                    return
                }
                throw error
            }
        })

    test('an external join without a Remove has no prior credential - ' +
        cs, async (t) => {
        try {
            await externalJoinHasNoPriorCredential(
                t,
                cs as CiphersuiteName,
            )
        } catch (error:any) {
            if (isUnsupported(error)) {
                t.comment(`Skipping ${cs}: ${skipReason(error)}`)
                return
            }
            throw error
        }
    })
}

/**
 * Records the `priorCredential` seen for each credential it is asked about,
 * keyed by identity, and accepts everything.
 */
function recordingService () {
    const seen:Array<{ identity:string, prior:Credential|undefined }> = []
    const service:AuthenticationService = {
        async validateCredential (credential, _key, priorCredential) {
            if (credential.credentialType === 'basic') {
                seen.push({
                    identity: new TextDecoder().decode(credential.identity),
                    prior: priorCredential,
                })
            }
            return true
        },
    }
    return { seen, service }
}

/**
 * Alice, Bob and Charlie in one group, plus the GroupInfo Charlie would
 * resync from.
 */
async function threeMemberGroup (cipherSuite:CiphersuiteName) {
    const impl = await getCipherSuite(getCiphersuiteFromName(cipherSuite))

    const alice = await makeMember('alice', impl)
    const bob = await makeMember('bob', impl)
    const charlie = await makeMember('charlie', impl)

    const aliceGroup = await createGroup(
        new TextEncoder().encode('group1'),
        alice.publicPackage,
        alice.privatePackage,
        [],
        impl,
        testClientConfig,
    )

    const addCommit = await createCommit(
        { state: aliceGroup, cipherSuite: impl },
        {
            extraProposals: [bob, charlie].map((m):ProposalAdd => ({
                proposalType: 'add',
                add: { keyPackage: m.publicPackage },
            })),
            ratchetTreeExtension: true,
        },
    )

    const bobGroup = await joinGroup(
        addCommit.welcome!,
        bob.publicPackage,
        bob.privatePackage,
        emptyPskIndex,
        impl,
        undefined,
        undefined,
        testClientConfig,
    )

    const groupInfo = await createGroupInfoWithExternalPubAndRatchetTree(
        addCommit.newState,
        [],
        impl,
    )

    return {
        impl,
        charlie,
        aliceGroup: addCommit.newState,
        bobGroup,
        groupInfo,
    }
}

/**
 * Charlie's KeyPackage re-signed under the same signature key but a new
 * identity, so the resync Remove still matches Charlie's prior leaf.
 */
async function renamedKeyPackage (
    member:Awaited<ReturnType<typeof makeMember>>,
    identity:string,
    impl:CiphersuiteImpl,
):Promise<KeyPackage> {
    const { signature: _sig, ...leafTbs } = member.publicPackage.leafNode
    const tbs = {
        ...leafTbs,
        credential: {
            credentialType: 'basic' as const,
            identity: new TextEncoder().encode(identity),
        },
    } as LeafNodeTBSKeyPackage

    const leafNode = {
        ...tbs,
        signature: await signWithLabel(
            member.privatePackage.signaturePrivateKey,
            'LeafNodeTBS',
            encodeLeafNodeTBS(tbs),
            impl.signature,
        ),
    } as LeafNodeKeyPackage

    const { signature: _kpSig, ...kpTbs } = member.publicPackage
    return signKeyPackage(
        { ...kpTbs, leafNode },
        member.privatePackage.signaturePrivateKey,
        impl.signature,
    )
}

async function resync (
    cipherSuite:CiphersuiteName,
    identity:string,
) {
    const group = await threeMemberGroup(cipherSuite)
    const { impl, charlie, groupInfo } = group

    const keyPackage = identity === 'charlie' ?
        charlie.publicPackage :
        await renamedKeyPackage(charlie, identity, impl)

    const joined = await joinGroupExternal(
        groupInfo,
        keyPackage,
        charlie.privatePackage,
        true,
        impl,
        undefined,
        testClientConfig,
    )

    return { ...group, message: joined.publicMessage }
}

async function resyncSeesPriorCredential (
    t:any,
    cipherSuite:CiphersuiteName,
) {
    const { impl, aliceGroup, message } =
        await resync(cipherSuite, 'charlie-the-admin')
    const { seen, service } = recordingService()

    await processPublicMessage(
        withAuthService(aliceGroup, service),
        message,
        makePskIndex(aliceGroup, {}),
        impl,
    )

    const joiner = seen.find((s) => s.identity === 'charlie-the-admin')
    const prior = joiner?.prior
    t.ok(
        prior !== undefined &&
            prior.credentialType === 'basic' &&
            new TextDecoder().decode(prior.identity) === 'charlie',
        'the service should see the removed leaf\'s credential',
    )
}

async function resyncIdentityChangeRejected (
    t:any,
    cipherSuite:CiphersuiteName,
) {
    const { impl, aliceGroup, bobGroup, message } =
        await resync(cipherSuite, 'charlie-the-admin')

    for (const [name, state] of [
        ['alice', aliceGroup],
        ['bob', bobGroup],
    ] as const) {
        try {
            await processPublicMessage(
                withAuthService(state, continuityService),
                message,
                makePskIndex(state, {}),
                impl,
            )
            t.fail(`${name} should reject the identity-changing resync`)
        } catch (error) {
            t.ok(
                error instanceof ValidationError,
                `${name} rejects an identity-changing resync with ` +
                    'ValidationError',
            )
        }
    }
}

async function resyncSameIdentityAccepted (
    t:any,
    cipherSuite:CiphersuiteName,
) {
    const { impl, aliceGroup, message } =
        await resync(cipherSuite, 'charlie')

    const result = await processPublicMessage(
        withAuthService(aliceGroup, continuityService),
        message,
        makePskIndex(aliceGroup, {}),
        impl,
    )

    t.ok(
        result.newState.groupContext.epoch > aliceGroup.groupContext.epoch,
        'a resync that keeps the identity is accepted',
    )
}

async function externalJoinHasNoPriorCredential (
    t:any,
    cipherSuite:CiphersuiteName,
) {
    const { impl, aliceGroup, groupInfo } =
        await threeMemberGroup(cipherSuite)
    const dave = await makeMember('dave', impl)

    const joined = await joinGroupExternal(
        groupInfo,
        dave.publicPackage,
        dave.privatePackage,
        false,
        impl,
        undefined,
        testClientConfig,
    )

    const { seen, service } = recordingService()
    await processPublicMessage(
        withAuthService(aliceGroup, service),
        joined.publicMessage,
        makePskIndex(aliceGroup, {}),
        impl,
    )

    const joiner = seen.filter((s) => s.identity === 'dave')
    t.ok(joiner.length > 0, 'the joiner\'s credential is checked')
    t.ok(
        joiner.every((s) => s.prior === undefined),
        'with no Remove there is no prior credential',
    )
}
