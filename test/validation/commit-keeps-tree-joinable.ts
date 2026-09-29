import { test } from '@substrate-system/tapzero'
import { skipReason } from '../helpers/skip.js'
import type { ClientState } from '../../src/client-state.js'
import { createGroup, joinGroup, makePskIndex } from '../../src/client-state.js'
import { createCommit, createGroupInfo } from '../../src/create-commit.js'
import { createProposal } from '../../src/create-message.js'
import {
    processMessage,
    processPublicMessage
} from '../../src/process-messages.js'
import { acceptAll } from '../../src/incoming-message-action.js'
import { emptyPskIndex } from '../../src/psk-index.js'
import type { Capabilities } from '../../src/capabilities.js'
import type { Credential } from '../../src/credential.js'
import type {
    CiphersuiteImpl,
    CiphersuiteName
} from '../../src/crypto/ciphersuite.js'
import { getCiphersuiteFromName } from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import { signWithLabel } from '../../src/crypto/signature.js'
import { createContentCommitSignature } from '../../src/framed-content.js'
import { extractWelcomeSecret } from '../../src/group-info.js'
import type { KeyPackage, PrivateKeyPackage } from '../../src/key-package.js'
import { generateKeyPackage, makeKeyPackageRef } from '../../src/key-package.js'
import type { LeafNodeTBSCommit, LeafNodeUpdate } from '../../src/leaf-node.js'
import { encodeLeafNodeTBS, signLeafNodeCommit } from '../../src/leaf-node.js'
import {
    protectProposalPublic,
    protectPublicMessage
} from '../../src/message-protection-public.js'
import type { Proposal, ProposalAdd } from '../../src/proposal.js'
import { defaultLifetime } from '../../src/lifetime.js'
import { defaultCapabilities } from '../../src/default-capabilities.js'
import { ValidationError } from '../../src/mls-error.js'
import { encryptGroupInfo, encryptGroupSecrets } from '../../src/welcome.js'
import type { Welcome } from '../../src/welcome.js'
import { leafToNodeIndex, toLeafIndex } from '../../src/treemath.js'
import { sampleCiphersuites } from '../helpers/suite-filter.js'
import { testClientConfig } from '../helpers/client-config.js'

// Each case here is a commit every current member would accept but that
// leaves a tree no later joiner can join, or admits a member that cannot
// support the group. Every case asserts the rejection class and then that
// a fresh member can still join from the next honest commit.
const CASES:[string, (t:any, impl:CiphersuiteImpl) => Promise<void>][] = [
    ['two Updates advertising the same HPKE key are rejected',
        updatesShareHpkeKey],
    ['two Updates violating the pairwise credential rule are rejected',
        updatesBreakCredentialRule],
    ['an Update keeping the sender\'s current HPKE key is rejected',
        updateKeepsCurrentKey],
    ['a committer leaf key equal to an UpdatePath key is rejected',
        committerLeafReusesPathKey],
    ['an Add not supporting proposed GroupContextExtensions is rejected',
        addLacksProposedExtension],
    ['joinGroup reports an unsupported GroupContext extension as ' +
        'ValidationError', joinLacksGroupExtension],
]

for (const cs of sampleCiphersuites()) {
    for (const [name, run] of CASES) {
        test(name + ' - ' + cs, async (t) => {
            try {
                const impl = await getCipherSuite(
                    getCiphersuiteFromName(cs as CiphersuiteName))
                await run(t, impl)
            } catch (error:any) {
                if (error?.name === 'NotSupportedError' ||
                    error?.name === 'DependencyError') {
                    t.comment(`Skipping ${cs}: ${skipReason(error)}`)
                    return
                }
                throw error
            }
        })
    }
}

const CUSTOM_EXTENSION = 8545

interface Member {
    publicPackage:KeyPackage
    privatePackage:PrivateKeyPackage
}

function makeMember (
    name:string,
    impl:CiphersuiteImpl,
    capabilities:Capabilities = defaultCapabilities(),
):Promise<Member> {
    const credential:Credential = {
        credentialType: 'basic',
        identity: new TextEncoder().encode(name),
    }

    return generateKeyPackage(
        credential,
        capabilities,
        defaultLifetime(),
        [],
        impl,
    )
}

function addOf (member:Member):ProposalAdd {
    return { proposalType: 'add', add: { keyPackage: member.publicPackage } }
}

async function freshHpkeKey (impl:CiphersuiteImpl):Promise<Uint8Array> {
    return (await makeMember('fresh', impl)).publicPackage.leafNode
        .hpkePublicKey
}

/**
 * Alice creates the group and adds everyone else in one commit; each of
 * them joins from the Welcome. Returns states in the order given.
 */
async function groupOf (
    impl:CiphersuiteImpl,
    members:Member[],
):Promise<ClientState[]> {
    const [alice, ...rest] = members
    const created = await createGroup(
        new TextEncoder().encode('group1'),
        alice!.publicPackage,
        alice!.privatePackage,
        [],
        impl,
        testClientConfig,
    )

    if (rest.length === 0) return [created]

    const commit = await createCommit(
        { state: created, cipherSuite: impl },
        { extraProposals: rest.map(addOf), ratchetTreeExtension: true },
    )

    const joined = await Promise.all(rest.map((m) => joinGroup(
        commit.welcome!,
        m.publicPackage,
        m.privatePackage,
        emptyPskIndex,
        impl,
        undefined,
        undefined,
        testClientConfig,
    )))

    return [commit.newState, ...joined]
}

function ownLeaf (state:ClientState):number {
    return leafToNodeIndex(toLeafIndex(state.privatePath.leafIndex))
}

/**
 * An Update proposal signed by the sender itself, so any rejection is for
 * the field under test and not for a bad leaf signature.
 */
async function signedUpdate (
    state:ClientState,
    impl:CiphersuiteImpl,
    fields:{
        hpkePublicKey:Uint8Array
        credential?:Credential
        capabilities?:Capabilities
    },
):Promise<Proposal> {
    const current = state.ratchetTree[ownLeaf(state)]
    if (current === undefined || current.nodeType !== 'leaf') {
        throw new Error('expected own leaf')
    }

    const tbs = {
        leafNodeSource: 'update' as const,
        hpkePublicKey: fields.hpkePublicKey,
        signaturePublicKey: current.leaf.signaturePublicKey,
        credential: fields.credential ?? current.leaf.credential,
        capabilities: fields.capabilities ?? current.leaf.capabilities,
        extensions: current.leaf.extensions,
        info: {
            leafNodeSource: 'update' as const,
            groupId: state.groupContext.groupId,
            leafIndex: state.privatePath.leafIndex,
        },
    }

    const leafNode:LeafNodeUpdate = {
        ...tbs,
        signature: await signWithLabel(
            state.signaturePrivateKey,
            'LeafNodeTBS',
            encodeLeafNodeTBS(tbs),
            impl.signature,
        ),
    }

    return { proposalType: 'update', update: { leafNode } }
}

/** Sender proposes; receiver stores it. Returns the receiver's new state. */
async function deliverProposal (
    sender:ClientState,
    receiver:ClientState,
    proposal:Proposal,
    impl:CiphersuiteImpl,
):Promise<ClientState> {
    const { message } = await createProposal(sender, false, proposal, impl)
    if (message.wireformat !== 'mls_private_message') {
        throw new Error('expected a private message')
    }

    const result = await processMessage(
        message,
        receiver,
        emptyPskIndex,
        acceptAll,
        impl,
    )
    return result.newState
}

async function rejection (fn:() => Promise<unknown>):Promise<unknown> {
    try {
        await fn()
    } catch (err) {
        return err
    }
    return undefined
}

/** A fresh member can join from the next honest commit's Welcome. */
async function assertJoinable (
    t:any,
    state:ClientState,
    impl:CiphersuiteImpl,
    capabilities?:Capabilities,
):Promise<void> {
    const dave = await makeMember('dave', impl, capabilities)
    const commit = await createCommit(
        { state, cipherSuite: impl },
        { extraProposals: [addOf(dave)], ratchetTreeExtension: true },
    )

    const joined = await rejection(() => joinGroup(
        commit.welcome!,
        dave.publicPackage,
        dave.privatePackage,
        emptyPskIndex,
        impl,
        undefined,
        undefined,
        testClientConfig,
    ))

    t.equal(joined, undefined, 'a fresh member can still join the group')
}

async function updatesShareHpkeKey (t:any, impl:CiphersuiteImpl) {
    const [alice, bob, charlie] = await groupOf(impl, [
        await makeMember('alice', impl),
        await makeMember('bob', impl),
        await makeMember('charlie', impl),
    ])

    const shared = await freshHpkeKey(impl)
    let pending = await deliverProposal(bob!, alice!,
        await signedUpdate(bob!, impl, { hpkePublicKey: shared }), impl)
    pending = await deliverProposal(charlie!, pending,
        await signedUpdate(charlie!, impl, { hpkePublicKey: shared }), impl)

    const err = await rejection(() =>
        createCommit({ state: pending, cipherSuite: impl }))

    t.ok(err instanceof ValidationError,
        'should reject two Updates sharing an encryption key')

    await assertJoinable(t, alice!, impl)
}

async function updatesBreakCredentialRule (t:any, impl:CiphersuiteImpl) {
    const [alice, bob, charlie] = await groupOf(impl, [
        await makeMember('alice', impl),
        await makeMember('bob', impl),
        await makeMember('charlie', impl),
    ])

    // bob moves to x509, which every leaf in the pre-commit tree supports;
    // charlie drops x509, which no leaf in the pre-commit tree uses. Each is
    // fine alone. Together charlie cannot support bob's credential.
    const x509:Credential = {
        credentialType: 'x509',
        certificates: [new Uint8Array([1, 2, 3])],
    }
    const caps = charlie!.ratchetTree[ownLeaf(charlie!)]
    if (caps === undefined || caps.nodeType !== 'leaf') {
        throw new Error('expected own leaf')
    }
    const basicOnly:Capabilities = {
        ...caps.leaf.capabilities,
        credentials: caps.leaf.capabilities.credentials
            .filter((c) => c !== 'x509'),
    }

    let pending = await deliverProposal(bob!, alice!,
        await signedUpdate(bob!, impl, {
            hpkePublicKey: await freshHpkeKey(impl),
            credential: x509,
        }), impl)
    pending = await deliverProposal(charlie!, pending,
        await signedUpdate(charlie!, impl, {
            hpkePublicKey: await freshHpkeKey(impl),
            capabilities: basicOnly,
        }), impl)

    const err = await rejection(() =>
        createCommit({ state: pending, cipherSuite: impl }))

    t.ok(err instanceof ValidationError,
        'should reject Updates that together break the credential rule')

    await assertJoinable(t, alice!, impl)
}

async function updateKeepsCurrentKey (t:any, impl:CiphersuiteImpl) {
    const [alice, bob] = await groupOf(impl, [
        await makeMember('alice', impl),
        await makeMember('bob', impl),
    ])

    const bobLeaf = bob!.ratchetTree[ownLeaf(bob!)]
    if (bobLeaf === undefined || bobLeaf.nodeType !== 'leaf') {
        throw new Error('expected own leaf')
    }

    // createProposal refuses this Update, so bob signs it directly; the
    // receiver rejects it on receipt, before it can be committed
    const { publicMessage } = await protectProposalPublic(
        bob!.signaturePrivateKey,
        bob!.keySchedule.membershipKey,
        bob!.groupContext,
        new Uint8Array(),
        await signedUpdate(bob!, impl, {
            hpkePublicKey: bobLeaf.leaf.hpkePublicKey,
        }),
        bob!.privatePath.leafIndex,
        impl,
    )

    const err = await rejection(() => processPublicMessage(
        alice!, publicMessage, makePskIndex(alice!, {}), impl))

    t.ok(err instanceof ValidationError,
        'should reject an Update that keeps the current encryption key')

    await assertJoinable(t, alice!, impl)
}

async function committerLeafReusesPathKey (t:any, impl:CiphersuiteImpl) {
    const [alice, bob] = await groupOf(impl, [
        await makeMember('alice', impl),
        await makeMember('bob', impl),
    ])

    const commit = await createCommit(
        { state: alice!, cipherSuite: impl },
        { wireAsPublicMessage: true },
    )

    if (commit.commit.wireformat !== 'mls_public_message') {
        throw new Error('expected a public message')
    }
    const pm = commit.commit.publicMessage
    if (pm.content.contentType !== 'commit' ||
        pm.content.commit.path === undefined ||
        pm.auth.contentType !== 'commit') {
        throw new Error('expected a path commit')
    }

    const path = pm.content.commit.path
    const leaf = path.leafNode
    const pathKey = path.nodes[0]!.hpkePublicKey

    // re-signed by the committer, so only the key collision is wrong
    const tbs:LeafNodeTBSCommit = {
        leafNodeSource: 'commit',
        hpkePublicKey: pathKey,
        extensions: leaf.extensions,
        capabilities: leaf.capabilities,
        credential: leaf.credential,
        signaturePublicKey: leaf.signaturePublicKey,
        parentHash: leaf.leafNodeSource === 'commit' ?
            leaf.parentHash :
            new Uint8Array(),
        info: {
            leafNodeSource: 'commit',
            groupId: alice!.groupContext.groupId,
            leafIndex: alice!.privatePath.leafIndex,
        },
    }
    const tamperedLeaf = await signLeafNodeCommit(
        tbs, alice!.signaturePrivateKey, impl.signature)

    const { framedContent, signature } = await createContentCommitSignature(
        alice!.groupContext,
        'mls_public_message',
        {
            proposals: pm.content.commit.proposals,
            path: { ...path, leafNode: tamperedLeaf },
        },
        pm.content.sender,
        pm.content.authenticatedData,
        alice!.signaturePrivateKey,
        impl.signature,
    )

    const tampered = await protectPublicMessage(
        alice!.keySchedule.membershipKey,
        alice!.groupContext,
        {
            wireformat: 'mls_public_message',
            content: framedContent,
            auth: {
                contentType: 'commit',
                signature,
                confirmationTag: pm.auth.confirmationTag,
            },
        },
        impl,
    )

    const err = await rejection(() => processPublicMessage(
        bob!, tampered, makePskIndex(bob!, {}), impl))

    t.ok(err instanceof ValidationError,
        'should reject a committer leaf key equal to an UpdatePath key')

    await assertJoinable(t, alice!, impl)
}

function customExtensionCaps ():Capabilities {
    const caps = defaultCapabilities()
    return { ...caps, extensions: [...caps.extensions, CUSTOM_EXTENSION] }
}

function gceProposal ():Proposal {
    return {
        proposalType: 'group_context_extensions',
        groupContextExtensions: {
            extensions: [{
                extensionType: CUSTOM_EXTENSION,
                extensionData: new Uint8Array(),
            }],
        },
    }
}

async function addLacksProposedExtension (t:any, impl:CiphersuiteImpl) {
    const [alice] = await groupOf(impl, [
        await makeMember('alice', impl, customExtensionCaps()),
        await makeMember('bob', impl, customExtensionCaps()),
    ])

    const george = await makeMember('george', impl)

    const err = await rejection(() => createCommit(
        { state: alice!, cipherSuite: impl },
        { extraProposals: [gceProposal(), addOf(george)] },
    ))

    t.ok(err instanceof ValidationError,
        'should reject an Add that lacks a proposed extension')

    await assertJoinable(t, alice!, impl)
}

async function joinLacksGroupExtension (t:any, impl:CiphersuiteImpl) {
    const [created] = await groupOf(impl, [
        await makeMember('alice', impl, customExtensionCaps()),
    ])

    const gce = await createCommit(
        { state: created!, cipherSuite: impl },
        { extraProposals: [gceProposal()] },
    )
    const alice = gce.newState

    // a committer that skipped the Add check: a Welcome for george into a
    // GroupContext carrying an extension george does not support
    const george = await makeMember('george', impl)
    const groupInfo = await createGroupInfo(
        alice.groupContext,
        alice.confirmationTag,
        alice,
        [],
        impl,
    )
    const joinerSecret = impl.rng.randomBytes(impl.kdf.size)
    const welcomeSecret = await extractWelcomeSecret(
        joinerSecret,
        new Uint8Array(impl.kdf.size),
        impl.kdf,
    )
    const encryptedGroupInfo = await encryptGroupInfo(
        groupInfo, welcomeSecret, impl)
    const egs = await encryptGroupSecrets(
        await impl.hpke.importPublicKey(george.publicPackage.initKey),
        encryptedGroupInfo,
        { joinerSecret, pathSecret: undefined, psks: [] },
        impl.hpke,
    )
    const welcome:Welcome = {
        cipherSuite: alice.groupContext.cipherSuite,
        secrets: [{
            newMember: await makeKeyPackageRef(george.publicPackage, impl.hash),
            encryptedGroupSecrets: { kemOutput: egs.enc, ciphertext: egs.ct },
        }],
        encryptedGroupInfo,
    }

    const err = await rejection(() => joinGroup(
        welcome,
        george.publicPackage,
        george.privatePackage,
        emptyPskIndex,
        impl,
        alice.ratchetTree,
        undefined,
        testClientConfig,
    ))

    t.ok(err instanceof ValidationError,
        'joinGroup should report an unsupported extension as ValidationError')

    await assertJoinable(t, alice, impl, customExtensionCaps())
}
