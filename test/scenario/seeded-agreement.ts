import { test } from '@substrate-system/tapzero'
import { skipReason } from '../helpers/skip.js'
import type { ClientState } from '../../src/client-state.js'
import { createGroup, joinGroup } from '../../src/client-state.js'
import {
    createCommit,
    createGroupInfoWithExternalPubAndRatchetTree,
    joinGroupExternal,
} from '../../src/create-commit.js'
import {
    createApplicationMessage,
    createProposal,
} from '../../src/create-message.js'
import { processMessage } from '../../src/process-messages.js'
import { acceptAll } from '../../src/incoming-message-action.js'
import { emptyPskIndex } from '../../src/psk-index.js'
import type {
    CiphersuiteImpl,
    CiphersuiteName,
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
import {
    leafToNodeIndex,
    leafWidth,
    toLeafIndex,
} from '../../src/treemath.js'
import { sampleCiphersuites } from '../helpers/suite-filter.js'
import { testClientConfig } from '../helpers/client-config.js'
import { sameSignerKeyPackage } from '../helpers/same-signer-key-package.js'

/**
 * A seeded random sequence of Adds, Removes, Update proposals, path
 * commits and external joins over a group of a few dozen members. After
 * every epoch, every member has to hold the same epoch authenticator and
 * read an application message from every other member.
 *
 * Two steps are steered rather than drawn: an Add that overflows the
 * tree and so widens it, and a Remove of the whole right half, which
 * narrows it again. After those, one member is persisted the way the
 * README's Persistence section does it, and the restored copy follows
 * every later commit beside the original.
 *
 * The seed fixes the sequence of operations, not the key material. Set
 * `MLS_AGREEMENT_SEED` to replay a sequence locally; every failed check
 * prints the seed that produced it.
 */
const DEFAULT_SEED = 0x2610

const INITIAL_MEMBERS = 20
const MIN_MEMBERS = 14
const MAX_MEMBERS = 34

type Op = 'add'|'remove'|'mixed'|'empty'|'update'|'external'
const OPS:Op[] = ['add', 'remove', 'mixed', 'empty', 'update', 'external']

/** How many times the drawn part of the sequence visits each `Op`. */
const ROUNDS = 2

// Printed progress keeps the browser run from reading a long step as a
// stalled one, which it would after three silent seconds.
const PROGRESS_MS = 1000

for (const cs of sampleCiphersuites()) {
    test(`seeded agreement across epochs ${cs}`, async (t) => {
        const seed = readSeed()
        let impl:CiphersuiteImpl
        try {
            impl = await getCipherSuite(
                getCiphersuiteFromName(cs as CiphersuiteName))
            await generateKeyPackage(credentialFor('probe'),
                defaultCapabilities(), defaultLifetime(), [], impl)
        } catch (error:any) {
            if (error?.name === 'NotSupportedError' ||
                error?.name === 'DependencyError') {
                t.comment(`Skipping ${cs}: ${skipReason(error)}`)
                return
            }
            throw error
        }

        t.comment(`seed ${seed}`)
        const run = newRun(t, impl, seed)
        try {
            await agreementSequence(run)
        } catch (error) {
            t.comment(reproduce(run))
            throw error
        }
    })
}

interface Member {
    name:string
    state:ClientState
}

interface Restored {
    /** The member the copy was taken from. */
    of:Member
    state:ClientState
}

interface Run {
    t:any
    impl:CiphersuiteImpl
    seed:number
    random:() => number
    members:Member[]
    restored:Restored|undefined
    nextId:number
    epochs:number
    lastOutput:number
}

function newRun (t:any, impl:CiphersuiteImpl, seed:number):Run {
    return {
        t,
        impl,
        seed,
        random: mulberry32(seed),
        members: [],
        restored: undefined,
        nextId: 0,
        epochs: 0,
        lastOutput: Date.now(),
    }
}

async function agreementSequence (run:Run) {
    await startGroup(run)
    await checkEpoch(run, 'initial group')

    // the steered width changes, each followed by an ordinary commit
    await extendTree(run)
    await runOp(run, drawOp(run))
    await truncateTree(run)
    await runOp(run, drawOp(run))

    restoreOneMember(run)

    const sequence = shuffle(run, OPS.flatMap((op) => {
        return Array.from({ length: ROUNDS }, () => op)
    }))
    for (const op of sequence) {
        await runOp(run, constrain(run, op))
    }

    expect(run, run.restored !== undefined,
        'the restored member was still in the group at the end')
}

async function startGroup (run:Run) {
    const creator = await newMember(run)
    const state = await createGroup(
        new TextEncoder().encode('seeded-agreement'),
        creator.publicPackage,
        creator.privatePackage,
        [],
        run.impl,
        testClientConfig,
    )
    run.members.push({ name: creator.name, state })
    await addMembers(run, run.members[0]!, INITIAL_MEMBERS - 1)
}

function drawOp (run:Run):Op {
    return constrain(run, OPS[Math.floor(run.random() * OPS.length)]!)
}

/** Keep the group between its size bounds. */
function constrain (run:Run, op:Op):Op {
    const size = run.members.length
    const grows = op === 'add' || op === 'external'
    if (grows && size >= MAX_MEMBERS) return 'remove'
    if (op === 'remove' && size <= MIN_MEMBERS) return 'add'
    return op
}

async function runOp (run:Run, op:Op) {
    switch (op) {
        case 'add': {
            const count = 1 + Math.floor(run.random() * 3)
            await addMembers(run, pickActive(run, []), count)
            return
        }
        case 'remove': {
            const count = 1 + Math.floor(run.random() * 2)
            const targets:Member[] = []
            for (let i = 0; i < count; i++) {
                targets.push(pickActive(run, targets))
            }
            await removeMembers(run, pickActive(run, targets), targets)
            return
        }
        case 'mixed': {
            const target = pickActive(run, [])
            const committer = pickActive(run, [target])
            const joiner = await newMember(run)
            await commitAndDeliver(run, committer, `mixed by ${committer.name}`,
                [removeOf(target), addOf(joiner.publicPackage)],
                [target], [joiner])
            return
        }
        case 'empty': {
            const committer = pickActive(run, [])
            await commitAndDeliver(run, committer,
                `empty path commit by ${committer.name}`, [], [], [])
            return
        }
        case 'update':
            await updateThenResync(run)
            return
        case 'external':
            await externalJoin(run)
    }
}

/**
 * Add one more member than the tree has blank leaves, so the commit has
 * to widen it.
 */
async function extendTree (run:Run) {
    const before = width(run)
    const blanks = before - run.members.length
    await addMembers(run, pickActive(run, []), blanks + 1)
    expect(run, width(run) > before,
        `the overflowing Add widened the tree from ${before} leaves`)
}

/** Remove every member in the right half, so the tree narrows. */
async function truncateTree (run:Run) {
    const before = width(run)
    const half = before / 2
    const targets = run.members.filter((m) => {
        return m.state.privatePath.leafIndex >= half
    })
    const keep = run.members.filter((m) => !targets.includes(m))
    expect(run, targets.length > 0 && keep.length > 0,
        'both halves of the tree hold members before truncating')
    const committer = keep[Math.floor(run.random() * keep.length)]!
    await removeMembers(run, committer, targets)
    expect(run, width(run) < before,
        `removing the right half narrowed the tree from ${before} leaves`)
}

/**
 * Persist one member the way the README's Persistence section does --
 * structured clone with `clientConfig` left out, then re-attached -- and
 * keep the restored copy beside the original from here on.
 */
function restoreOneMember (run:Run) {
    const of = pickActive(run, [run.members[0]!])
    const { clientConfig, ...persisted } = of.state
    const state:ClientState = {
        ...structuredClone(persisted),
        clientConfig,
    }
    run.restored = { of, state }
    run.t.comment(`restored a copy of ${of.name} at epoch ${epochOf(of)}`)
}

async function addMembers (run:Run, committer:Member, count:number) {
    const joiners = await Promise.all(
        Array.from({ length: count }, () => newMember(run)))
    await commitAndDeliver(run, committer,
        `${count} Add(s) by ${committer.name}`,
        joiners.map((j) => addOf(j.publicPackage)),
        [], joiners)
}

async function removeMembers (
    run:Run,
    committer:Member,
    targets:Member[],
) {
    await commitAndDeliver(run, committer,
        `${targets.length} Remove(s) by ${committer.name}`,
        targets.map(removeOf), targets, [])
}

type NewMember = Awaited<ReturnType<typeof newMember>>

/**
 * `committer` commits `proposals` (plus whatever is pending), every
 * other remaining member processes it, the `joiners` join from its
 * Welcome, and the new epoch is checked.
 */
async function commitAndDeliver (
    run:Run,
    committer:Member,
    label:string,
    proposals:Proposal[],
    removed:Member[],
    joiners:NewMember[],
) {
    const withTree = run.random() < 0.5
    const { newState, commit, welcome } = await createCommit(
        { state: committer.state, cipherSuite: run.impl },
        { extraProposals: proposals, ratchetTreeExtension: withTree },
    )
    committer.state = newState
    run.members = run.members.filter((m) => !removed.includes(m))
    await deliver(run, commit, [committer])

    for (const joiner of joiners) {
        const state = await joinGroup(
            welcome!,
            joiner.publicPackage,
            joiner.privatePackage,
            emptyPskIndex,
            run.impl,
            withTree ? undefined : newState.ratchetTree,
            undefined,
            testClientConfig,
        )
        run.members.push({ name: joiner.name, state })
        progress(run, label)
    }
    await checkEpoch(run, label)
}

/**
 * One member proposes an Update and another commits it. The library
 * keeps no private key for a proposed leaf, so the proposer cannot
 * follow that commit; it rejoins by a resync external commit, which is
 * the recovery an application has for a member that has fallen out of
 * step. That is two epochs.
 */
async function updateThenResync (run:Run) {
    const proposer = pickActive(run, [])
    const committer = pickActive(run, [proposer])

    const { message } = await createProposal(
        proposer.state, false, await freshUpdate(proposer.state, run.impl),
        run.impl)
    run.members = run.members.filter((m) => m !== proposer)
    await deliver(run, message, [])
    await commitAndDeliver(run, committer,
        `Update from ${proposer.name} committed by ${committer.name}`,
        [], [], [])

    const leaf = ownLeaf(proposer.state)
    const keyPackage = await sameSignerKeyPackage(
        leaf.credential,
        leaf.signaturePublicKey,
        proposer.state.signaturePrivateKey,
        run.impl,
    )
    const source = pickActive(run, [])
    const groupInfo = await createGroupInfoWithExternalPubAndRatchetTree(
        source.state, [], run.impl)
    const { newState, publicMessage } = await joinGroupExternal(
        groupInfo,
        keyPackage.publicPackage,
        keyPackage.privatePackage,
        true,
        run.impl,
        undefined,
        testClientConfig,
    )
    await deliver(run, publicOf(publicMessage), [])
    proposer.state = newState
    run.members.push(proposer)
    await checkEpoch(run, `resync of ${proposer.name}`)
}

async function externalJoin (run:Run) {
    const joiner = await newMember(run)
    const source = pickActive(run, [])
    const groupInfo = await createGroupInfoWithExternalPubAndRatchetTree(
        source.state, [], run.impl)
    const { newState, publicMessage } = await joinGroupExternal(
        groupInfo,
        joiner.publicPackage,
        joiner.privatePackage,
        false,
        run.impl,
        undefined,
        testClientConfig,
    )
    await deliver(run, publicOf(publicMessage), [])
    run.members.push({ name: joiner.name, state: newState })
    await checkEpoch(run, `external join of ${joiner.name}`)
}

/**
 * Every member except `skip` processes `message`, and so does the
 * restored copy whenever its original does.
 */
async function deliver (run:Run, message:MLSMessage, skip:Member[]) {
    if (message.wireformat !== 'mls_private_message' &&
        message.wireformat !== 'mls_public_message') {
        throw new Error('expected a framed handshake message')
    }
    for (const member of run.members) {
        if (skip.includes(member)) continue
        member.state = await receiveHandshake(run, message, member.state)
        if (run.restored?.of === member) {
            run.restored.state = await receiveHandshake(
                run, message, run.restored.state)
        }
        progress(run, 'delivering a handshake message')
    }
}

async function receiveHandshake (
    run:Run,
    message:MLSMessage & {
        wireformat:'mls_private_message'|'mls_public_message'
    },
    state:ClientState,
):Promise<ClientState> {
    const result = await processMessage(
        message, state, emptyPskIndex, acceptAll, run.impl)
    if (result.kind !== 'newState' || result.actionTaken !== 'accept') {
        throw new Error('expected an accepted handshake message')
    }
    return result.newState
}

/**
 * The epoch's two observable agreements: one epoch authenticator across
 * the whole group (and the restored copy), and every member reading an
 * application message from every other.
 */
async function checkEpoch (run:Run, label:string) {
    run.epochs++
    const [first, ...rest] = run.members
    const epoch = epochOf(first!)
    const reference = first!.state.keySchedule.epochAuthenticator
    const disagreeing = rest.filter((m) => {
        return epochOf(m) !== epoch ||
            !bytesEqual(m.state.keySchedule.epochAuthenticator, reference)
    })
    expect(run, disagreeing.length === 0,
        `epoch ${epoch} (${label}): ${run.members.length} members agree ` +
        'on the epoch authenticator',
        disagreeing.map((m) => m.name))

    if (run.restored !== undefined) {
        const { of, state } = run.restored
        expect(run,
            state.groupContext.epoch === of.state.groupContext.epoch &&
            bytesEqual(state.keySchedule.epochAuthenticator,
                of.state.keySchedule.epochAuthenticator),
            `epoch ${epoch}: the restored copy of ${of.name} agrees ` +
            'with the original')
    }

    const unread = await everyoneMessagesEveryone(run)
    expect(run, unread.length === 0,
        `epoch ${epoch}: every member reads every other member`,
        unread)
}

/** Returns a description of each pair that did not get through. */
async function everyoneMessagesEveryone (run:Run):Promise<string[]> {
    const unread:string[] = []
    for (const sender of run.members) {
        const text = new TextEncoder().encode(
            `${sender.name} at ${run.epochs}`)
        const { newState, privateMessage } = await createApplicationMessage(
            sender.state, text, run.impl)
        sender.state = newState
        const message:MLSMessage = {
            wireformat: 'mls_private_message',
            version: 'mls10',
            privateMessage,
        }

        const receivers:{ name:string; get:() => ClientState;
            set:(s:ClientState) => void }[] = run.members
            .filter((m) => m !== sender)
            .map((m) => ({
                name: m.name,
                get: () => m.state,
                set: (s) => { m.state = s },
            }))
        const restored = run.restored
        if (restored !== undefined && restored.of !== sender) {
            receivers.push({
                name: `restored ${restored.of.name}`,
                get: () => restored.state,
                set: (s) => { restored.state = s },
            })
        }

        for (const receiver of receivers) {
            const result = await processMessage(
                message, receiver.get(), emptyPskIndex, acceptAll, run.impl)
            if (result.kind !== 'applicationMessage' ||
                !bytesEqual(result.message, text)) {
                unread.push(`${receiver.name} from ${sender.name}`)
                continue
            }
            receiver.set(result.newState)
        }
        progress(run, 'exchanging application messages')
    }
    return unread
}

/**
 * Record a check; a failed one also prints the seed that reproduces it
 * and up to five of the members or pairs it concerns.
 */
function expect (
    run:Run,
    ok:boolean,
    message:string,
    details:string[] = [],
) {
    run.t.ok(ok, message)
    run.lastOutput = Date.now()
    if (ok) return
    if (details.length > 0) {
        run.t.comment(`concerns ${details.slice(0, 5).join(', ')}` +
            (details.length > 5 ? ` and ${details.length - 5} more` : ''))
    }
    run.t.comment(reproduce(run))
}

function reproduce (run:Run):string {
    return `reproduce with MLS_AGREEMENT_SEED=${run.seed}`
}

function progress (run:Run, what:string) {
    const now = Date.now()
    if (now - run.lastOutput < PROGRESS_MS) return
    run.lastOutput = now
    run.t.comment(`still ${what}, ${run.members.length} members`)
}

/**
 * A member other than those in `exclude`. The restored member's
 * original is never picked: it only receives, so that it and the copy
 * see the same messages.
 */
function pickActive (run:Run, exclude:Member[]):Member {
    const pool = run.members.filter((m) => {
        return !exclude.includes(m) && m !== run.restored?.of
    })
    if (pool.length === 0) throw new Error('no member left to pick')
    return pool[Math.floor(run.random() * pool.length)]!
}

async function newMember (run:Run) {
    const name = `member-${run.nextId++}`
    const kp = await generateKeyPackage(
        credentialFor(name),
        defaultCapabilities(),
        defaultLifetime(),
        [],
        run.impl,
    )
    return { name, ...kp }
}

function credentialFor (name:string) {
    return {
        credentialType: 'basic' as const,
        identity: new TextEncoder().encode(name),
    }
}

function addOf (keyPackage:NewMember['publicPackage']):Proposal {
    return { proposalType: 'add', add: { keyPackage } }
}

function removeOf (member:Member):Proposal {
    return {
        proposalType: 'remove',
        remove: { removed: member.state.privatePath.leafIndex },
    }
}

function publicOf (
    publicMessage:Awaited<ReturnType<typeof joinGroupExternal>>[
        'publicMessage'],
):MLSMessage {
    return { wireformat: 'mls_public_message', version: 'mls10', publicMessage }
}

function ownLeaf (state:ClientState) {
    const node = state.ratchetTree[
        leafToNodeIndex(toLeafIndex(state.privatePath.leafIndex))]
    if (node === undefined || node.nodeType !== 'leaf') {
        throw new Error('expected own leaf')
    }
    return node.leaf
}

/** An Update proposal for `state`'s own leaf, with a fresh HPKE key. */
async function freshUpdate (
    state:ClientState,
    impl:CiphersuiteImpl,
):Promise<Proposal> {
    const leaf = ownLeaf(state)
    const { publicKey } = await impl.hpke.generateKeyPair()
    const tbs = {
        leafNodeSource: 'update' as const,
        hpkePublicKey: await impl.hpke.exportPublicKey(publicKey),
        signaturePublicKey: leaf.signaturePublicKey,
        credential: leaf.credential,
        capabilities: leaf.capabilities,
        extensions: leaf.extensions,
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

function width (run:Run):number {
    return leafWidth(run.members[0]!.state.ratchetTree.length)
}

function epochOf (member:Member):bigint {
    return member.state.groupContext.epoch
}

function bytesEqual (a:Uint8Array, b:Uint8Array):boolean {
    return a.length === b.length && a.every((byte, i) => byte === b[i])
}

function shuffle<T> (run:Run, items:T[]):T[] {
    const out = [...items]
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(run.random() * (i + 1))
        ;[out[i], out[j]] = [out[j]!, out[i]!]
    }
    return out
}

/** A small, well-mixed 32-bit PRNG; the sequence is fixed by `seed`. */
function mulberry32 (seed:number):() => number {
    let a = seed >>> 0
    return () => {
        a = (a + 0x6d2b79f5) >>> 0
        let x = a
        x = Math.imul(x ^ (x >>> 15), x | 1)
        x ^= x + Math.imul(x ^ (x >>> 7), x | 61)
        return ((x ^ (x >>> 14)) >>> 0) / 4294967296
    }
}

// The node run has a real `process` and the browser bundle polyfills
// one without an environment, as in test/helpers/suite-filter.ts.
declare const process:{
    env?:Record<string, string|undefined>
}|undefined

function readSeed ():number {
    const raw = typeof process === 'undefined' ?
        undefined :
        process.env?.MLS_AGREEMENT_SEED
    if (raw === undefined || raw.trim() === '') return DEFAULT_SEED
    const seed = Number(raw)
    if (!Number.isInteger(seed)) {
        throw new Error(`MLS_AGREEMENT_SEED is not an integer: ${raw}`)
    }
    return seed
}
