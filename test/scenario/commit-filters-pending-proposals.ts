import { test } from '@substrate-system/tapzero'
import { skipReason } from '../helpers/skip.js'
import type { ClientState } from '../../src/client-state.js'
import { createGroup, joinGroup } from '../../src/client-state.js'
import { createCommit } from '../../src/create-commit.js'
import {
    createApplicationMessage,
    createProposal
} from '../../src/create-message.js'
import { processMessage } from '../../src/process-messages.js'
import { acceptAll } from '../../src/incoming-message-action.js'
import { emptyPskIndex } from '../../src/psk-index.js'
import type {
    CiphersuiteImpl,
    CiphersuiteName
} from '../../src/crypto/ciphersuite.js'
import { getCiphersuiteFromName } from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import { signWithLabel } from '../../src/crypto/signature.js'
import { generateKeyPackage } from '../../src/key-package.js'
import type { LeafNodeUpdate } from '../../src/leaf-node.js'
import { encodeLeafNodeTBS } from '../../src/leaf-node.js'
import type { MLSMessage } from '../../src/message.js'
import type { Proposal } from '../../src/proposal.js'
import { defaultLifetime } from '../../src/lifetime.js'
import { defaultCapabilities } from '../../src/default-capabilities.js'
import { ValidationError } from '../../src/mls-error.js'
import { leafToNodeIndex, toLeafIndex } from '../../src/treemath.js'
import { sampleCiphersuites } from '../helpers/suite-filter.js'
import { testClientConfig } from '../helpers/client-config.js'

// RFC 9420 section 12.2: a committer bundles only the pending proposals
// that survive filtering, so ordinary concurrency between honest members
// cannot make the next commit throw and wedge the group.
const CASES:[string, (t:any, impl:CiphersuiteImpl) => Promise<void>][] = [
    ['two Removes of one member collapse to one', concurrentRemoves],
    ['an Update from a removed leaf is left out', updateOfRemovedLeaf],
    ['the committer\'s own Update is left out', committerOwnUpdate],
    ['identical pending proposals collapse to one', identicalAdds],
    ['an invalid by-value proposal still rejects', invalidByValue],
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

async function makeMember (name:string, impl:CiphersuiteImpl) {
    return generateKeyPackage(
        {
            credentialType: 'basic',
            identity: new TextEncoder().encode(name)
        },
        defaultCapabilities(),
        defaultLifetime(),
        [],
        impl,
    )
}

/** alice, bob, charlie and dave, at leaves 0 to 3. */
async function fourMembers (impl:CiphersuiteImpl):Promise<ClientState[]> {
    const alice = await makeMember('alice', impl)
    const others = await Promise.all(
        ['bob', 'charlie', 'dave'].map((n) => makeMember(n, impl)))

    const aliceGroup = await createGroup(
        new TextEncoder().encode('filter-group'),
        alice.publicPackage,
        alice.privatePackage,
        [],
        impl,
        testClientConfig,
    )

    const { newState, welcome } = await createCommit(
        { state: aliceGroup, cipherSuite: impl },
        {
            ratchetTreeExtension: true,
            extraProposals: others.map((m):Proposal => ({
                proposalType: 'add',
                add: { keyPackage: m.publicPackage },
            })),
        },
    )

    const joined = await Promise.all(others.map((m) => joinGroup(
        welcome!,
        m.publicPackage,
        m.privatePackage,
        emptyPskIndex,
        impl,
        undefined,
        undefined,
        testClientConfig,
    )))

    return [newState, ...joined]
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
    const result = await processMessage(
        message,
        receiver,
        emptyPskIndex,
        acceptAll,
        impl,
    )
    if (result.kind !== 'newState') throw new Error('expected a new state')
    return result.newState
}

/**
 * `members[from]` proposes, and every other member stores the proposal.
 * Returns the whole group's states afterwards.
 */
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
 * `members[from]` commits its pending proposals, and every other member
 * still in the group processes the commit.
 */
async function commitAndDeliver (
    t:any,
    members:ClientState[],
    from:number,
    impl:CiphersuiteImpl,
):Promise<ClientState[]> {
    const { newState, commit } = await createCommit(
        { state: members[from]!, cipherSuite: impl })

    t.deepEqual(
        Object.keys(newState.unappliedProposals),
        [],
        'the committer has no pending proposals left',
    )
    const sent = await rejection(() =>
        createApplicationMessage(newState, new Uint8Array([1]), impl))
    t.equal(sent, undefined, 'the committer can send application data')

    const after = await Promise.all(members.map((m, i) => i === from ?
        newState :
        receive(commit, m, impl)))

    t.ok(
        after.every((s) =>
            s.groupContext.epoch === newState.groupContext.epoch),
        'every member processes the commit',
    )
    return after
}

function removeOf (leafIndex:number):Proposal {
    return { proposalType: 'remove', remove: { removed: leafIndex } }
}

function leafCount (state:ClientState):number {
    return state.ratchetTree.filter((n) => n?.nodeType === 'leaf').length
}

function isBlankLeaf (state:ClientState, leafIndex:number):boolean {
    return state.ratchetTree[leafToNodeIndex(toLeafIndex(leafIndex))] ===
        undefined
}

async function freshUpdate (
    state:ClientState,
    impl:CiphersuiteImpl,
):Promise<Proposal> {
    const node = state.ratchetTree[
        leafToNodeIndex(toLeafIndex(state.privatePath.leafIndex))]
    if (node === undefined || node.nodeType !== 'leaf') {
        throw new Error('expected own leaf')
    }
    const { publicKey } = await impl.hpke.generateKeyPair()

    const tbs = {
        leafNodeSource: 'update' as const,
        hpkePublicKey: await impl.hpke.exportPublicKey(publicKey),
        signaturePublicKey: node.leaf.signaturePublicKey,
        credential: node.leaf.credential,
        capabilities: node.leaf.capabilities,
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
    return { proposalType: 'update', update: { leafNode } }
}

async function rejection (fn:() => Promise<unknown>):Promise<unknown> {
    try {
        await fn()
    } catch (err) {
        return err
    }
    return undefined
}

async function concurrentRemoves (t:any, impl:CiphersuiteImpl) {
    let group = await fourMembers(impl)
    group = await broadcastProposal(group, 0, removeOf(2), impl)
    group = await broadcastProposal(group, 1, removeOf(2), impl)

    const remaining = [group[0]!, group[1]!, group[3]!]
    const after = await commitAndDeliver(t, remaining, 2, impl)

    t.ok(isBlankLeaf(after[0]!, 2), 'charlie is removed')
    t.equal(leafCount(after[0]!), 3, 'only charlie is removed')
}

async function updateOfRemovedLeaf (t:any, impl:CiphersuiteImpl) {
    let group = await fourMembers(impl)
    group = await broadcastProposal(
        group, 1, await freshUpdate(group[1]!, impl), impl)
    group = await broadcastProposal(group, 0, removeOf(1), impl)

    const remaining = [group[0]!, group[2]!, group[3]!]
    const after = await commitAndDeliver(t, remaining, 2, impl)

    t.ok(isBlankLeaf(after[0]!, 1), 'bob is removed')
}

async function committerOwnUpdate (t:any, impl:CiphersuiteImpl) {
    let group = await fourMembers(impl)
    group = await broadcastProposal(
        group, 3, await freshUpdate(group[3]!, impl), impl)

    const after = await commitAndDeliver(t, group, 3, impl)
    t.equal(leafCount(after[0]!), 4, 'the membership is unchanged')
}

async function identicalAdds (t:any, impl:CiphersuiteImpl) {
    const eve = await makeMember('eve', impl)
    const add:Proposal = {
        proposalType: 'add',
        add: { keyPackage: eve.publicPackage },
    }

    let group = await fourMembers(impl)
    group = await broadcastProposal(group, 0, add, impl)
    group = await broadcastProposal(group, 1, add, impl)

    const after = await commitAndDeliver(t, group, 3, impl)
    t.equal(leafCount(after[0]!), 5, 'eve is added once')
}

async function invalidByValue (t:any, impl:CiphersuiteImpl) {
    let group = await fourMembers(impl)
    group = await broadcastProposal(group, 0, removeOf(2), impl)
    const { newState } = await createCommit(
        { state: group[0]!, cipherSuite: impl })

    const err = await rejection(() => createCommit(
        { state: newState, cipherSuite: impl },
        { extraProposals: [removeOf(2)] },
    ))
    t.ok(err instanceof ValidationError,
        'a by-value Remove of a blank leaf is a ValidationError')
}
