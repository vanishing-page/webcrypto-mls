/**
 * Commits that carry an UpdatePath, sent and received: path commits from
 * one member after another, an external join, and an external resync
 * that replaces the joiner's former leaf. After every commit, every
 * member holds the same epoch authenticator and reads every other
 * member.
 *
 * Before each commit one receiver is restored from a structured clone,
 * the way the README's Persistence section does it, so it hashes the
 * next tree from scratch and agrees with the committer only if the
 * committer's tree hash is the true one. One further clone, taken
 * between two path commits, follows every later commit beside its
 * original.
 */
import { test } from '@substrate-system/tapzero'
import { skipReason } from '../helpers/skip.js'
import type { ClientState } from '../../src/client-state.js'
import { createGroup, joinGroup } from '../../src/client-state.js'
import {
    createCommit,
    createGroupInfoWithExternalPubAndRatchetTree,
    joinGroupExternal,
} from '../../src/create-commit.js'
import { processMessage } from '../../src/process-messages.js'
import { acceptAll } from '../../src/incoming-message-action.js'
import { emptyPskIndex } from '../../src/psk-index.js'
import { ValidationError } from '../../src/mls-error.js'
import type {
    CiphersuiteImpl,
    CiphersuiteName,
} from '../../src/crypto/ciphersuite.js'
import { getCiphersuiteFromName } from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import { generateKeyPackage } from '../../src/key-package.js'
import type { MLSMessage } from '../../src/message.js'
import type { Proposal } from '../../src/proposal.js'
import { defaultLifetime } from '../../src/lifetime.js'
import { defaultCapabilities } from '../../src/default-capabilities.js'
import { leafToNodeIndex, toLeafIndex } from '../../src/treemath.js'
import { sampleCiphersuites } from '../helpers/suite-filter.js'
import { testClientConfig } from '../helpers/client-config.js'
import { sameSignerKeyPackage } from '../helpers/same-signer-key-package.js'
import { testEveryoneCanMessageEveryone } from './common.js'

interface Member {
    name:string
    state:ClientState
}

interface Group {
    t:any
    impl:CiphersuiteImpl
    members:Member[]
    nextId:number
    /** Which receiver the next commit restores before delivery. */
    restores:number
    /** A structured clone that follows every commit its original does. */
    shadow?:{ of:Member, state:ClientState }
}

for (const cs of sampleCiphersuites()) {
    test(`path commits from every member keep agreement ${cs}`,
        async (t) => {
            const impl = await suiteOrSkip(cs, t)
            if (impl === undefined) return
            const group = await startGroup(t, impl, 6)

            await pathRound(group)
            const followed = group.members[3]!
            group.shadow = { of: followed, state: restored(followed.state) }
            await pathRound(group)
            await pathRound(group)
        })

    test(`external join and resync keep agreement ${cs}`, async (t) => {
        const impl = await suiteOrSkip(cs, t)
        if (impl === undefined) return
        const group = await startGroup(t, impl, 5)
        await pathRound(group)

        await externalJoin(group)
        await pathCommit(group, group.members[1]!)

        await resync(group, group.members[2]!)
        await pathCommit(group, group.members[0]!)
    })

    test(`a received UpdatePath with a wrong parent hash is refused ${cs}`,
        async (t) => {
            const impl = await suiteOrSkip(cs, t)
            if (impl === undefined) return
            const group = await startGroup(t, impl, 4)
            // leaf 2's path fills node 5, which sits on leaf 0's copath
            // under the root
            await pathCommit(group, memberAt(group, 2))

            const committer = memberAt(group, 0)
            const tampered = tamperedNode5(committer.state)
            const forged = await createCommit(
                { state: tampered, cipherSuite: impl })
            const receivers = group.members.filter((m) => m !== committer)
            for (const member of receivers) {
                let thrown:unknown
                try {
                    await processMessage(framed(forged.commit),
                        member.state, emptyPskIndex, acceptAll, impl)
                } catch (error) {
                    thrown = error
                }
                t.ok(thrown instanceof ValidationError,
                    `${member.name} refuses a commit whose leaf parent ` +
                    'hash covers a different sibling subtree')
            }

            // the in-suite control: the same commit from the honest tree
            await pathCommit(group, committer)
        })
}

async function suiteOrSkip (
    cs:string,
    t:any,
):Promise<CiphersuiteImpl | undefined> {
    try {
        const impl = await getCipherSuite(
            getCiphersuiteFromName(cs as CiphersuiteName))
        await newKeyPackage('probe', impl)
        return impl
    } catch (error:any) {
        if (error?.name === 'NotSupportedError' ||
            error?.name === 'DependencyError') {
            t.comment(`Skipping ${cs}: ${skipReason(error)}`)
            return undefined
        }
        throw error
    }
}

async function startGroup (
    t:any,
    impl:CiphersuiteImpl,
    size:number,
):Promise<Group> {
    const group:Group = { t, impl, members: [], nextId: 0, restores: 0 }
    const creator = await newMember(group)
    const state = await createGroup(
        new TextEncoder().encode('carry-cache-through-update-paths'),
        creator.publicPackage,
        creator.privatePackage,
        [],
        impl,
        testClientConfig,
    )
    group.members.push({ name: creator.name, state })

    const joiners = await Promise.all(
        Array.from({ length: size - 1 }, () => newMember(group)))
    const proposals:Proposal[] = joiners.map((j) => ({
        proposalType: 'add',
        add: { keyPackage: j.publicPackage },
    }))
    const { newState, welcome } = await createCommit(
        { state, cipherSuite: impl },
        { extraProposals: proposals },
    )
    group.members[0]!.state = newState
    for (const joiner of joiners) {
        const joined = await joinGroup(
            welcome!,
            joiner.publicPackage,
            joiner.privatePackage,
            emptyPskIndex,
            impl,
            newState.ratchetTree,
            undefined,
            testClientConfig,
        )
        group.members.push({ name: joiner.name, state: joined })
    }
    await checkAgreement(group, 'the founding Adds')
    return group
}

/**
 * Every member in turn, but the shadowed one, commits an empty commit,
 * which carries a path. The shadow holds no private key for a path its
 * original sends, so it follows only what its original receives.
 */
async function pathRound (group:Group) {
    for (const committer of group.members.slice()) {
        if (committer === group.shadow?.of) continue
        await pathCommit(group, committer)
    }
}

async function pathCommit (group:Group, committer:Member) {
    const { newState, commit } = await createCommit(
        { state: committer.state, cipherSuite: group.impl })
    committer.state = newState
    await deliver(group, commit, [committer])
    await checkAgreement(group, `a path commit from ${committer.name}`)
}

async function externalJoin (group:Group) {
    const joiner = await newMember(group)
    const groupInfo = await createGroupInfoWithExternalPubAndRatchetTree(
        group.members[0]!.state, [], group.impl)
    const { newState, publicMessage } = await joinGroupExternal(
        groupInfo,
        joiner.publicPackage,
        joiner.privatePackage,
        false,
        group.impl,
        undefined,
        testClientConfig,
    )
    await deliver(group, publicOf(publicMessage), [])
    group.members.push({ name: joiner.name, state: newState })
    await checkAgreement(group, `an external join of ${joiner.name}`)
}

/** `member` rejoins over its own former leaf, with the same signer. */
async function resync (group:Group, member:Member) {
    const leaf = ownLeaf(member.state)
    const keyPackage = await sameSignerKeyPackage(
        leaf.credential,
        leaf.signaturePublicKey,
        member.state.signaturePrivateKey,
        group.impl,
    )
    const source = group.members.find((m) => m !== member)!
    const groupInfo = await createGroupInfoWithExternalPubAndRatchetTree(
        source.state, [], group.impl)
    const { newState, publicMessage } = await joinGroupExternal(
        groupInfo,
        keyPackage.publicPackage,
        keyPackage.privatePackage,
        true,
        group.impl,
        undefined,
        testClientConfig,
    )
    await deliver(group, publicOf(publicMessage), [member])
    member.state = newState
    await checkAgreement(group, `a resync of ${member.name}`)
}

/**
 * Every member but those in `skip` processes `message`, and so does the
 * shadow whenever its original does. One receiver is first restored
 * from a structured clone.
 */
async function deliver (group:Group, message:MLSMessage, skip:Member[]) {
    if (group.shadow !== undefined && skip.includes(group.shadow.of)) {
        throw new Error('the shadowed member may not send')
    }
    const receivers = group.members.filter((m) => !skip.includes(m))
    if (receivers.length > 0) {
        const member = receivers[group.restores++ % receivers.length]!
        member.state = restored(member.state)
    }
    for (const member of receivers) {
        member.state = await accept(group, message, member.state)
        if (group.shadow?.of === member) {
            group.shadow.state = await accept(
                group, message, group.shadow.state)
        }
    }
}

async function accept (
    group:Group,
    message:MLSMessage,
    state:ClientState,
):Promise<ClientState> {
    const result = await processMessage(
        framed(message), state, emptyPskIndex, acceptAll, group.impl)
    if (result.kind !== 'newState' || result.actionTaken !== 'accept') {
        throw new Error('expected an accepted handshake message')
    }
    return result.newState
}

function framed (message:MLSMessage) {
    if (message.wireformat !== 'mls_private_message' &&
        message.wireformat !== 'mls_public_message') {
        throw new Error('expected a framed handshake message')
    }
    return message
}

function restored (state:ClientState):ClientState {
    const { clientConfig, ...persisted } = state
    return { ...structuredClone(persisted), clientConfig }
}

async function checkAgreement (group:Group, label:string) {
    const [first, ...rest] = group.members
    const reference = first!.state.keySchedule.epochAuthenticator
    const epoch = first!.state.groupContext.epoch
    group.t.ok(rest.every((m) => {
        return m.state.groupContext.epoch === epoch &&
            bytesEqual(m.state.keySchedule.epochAuthenticator, reference)
    }), `after ${label}, ${group.members.length} members agree on ` +
        `epoch ${epoch}`)

    const shadow = group.shadow
    if (shadow !== undefined) {
        group.t.ok(shadow.state.groupContext.epoch === epoch &&
            bytesEqual(shadow.state.keySchedule.epochAuthenticator,
                reference),
        `after ${label}, the clone of ${shadow.of.name} agrees`)
    }

    const { updatedGroups } = await testEveryoneCanMessageEveryone(
        group.members.map((m) => m.state), group.impl, group.t)
    updatedGroups.forEach((state, i) => { group.members[i]!.state = state })
}

/**
 * `state` with node 5's parent hash overwritten, in a fresh array. Node
 * 5 is not on leaf 0's direct path, so the commit leaf 0 builds from it
 * is self-consistent, but its parent hashes cover a sibling subtree no
 * other member holds.
 */
function tamperedNode5 (state:ClientState):ClientState {
    const tree = state.ratchetTree.slice()
    const node = tree[5]
    if (node === undefined || node.nodeType !== 'parent') {
        throw new Error('expected node 5 to be a non-blank parent')
    }
    tree[5] = {
        nodeType: 'parent',
        parent: {
            ...node.parent,
            parentHash: new Uint8Array(node.parent.parentHash.length)
                .fill(7),
        },
    }
    return { ...state, ratchetTree: tree }
}

function memberAt (group:Group, leafIndex:number):Member {
    const member = group.members.find((m) => {
        return m.state.privatePath.leafIndex === leafIndex
    })
    if (member === undefined) throw new Error(`no member at ${leafIndex}`)
    return member
}

function ownLeaf (state:ClientState) {
    const node = state.ratchetTree[
        leafToNodeIndex(toLeafIndex(state.privatePath.leafIndex))]
    if (node === undefined || node.nodeType !== 'leaf') {
        throw new Error('expected own leaf')
    }
    return node.leaf
}

function publicOf (
    publicMessage:Awaited<ReturnType<typeof joinGroupExternal>>[
        'publicMessage'],
):MLSMessage {
    return {
        wireformat: 'mls_public_message',
        version: 'mls10',
        publicMessage,
    }
}

async function newMember (group:Group) {
    const name = `member-${group.nextId++}`
    return { name, ...await newKeyPackage(name, group.impl) }
}

function newKeyPackage (name:string, impl:CiphersuiteImpl) {
    return generateKeyPackage(
        {
            credentialType: 'basic',
            identity: new TextEncoder().encode(name),
        },
        defaultCapabilities(),
        defaultLifetime(),
        [],
        impl,
    )
}

function bytesEqual (a:Uint8Array, b:Uint8Array):boolean {
    return a.length === b.length && a.every((byte, i) => byte === b[i])
}
