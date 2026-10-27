import { test } from '@substrate-system/tapzero'
import { skipReason } from '../helpers/skip.js'
import type { ClientState } from '../../src/client-state.js'
import { createGroup, joinGroup } from '../../src/client-state.js'
import { createCommit } from '../../src/create-commit.js'
import { createProposal } from '../../src/create-message.js'
import { processMessage } from '../../src/process-messages.js'
import { acceptAll } from '../../src/incoming-message-action.js'
import { emptyPskIndex } from '../../src/psk-index.js'
import type { Credential } from '../../src/credential.js'
import type {
    CiphersuiteImpl,
    CiphersuiteName,
} from '../../src/crypto/ciphersuite.js'
import { getCiphersuiteFromName } from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import { signWithLabel } from '../../src/crypto/signature.js'
import { generateKeyPackage } from '../../src/key-package.js'
import type { KeyPackage } from '../../src/key-package.js'
import type { LeafNodeUpdate } from '../../src/leaf-node.js'
import { encodeLeafNodeTBS } from '../../src/leaf-node.js'
import { defaultLifetime } from '../../src/lifetime.js'
import type { Capabilities } from '../../src/capabilities.js'
import type { Extension } from '../../src/extension.js'
import type { MLSMessage } from '../../src/message.js'
import type { Proposal } from '../../src/proposal.js'
import {
    encodeRequiredCapabilities,
} from '../../src/required-capabilities.js'
import { ValidationError } from '../../src/mls-error.js'
import { leafToNodeIndex, toLeafIndex } from '../../src/treemath.js'
import { forgeAddCommit } from '../helpers/forge-commit.js'
import { sampleCiphersuites } from '../helpers/suite-filter.js'
import { testClientConfig } from '../helpers/client-config.js'
import { testEveryoneCanMessageEveryone } from './common.js'

// A receipt check may only refuse what no commit in this epoch could make
// valid. A GroupContextExtensions proposal can change the required
// capabilities, so an Add or Update is not refused on arrival for failing
// the current requirement; the committer drops one that fails the
// requirement its own commit sets (RFC 9420 12.2).

const EXT_A = 8
const EXT_B = 9

const CASES:[string, (t:any, impl:CiphersuiteImpl,
    cs:CiphersuiteName) => Promise<void>][] = [
    ['an Add by reference failing the current requirement is accepted ' +
        'on receipt and committed with a GCE that admits it', addByRef],
    ['an Update by reference dropping the current requirement is ' +
        'accepted on receipt and committed with a GCE that admits it',
    updateByRef],
    ['a pending Add failing the requirement the commit sets is left out',
        pendingAddDropped],
    ['the same Add by value is refused', addByValueRefused],
    ['a forged commit applying a capability-failing Add is refused',
        forgedAddRefused],
]

for (const cs of sampleCiphersuites()) {
    for (const [name, run] of CASES) {
        test(name + ' - ' + cs, async (t) => {
            try {
                const impl = await getCipherSuite(getCiphersuiteFromName(cs))
                await run(t, impl, cs)
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

async function addByRef (t:any, impl:CiphersuiteImpl, cs:CiphersuiteName) {
    let group = await twoMemberGroup(impl, cs)
    const charlie = await keyPackage('charlie', [EXT_B], impl, cs)

    group = await broadcastProposal(group, 1, add(charlie.publicPackage),
        impl)
    t.equal(Object.keys(group[0]!.unappliedProposals).length, 1,
        'alice holds the Add')

    const result = await createCommit(
        { state: group[0]!, cipherSuite: impl },
        { extraProposals: [gce([requiredCapabilities([EXT_B])])] },
    )
    const bob = await receive(result.commit, group[1]!, impl)
    const charlieGroup = await joinGroup(
        result.welcome!,
        charlie.publicPackage,
        charlie.privatePackage,
        emptyPskIndex,
        impl,
        result.newState.ratchetTree,
        undefined,
        testClientConfig,
    )

    await everyoneAdvanced(t, group[0]!, [result.newState, bob, charlieGroup],
        impl)
}

async function updateByRef (
    t:any,
    impl:CiphersuiteImpl,
    cs:CiphersuiteName,
) {
    let group = await twoMemberGroup(impl, cs)

    const { proposal, privateKey } = await updateWithCapabilities(
        group[1]!, capabilities([EXT_B], cs), impl)
    group = await broadcastProposal(group, 1, proposal, impl)
    t.equal(Object.keys(group[0]!.unappliedProposals).length, 1,
        'alice holds the Update')

    group = await broadcastProposal(group, 0,
        gce([requiredCapabilities([EXT_B])]), impl)

    const result = await createCommit({ state: group[0]!, cipherSuite: impl })

    // Ticket 08's createUpdateProposal keeps the proposer's new private
    // key; until then bob is given the key his Update carries here, the
    // way that API will hold it, so he can decrypt the commit's path.
    const bobLeaf = leafToNodeIndex(
        toLeafIndex(group[1]!.privatePath.leafIndex))
    const bobWithKey:ClientState = {
        ...group[1]!,
        privatePath: {
            ...group[1]!.privatePath,
            privateKeys: {
                ...group[1]!.privatePath.privateKeys,
                [bobLeaf]: privateKey,
            },
        },
    }
    const bob = await receive(result.commit, bobWithKey, impl)

    const node = bob.ratchetTree[bobLeaf]
    t.ok(node?.nodeType === 'leaf' &&
        !node.leaf.capabilities.extensions.includes(EXT_A),
    'bob\'s leaf no longer lists A')
    await everyoneAdvanced(t, group[0]!, [result.newState, bob], impl)
}

async function pendingAddDropped (
    t:any,
    impl:CiphersuiteImpl,
    cs:CiphersuiteName,
) {
    let group = await twoMemberGroup(impl, cs)
    const charlie = await keyPackage('charlie', [EXT_A], impl, cs)

    group = await broadcastProposal(group, 1, add(charlie.publicPackage),
        impl)

    const result = await createCommit(
        { state: group[0]!, cipherSuite: impl },
        { extraProposals: [gce([requiredCapabilities([EXT_B])])] },
    )
    t.equal(result.welcome, undefined, 'the commit welcomes no one')

    const bob = await receive(result.commit, group[1]!, impl)
    t.equal(leafCount(result.newState), 2, 'charlie is not added')
    t.equal(leafCount(bob), 2, 'bob does not add charlie')
    await everyoneAdvanced(t, group[0]!, [result.newState, bob], impl)
}

async function addByValueRefused (
    t:any,
    impl:CiphersuiteImpl,
    cs:CiphersuiteName,
) {
    const [alice] = await twoMemberGroup(impl, cs)
    const charlie = await keyPackage('charlie', [EXT_A], impl, cs)

    const err = await rejection(() => createCommit(
        { state: alice!, cipherSuite: impl },
        {
            extraProposals: [
                gce([requiredCapabilities([EXT_B])]),
                add(charlie.publicPackage),
            ],
        },
    ))
    t.ok(err instanceof ValidationError,
        'a by-value Add failing the new requirement is a ValidationError')
}

async function forgedAddRefused (
    t:any,
    impl:CiphersuiteImpl,
    cs:CiphersuiteName,
) {
    const [alice, bob] = await twoMemberGroup(impl, cs)

    // honest control: the same forgery of a KeyPackage that meets the
    // requirement is accepted, so a refusal below is the capability's
    const supporting = await keyPackage('carol', [EXT_A], impl, cs)
    const honest = await forgeAddCommit(alice!, [supporting.publicPackage],
        impl)
    const accepted = await receive(honest.commit, bob!, impl)
    t.equal(accepted.groupContext.epoch, alice!.groupContext.epoch + 1n,
        'a forged Add of a supporting KeyPackage is accepted')

    const charlie = await keyPackage('charlie', [EXT_B], impl, cs)
    const { commit } = await forgeAddCommit(alice!, [charlie.publicPackage],
        impl)
    const err = await rejection(() => receive(commit, bob!, impl))
    t.ok(err instanceof ValidationError,
        'a forged Add failing the requirement, with no GCE, is a ' +
        'ValidationError')
}

/** alice at leaf 0 and bob at leaf 1, both supporting A and B. */
async function twoMemberGroup (
    impl:CiphersuiteImpl,
    cs:CiphersuiteName,
):Promise<ClientState[]> {
    const alice = await keyPackage('alice', [EXT_A, EXT_B], impl, cs)
    const bob = await keyPackage('bob', [EXT_A, EXT_B], impl, cs)

    const created = await createGroup(
        new TextEncoder().encode('receipt-follows-requirement'),
        alice.publicPackage,
        alice.privatePackage,
        [requiredCapabilities([EXT_A])],
        impl,
        testClientConfig,
    )

    const added = await createCommit({ state: created, cipherSuite: impl }, {
        extraProposals: [add(bob.publicPackage)],
    })

    const bobGroup = await joinGroup(
        added.welcome!,
        bob.publicPackage,
        bob.privatePackage,
        emptyPskIndex,
        impl,
        added.newState.ratchetTree,
        undefined,
        testClientConfig,
    )

    return [added.newState, bobGroup]
}

async function everyoneAdvanced (
    t:any,
    before:ClientState,
    states:ClientState[],
    impl:CiphersuiteImpl,
):Promise<void> {
    const epoch = before.groupContext.epoch + 1n
    t.ok(states.every((s) => s.groupContext.epoch === epoch),
        'every member reaches the next epoch')
    t.ok(states.every((s) => equalBytes(
        s.keySchedule.epochAuthenticator,
        states[0]!.keySchedule.epochAuthenticator,
    )), 'every member agrees on the epoch')
    await testEveryoneCanMessageEveryone(states, impl, t)
}

async function receive (
    message:MLSMessage,
    receiver:ClientState,
    impl:CiphersuiteImpl,
):Promise<ClientState> {
    if (message.wireformat !== 'mls_private_message' &&
        message.wireformat !== 'mls_public_message') {
        throw new Error('expected a framed message')
    }
    const result = await processMessage(message, receiver, emptyPskIndex,
        acceptAll, impl)
    if (result.kind !== 'newState') throw new Error('expected a new state')
    return result.newState
}

/** `members[from]` proposes, and every other member stores it. */
async function broadcastProposal (
    members:ClientState[],
    from:number,
    proposal:Proposal,
    impl:CiphersuiteImpl,
):Promise<ClientState[]> {
    const { newState, message } = await createProposal(
        members[from]!, false, proposal, impl)
    return Promise.all(members.map((m, i) => i === from ?
        newState :
        receive(message, m, impl)))
}

/**
 * An Update of the member's own leaf with new capabilities and a fresh
 * HPKE key, signed with its current signature key, and the exported
 * private key for that HPKE key.
 */
async function updateWithCapabilities (
    state:ClientState,
    caps:Capabilities,
    impl:CiphersuiteImpl,
):Promise<{ proposal:Proposal; privateKey:Uint8Array }> {
    const node = state.ratchetTree[
        leafToNodeIndex(toLeafIndex(state.privatePath.leafIndex))]
    if (node === undefined || node.nodeType !== 'leaf') {
        throw new Error('expected own leaf')
    }
    const { publicKey, privateKey } = await impl.hpke.generateKeyPair()

    const tbs = {
        leafNodeSource: 'update' as const,
        hpkePublicKey: await impl.hpke.exportPublicKey(publicKey),
        signaturePublicKey: node.leaf.signaturePublicKey,
        credential: node.leaf.credential,
        capabilities: caps,
        extensions: node.leaf.extensions,
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
    return {
        proposal: { proposalType: 'update', update: { leafNode } },
        privateKey: await impl.hpke.exportPrivateKey(privateKey),
    }
}

function capabilities (
    extensions:number[],
    cs:CiphersuiteName,
):Capabilities {
    return {
        extensions,
        credentials: ['basic'],
        proposals: [],
        versions: ['mls10'],
        ciphersuites: [cs],
    }
}

function keyPackage (
    name:string,
    extensions:number[],
    impl:CiphersuiteImpl,
    cs:CiphersuiteName,
) {
    const credential:Credential = {
        credentialType: 'basic',
        identity: new TextEncoder().encode(name),
    }
    return generateKeyPackage(
        credential,
        capabilities(extensions, cs),
        defaultLifetime(),
        [],
        impl,
    )
}

function requiredCapabilities (extensionTypes:number[]):Extension {
    return {
        extensionType: 'required_capabilities',
        extensionData: encodeRequiredCapabilities({
            extensionTypes,
            credentialTypes: ['basic'],
            proposalTypes: [],
        }),
    }
}

function gce (extensions:Extension[]):Proposal {
    return {
        proposalType: 'group_context_extensions',
        groupContextExtensions: { extensions },
    }
}

function add (keyPackage:KeyPackage):Proposal {
    return { proposalType: 'add', add: { keyPackage } }
}

function leafCount (state:ClientState):number {
    return state.ratchetTree.filter((n) => n?.nodeType === 'leaf').length
}

function equalBytes (a:Uint8Array, b:Uint8Array):boolean {
    return a.length === b.length && a.every((x, i) => x === b[i])
}

async function rejection (fn:() => Promise<unknown>):Promise<unknown> {
    try {
        await fn()
    } catch (err) {
        return err
    }
    return undefined
}
