/**
 * Adds and Removes of every shape a tree can take -- an Add into a blank
 * leaf, an Add that widens the tree, a Remove that leaves its width and
 * a Remove that narrows it -- each followed by a commit of an Update
 * proposal. After every commit, every member holds the same epoch
 * authenticator and reads every other member.
 *
 * Before each commit one receiver is restored from a structured clone,
 * the way the README's Persistence section does it. A restored state
 * computes the next tree's hash from scratch, so it agrees with the
 * committer only if the committer's tree hash is the true one.
 */
import { test } from '@substrate-system/tapzero'
import { skipReason } from '../helpers/skip.js'
import type { ClientState } from '../../src/client-state.js'
import { createGroup, joinGroup } from '../../src/client-state.js'
import { createCommit } from '../../src/create-commit.js'
import { createUpdateProposal } from '../../src/create-message.js'
import { processMessage } from '../../src/process-messages.js'
import { acceptAll } from '../../src/incoming-message-action.js'
import { emptyPskIndex } from '../../src/psk-index.js'
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
import { leafWidth } from '../../src/treemath.js'
import { sampleCiphersuites } from '../helpers/suite-filter.js'
import { testClientConfig } from '../helpers/client-config.js'
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
}

for (const cs of sampleCiphersuites()) {
    test(`Add and Remove of every tree shape keep agreement ${cs}`,
        async (t) => {
            let impl:CiphersuiteImpl
            try {
                impl = await getCipherSuite(
                    getCiphersuiteFromName(cs as CiphersuiteName))
                await newKeyPackage('probe', impl)
            } catch (error:any) {
                if (error?.name === 'NotSupportedError' ||
                    error?.name === 'DependencyError') {
                    t.comment(`Skipping ${cs}: ${skipReason(error)}`)
                    return
                }
                throw error
            }

            const group:Group = {
                t, impl, members: [], nextId: 0, restores: 0,
            }
            await startGroup(group, 5)
            t.equal(width(group), 8, 'five members sit in eight leaves')

            await addMembers(group, 1, 'an Add into a blank leaf')
            t.equal(width(group), 8, 'the Add filled a blank leaf')
            await updateRound(group)

            await addMembers(group, 2, 'Adds that fill the tree')
            await addMembers(group, 1, 'an Add that widens the tree')
            t.equal(width(group), 16, 'the Add widened the tree')
            await updateRound(group)

            await removeLeaves(group, [2], 'a Remove inside the tree')
            t.equal(width(group), 16, 'the Remove left the width alone')
            await updateRound(group)

            await removeLeaves(group, [8], 'a Remove that narrows the tree')
            t.equal(width(group), 8, 'the Remove narrowed the tree')
            await updateRound(group)
        })
}

async function startGroup (group:Group, size:number) {
    const creator = await newMember(group)
    const state = await createGroup(
        new TextEncoder().encode('carry-cache-through-proposals'),
        creator.publicPackage,
        creator.privatePackage,
        [],
        group.impl,
        testClientConfig,
    )
    group.members.push({ name: creator.name, state })
    await addMembers(group, size - 1, 'the founding members')
}

/** The first member commits Adds of `count` new members. */
async function addMembers (group:Group, count:number, label:string) {
    const joiners = await Promise.all(
        Array.from({ length: count }, () => newMember(group)))
    const committer = group.members[0]!
    const proposals:Proposal[] = joiners.map((j) => ({
        proposalType: 'add',
        add: { keyPackage: j.publicPackage },
    }))
    const { newState, commit, welcome } = await createCommit(
        { state: committer.state, cipherSuite: group.impl },
        { extraProposals: proposals },
    )
    committer.state = newState
    await deliver(group, commit, [committer], true)

    // a joiner hashes the tree it is handed from scratch
    for (const joiner of joiners) {
        const state = await joinGroup(
            welcome!,
            joiner.publicPackage,
            joiner.privatePackage,
            emptyPskIndex,
            group.impl,
            newState.ratchetTree,
            undefined,
            testClientConfig,
        )
        group.members.push({ name: joiner.name, state })
    }
    await checkAgreement(group, label)
}

/** The first member commits the removal of the members at `leaves`. */
async function removeLeaves (group:Group, leaves:number[], label:string) {
    const committer = group.members[0]!
    const removed = group.members.filter((m) => {
        return leaves.includes(m.state.privatePath.leafIndex)
    })
    group.t.equal(removed.length, leaves.length,
        `members sit at leaves ${leaves.join(', ')}`)
    const { newState, commit } = await createCommit(
        { state: committer.state, cipherSuite: group.impl },
        {
            extraProposals: leaves.map((removed) => ({
                proposalType: 'remove',
                remove: { removed },
            })),
        },
    )
    committer.state = newState
    group.members = group.members.filter((m) => !removed.includes(m))
    await deliver(group, commit, [committer], true)
    await checkAgreement(group, label)
}

/**
 * The last member proposes an Update and the second commits it, so the
 * commit applies the Update to the tree the Add or Remove left.
 */
async function updateRound (group:Group) {
    const proposer = group.members[group.members.length - 1]!
    const committer = group.members[1]!
    const proposed = await createUpdateProposal(
        proposer.state, false, group.impl)
    proposer.state = proposed.newState
    await deliver(group, proposed.message, [proposer], false)

    const { newState, commit } = await createCommit(
        { state: committer.state, cipherSuite: group.impl })
    committer.state = newState
    await deliver(group, commit, [committer], true)
    await checkAgreement(group, `an Update from ${proposer.name}`)
}

/**
 * Every member but those in `skip` processes `message`. A commit is
 * first given to one receiver restored from a structured clone, with
 * `clientConfig` re-attached.
 */
async function deliver (
    group:Group,
    message:MLSMessage,
    skip:Member[],
    restoreOne:boolean,
) {
    if (message.wireformat !== 'mls_private_message' &&
        message.wireformat !== 'mls_public_message') {
        throw new Error('expected a framed handshake message')
    }
    const receivers = group.members.filter((m) => !skip.includes(m))
    if (restoreOne && receivers.length > 0) {
        const member = receivers[group.restores++ % receivers.length]!
        member.state = restored(member.state)
    }
    for (const member of receivers) {
        const result = await processMessage(
            message, member.state, emptyPskIndex, acceptAll, group.impl)
        if (result.kind !== 'newState' || result.actionTaken !== 'accept') {
            throw new Error('expected an accepted handshake message')
        }
        member.state = result.newState
    }
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

    const { updatedGroups } = await testEveryoneCanMessageEveryone(
        group.members.map((m) => m.state), group.impl, group.t)
    updatedGroups.forEach((state, i) => { group.members[i]!.state = state })
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

function width (group:Group):number {
    return leafWidth(group.members[0]!.state.ratchetTree.length)
}

function bytesEqual (a:Uint8Array, b:Uint8Array):boolean {
    return a.length === b.length && a.every((byte, i) => byte === b[i])
}
