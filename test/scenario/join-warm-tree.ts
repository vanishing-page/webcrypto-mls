import { test } from '@substrate-system/tapzero'
import { skipReason } from '../helpers/skip.js'
import {
    type ClientState,
    type KeyPackage,
    type PrivateKeyPackage,
    type Proposal,
    type RatchetTree,
    type Welcome,
    acceptAll,
    createApplicationMessage,
    createCommit,
    createGroup,
    createGroupInfoWithExternalPub,
    CryptoVerificationError,
    defaultCapabilities,
    defaultLifetime,
    emptyPskIndex,
    generateKeyPackage,
    getCipherSuite,
    getCiphersuiteFromName,
    joinGroup,
    joinGroupExternal,
    processMessage,
} from '../../src/index.js'
import type {
    CiphersuiteImpl,
    CiphersuiteName,
} from '../../src/crypto/ciphersuite.js'
import type { MLSMessage } from '../../src/message.js'
import { sampleCiphersuites } from '../helpers/suite-filter.js'
import { testClientConfig } from '../helpers/client-config.js'

// A joiner validates the ratchet tree it is handed by hashing all of
// it, and the state it joins into goes on to use that same tree. These
// cases hold a join into a large group to the group's agreement, and
// hold a refused join to leaving nothing behind that the next attempt
// could trip over: not a hash of a tree the joiner was handed before,
// even when the application hands over the same array, changed.
const SIZE = 64

type Keys = { publicPackage:KeyPackage, privatePackage:PrivateKeyPackage }

type Fixture = {
    impl:CiphersuiteImpl
    // alice, after her commit adding the joiner
    alice:ClientState
    // bob, after processing that commit
    bob:ClientState
    joiner:Keys
    // the Add commit's Welcome, carrying the ratchet tree
    withTree:Welcome
    // a second commit of the same Add, from the same state, whose
    // Welcome has no ratchet_tree extension, so the joiner has to be
    // passed the tree; it starts a fork of its own, so alice's state
    // after it is kept beside the first
    withoutTree:Welcome
    aliceWithoutTree:ClientState
}

for (const cs of sampleCiphersuites()) {
    test('a member joins a large group through a Welcome carrying the ' +
        'ratchet tree and follows its next commit - ' + cs, async (t) => {
        const fx = await fixtureOrSkip(t, cs)
        if (fx === undefined) return

        const joined = await join(fx, fx.withTree)
        await followNextCommit(t, fx, joined, fx.bob, [fx.alice])
    })

    test('a joiner refused for a tampered tree joins on its next ' +
        'attempt with an honest Welcome - ' + cs, async (t) => {
        const fx = await fixtureOrSkip(t, cs)
        if (fx === undefined) return

        await refused(t, () => join(fx, fx.withoutTree,
            tampered(fx.aliceWithoutTree.ratchetTree)), 'a tampered tree')

        const joined = await join(fx, fx.withTree)
        await followNextCommit(t, fx, joined, fx.bob, [fx.alice])
    })

    test('a tree argument changed by the caller after a refused join is ' +
        'judged on its new contents - ' + cs, async (t) => {
        const fx = await fixtureOrSkip(t, cs)
        if (fx === undefined) return

        const tree = fx.aliceWithoutTree.ratchetTree.slice()
        const [index, honest] = tamperInPlace(tree)

        await refused(t, () => join(fx, fx.withoutTree, tree),
            'the tampered tree argument')

        // the application repairs its own array and tries again
        tree[index] = honest
        const joined = await join(fx, fx.withoutTree, tree)
        await followNextCommit(t, fx, joined, fx.aliceWithoutTree, [])

        // and breaks it again: the join is refused, though the array
        // is one an accepted join has already read
        tamperInPlace(tree)
        await refused(t, () => join(fx, fx.withoutTree, tree),
            'the same array, tampered again')
    })

    test('a tree argument to an external join, changed by the caller ' +
        'after a refused attempt, is judged on its new contents - ' + cs,
    async (t) => {
        const fx = await fixtureOrSkip(t, cs)
        if (fx === undefined) return

        // a GroupInfo with no ratchet_tree extension, so the joiner has
        // to be passed the tree
        const groupInfo = await createGroupInfoWithExternalPub(
            fx.alice, [], fx.impl)
        const outsider = await member('outsider', fx.impl)
        const joinExternal = (tree:RatchetTree) => joinGroupExternal(
            groupInfo,
            outsider.publicPackage,
            outsider.privatePackage,
            false,
            fx.impl,
            tree,
            testClientConfig,
        )

        const tree = fx.alice.ratchetTree.slice()
        const [index, honest] = tamperInPlace(tree)
        await refused(t, () => joinExternal(tree),
            'the tampered tree argument')

        tree[index] = honest
        const joined = await joinExternal(tree)
        const alice = await processed(
            {
                version: 'mls10',
                wireformat: 'mls_public_message',
                publicMessage: joined.publicMessage,
            },
            fx.alice,
            fx.impl,
        )
        t.ok(bytesEqual(joined.newState.keySchedule.epochAuthenticator,
            alice.keySchedule.epochAuthenticator),
        'the external joiner agrees with the group')
    })
}

async function fixtureOrSkip (
    t:any,
    cs:CiphersuiteName,
):Promise<Fixture | undefined> {
    try {
        return await fixture(cs)
    } catch (error:any) {
        if (error?.name === 'NotSupportedError' ||
            error?.name === 'DependencyError') {
            t.comment(`Skipping ${cs}: ${skipReason(error)}`)
            return undefined
        }
        throw error
    }
}

async function fixture (cs:CiphersuiteName):Promise<Fixture> {
    const impl = await getCipherSuite(getCiphersuiteFromName(cs))
    const aliceKeys = await member('alice', impl)
    const created = await createGroup(
        new TextEncoder().encode('join-warm-tree'),
        aliceKeys.publicPackage,
        aliceKeys.privatePackage,
        [],
        impl,
        testClientConfig,
    )

    const others = await Promise.all(
        Array.from({ length: SIZE - 2 }, (_, i) => member(`m-${i}`, impl))
    )
    const added = await createCommit(
        { state: created, cipherSuite: impl },
        { extraProposals: others.map(addOf), ratchetTreeExtension: true },
    )
    if (added.welcome === undefined) throw new Error('expected a Welcome')
    let bob = await join({ impl, joiner: others[0]! }, added.welcome)

    // a path commit, so the tree holds parent nodes and parent hashes
    // for the joiner to verify
    const pathCommit = await createCommit(
        { state: added.newState, cipherSuite: impl },
    )
    bob = await processed(pathCommit.commit, bob, impl)

    const joiner = await member('joiner', impl)
    const context = { state: pathCommit.newState, cipherSuite: impl }
    const withTree = await createCommit(context,
        { extraProposals: [addOf(joiner)], ratchetTreeExtension: true })
    const withoutTree = await createCommit(context,
        { extraProposals: [addOf(joiner)] })
    if (withTree.welcome === undefined ||
        withoutTree.welcome === undefined) {
        throw new Error('expected a Welcome')
    }
    bob = await processed(withTree.commit, bob, impl)

    return {
        impl,
        alice: withTree.newState,
        bob,
        joiner,
        withTree: withTree.welcome,
        withoutTree: withoutTree.welcome,
        aliceWithoutTree: withoutTree.newState,
    }
}

/**
 * `committer` commits; the joiner and every observer follow, all of them
 * agree on the epoch authenticator, and the joiner's message reaches
 * the committer.
 */
async function followNextCommit (
    t:any,
    fx:Fixture,
    joined:ClientState,
    committer:ClientState,
    observers:ClientState[],
) {
    t.ok(bytesEqual(joined.keySchedule.epochAuthenticator,
        committer.keySchedule.epochAuthenticator),
    'the joiner agrees with the group on joining')

    const next = await createCommit({ state: committer, cipherSuite: fx.impl })
    const joiner = await processed(next.commit, joined, fx.impl)
    const followers = [joiner]
    for (const observer of observers) {
        followers.push(await processed(next.commit, observer, fx.impl))
    }
    const expected = next.newState.keySchedule.epochAuthenticator

    t.ok(followers.every(state =>
        bytesEqual(state.keySchedule.epochAuthenticator, expected)),
    'the joiner agrees with the group after the next commit')

    const sent = await createApplicationMessage(joiner,
        new TextEncoder().encode('from the joiner'), fx.impl)
    const received = await processMessage(
        {
            wireformat: 'mls_private_message',
            privateMessage: sent.privateMessage,
        },
        next.newState,
        emptyPskIndex,
        acceptAll,
        fx.impl,
    )
    t.ok(received.kind === 'applicationMessage' &&
        new TextDecoder().decode(received.message) === 'from the joiner',
    'a member reads the joiner\'s message')
}

/**
 * Bob's leaf with one signature bit flipped. Alice's path commit covers
 * it with her leaf's parent hash, so the tree no longer verifies.
 */
function tampered (tree:RatchetTree):RatchetTree {
    const copy = tree.slice()
    tamperInPlace(copy)
    return copy
}

function tamperInPlace (
    tree:RatchetTree,
):[number, RatchetTree[number]] {
    const index = 2
    const honest = tree[index]
    if (honest?.nodeType !== 'leaf') throw new Error('no leaf at node 2')
    const signature = honest.leaf.signature.slice()
    signature[0]! ^= 0x01
    tree[index] = { nodeType: 'leaf', leaf: { ...honest.leaf, signature } }
    return [index, honest]
}

async function refused (
    t:any,
    fn:() => Promise<unknown>,
    what:string,
) {
    try {
        await fn()
        t.fail(`${what} should be refused`)
    } catch (error) {
        t.ok(error instanceof CryptoVerificationError,
            `${what} is refused as a CryptoVerificationError`)
    }
}

function join (
    fx:{ impl:CiphersuiteImpl, joiner:Keys },
    welcome:Welcome,
    tree?:RatchetTree,
):Promise<ClientState> {
    // joinGroup zeroizes the init key, and these cases join more than
    // once with the same KeyPackage
    const privatePackage = {
        ...fx.joiner.privatePackage,
        initPrivateKey: fx.joiner.privatePackage.initPrivateKey.slice(),
    }
    return joinGroup(
        welcome,
        fx.joiner.publicPackage,
        privatePackage,
        emptyPskIndex,
        fx.impl,
        tree,
        undefined,
        testClientConfig,
    )
}

async function processed (
    message:MLSMessage,
    state:ClientState,
    impl:CiphersuiteImpl,
):Promise<ClientState> {
    if (message.wireformat !== 'mls_private_message' &&
        message.wireformat !== 'mls_public_message') {
        throw new Error('expected a framed commit')
    }
    const result = await processMessage(
        message, state, emptyPskIndex, acceptAll, impl)
    if (result.kind !== 'newState') throw new Error('expected a new state')
    return result.newState
}

function member (name:string, impl:CiphersuiteImpl):Promise<Keys> {
    return generateKeyPackage(
        { credentialType: 'basic', identity: new TextEncoder().encode(name) },
        defaultCapabilities(),
        defaultLifetime(),
        [],
        impl,
    )
}

function addOf (keys:Keys):Proposal {
    return { proposalType: 'add', add: { keyPackage: keys.publicPackage } }
}

function bytesEqual (a:Uint8Array, b:Uint8Array):boolean {
    return a.length === b.length && a.every((byte, i) => byte === b[i])
}
