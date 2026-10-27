/**
 * A member rotates its own leaf with `createUpdateProposal`, another
 * member commits the Update, and the proposer follows that commit: the
 * commit's path secret for the proposer is encrypted to the new leaf
 * key, so only a proposer that kept the new private key can process it.
 */
import { test } from '@substrate-system/tapzero'
import { skipReason } from '../helpers/skip.js'
import type { ClientState } from '../../src/client-state.js'
import {
    createGroup,
    joinGroup,
    makePskIndex,
} from '../../src/client-state.js'
import { createCommit } from '../../src/create-commit.js'
// imported from the package root, as an application does
import { createUpdateProposal } from '../../src/index.js'
import { processMessage } from '../../src/process-messages.js'
import type { ProcessMessageResult } from '../../src/process-messages.js'
import type {
    IncomingMessageCallback,
} from '../../src/incoming-message-action.js'
import { emptyPskIndex } from '../../src/psk-index.js'
import type {
    AuthenticationService,
} from '../../src/authentication-service.js'
import { ValidationError } from '../../src/mls-error.js'
import {
    discardPendingProposal,
    listPendingProposals,
} from '../../src/unapplied-proposals.js'
import type {
    CiphersuiteImpl,
    CiphersuiteName,
} from '../../src/crypto/ciphersuite.js'
import { getCiphersuiteFromName } from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import { generateKeyPackage } from '../../src/key-package.js'
import type { MLSMessage } from '../../src/message.js'
import { defaultLifetime } from '../../src/lifetime.js'
import { defaultCapabilities } from '../../src/default-capabilities.js'
import { leafToNodeIndex, toLeafIndex } from '../../src/treemath.js'
import { testCiphersuites } from '../helpers/suite-filter.js'
import { testClientConfig } from '../helpers/client-config.js'
import { testEveryoneCanMessageEveryone } from './common.js'

async function member (name:string, cs:CiphersuiteImpl) {
    return generateKeyPackage(
        {
            credentialType: 'basic',
            identity: new TextEncoder().encode(name),
        },
        defaultCapabilities(),
        defaultLifetime(),
        [],
        cs,
    )
}

async function receive (
    state:ClientState,
    message:MLSMessage,
    cs:CiphersuiteImpl,
    onMessage?:IncomingMessageCallback,
):Promise<ProcessMessageResult> {
    if (
        message.wireformat !== 'mls_private_message' &&
        message.wireformat !== 'mls_public_message'
    ) throw new Error('Expected a framed message')
    return processMessage(
        message, state, makePskIndex(state, {}), onMessage, cs)
}

/**
 * A two-member group. `bobFirst` makes bob the creator, so he sits at
 * leaf index 0 and alice at 1; otherwise alice creates it.
 */
async function twoMembers (cs:CiphersuiteImpl, bobFirst:boolean) {
    const alice = await member('alice', cs)
    const bob = await member('bob', cs)
    const [creator, joiner] = bobFirst ? [bob, alice] : [alice, bob]

    const created = await createGroup(
        new TextEncoder().encode('group'),
        creator.publicPackage,
        creator.privatePackage,
        [],
        cs,
        testClientConfig,
    )
    const added = await createCommit(
        { state: created, cipherSuite: cs },
        {
            extraProposals: [{
                proposalType: 'add',
                add: { keyPackage: joiner.publicPackage },
            }],
        },
    )
    const joined = await joinGroup(
        added.welcome!,
        joiner.publicPackage,
        joiner.privatePackage,
        emptyPskIndex,
        cs,
        added.newState.ratchetTree,
        undefined,
        testClientConfig,
    )

    return bobFirst ?
        { bobGroup: added.newState, aliceGroup: joined } :
        { aliceGroup: added.newState, bobGroup: joined }
}

function ownLeafKey (state:ClientState):Uint8Array {
    const node = state.ratchetTree[
        leafToNodeIndex(toLeafIndex(state.privatePath.leafIndex))]
    if (node?.nodeType !== 'leaf') throw new Error('expected own leaf')
    return node.leaf.hpkePublicKey
}

async function aliceCommitsBobsUpdate (
    t:any,
    cipherSuite:CiphersuiteName,
    bobFirst:boolean,
) {
    const cs = await getCipherSuite(getCiphersuiteFromName(cipherSuite))
    let { aliceGroup, bobGroup } = await twoMembers(cs, bobFirst)
    t.equal(bobGroup.privatePath.leafIndex, bobFirst ? 0 : 1,
        'bob is at the expected leaf index')
    const keyBefore = ownLeafKey(bobGroup)

    const proposed = await createUpdateProposal(bobGroup, false, cs)
    bobGroup = proposed.newState
    aliceGroup = (await receive(aliceGroup, proposed.message, cs)).newState

    const commit = await createCommit({ state: aliceGroup, cipherSuite: cs })
    aliceGroup = commit.newState
    const processed = await receive(bobGroup, commit.commit, cs)
    bobGroup = processed.newState

    t.equal(bobGroup.groupContext.epoch, aliceGroup.groupContext.epoch,
        'bob follows the commit of his Update')
    t.ok(!equalBytes(ownLeafKey(bobGroup), keyBefore),
        'bob\'s leaf carries the key from his Update')
    await testEveryoneCanMessageEveryone([aliceGroup, bobGroup], cs, t)
}

/**
 * Collects every buffer reachable from a value, so a test can ask
 * whether a dropped key is still held by a state.
 */
function reachableBuffers (
    value:unknown,
    out = new Set<Uint8Array>(),
    seen = new Set<unknown>(),
):Set<Uint8Array> {
    if (value === null || typeof value !== 'object') return out
    if (seen.has(value)) return out
    seen.add(value)
    if (value instanceof Uint8Array) {
        out.add(value)
        return out
    }
    const children = value instanceof Map ?
        [...value.keys(), ...value.values()] :
        Object.values(value)
    for (const child of children) reachableBuffers(child, out, seen)
    return out
}

/**
 * The secret buffers a proposal step added to the state: the new
 * state's buffers that the state before it did not hold, less the
 * public proposal it stored. The pending HPKE key is among them.
 */
function addedSecrets (before:ClientState, after:ClientState):Uint8Array[] {
    const old = reachableBuffers(before)
    const proposal = reachableBuffers(after.unappliedProposals)
    return [...reachableBuffers(after)].filter((b) =>
        !old.has(b) && !proposal.has(b))
}

async function aliceCommitsWithoutBobsUpdate (
    t:any,
    cipherSuite:CiphersuiteName,
) {
    const cs = await getCipherSuite(getCiphersuiteFromName(cipherSuite))
    let { aliceGroup, bobGroup } = await twoMembers(cs, false)

    const proposed = await createUpdateProposal(bobGroup, false, cs)
    const added = addedSecrets(bobGroup, proposed.newState)
    bobGroup = proposed.newState
    aliceGroup = (await receive(aliceGroup, proposed.message, cs)).newState

    // alice drops bob's Update and commits without it
    const [pending] = listPendingProposals(aliceGroup)
    aliceGroup = discardPendingProposal(aliceGroup, pending!.ref)
    const commit = await createCommit({ state: aliceGroup, cipherSuite: cs })
    aliceGroup = commit.newState

    const processed = await receive(bobGroup, commit.commit, cs)
    const reachable = reachableBuffers(processed.newState)
    const listed = new Set(processed.consumed)
    t.ok(added.length > 0, 'the proposal added secrets to bob\'s state')
    t.ok(added.every((b) => !reachable.has(b)),
        'bob\'s new state holds nothing his proposal added')
    t.ok(added.every((b) => listed.has(b)),
        'everything the proposal added, the pending key among it, is consumed')
    t.ok(processed.consumed.every((b) => !reachable.has(b)),
        'nothing consumed is reachable from bob\'s new state')
    for (const b of processed.consumed) b.fill(0)
    bobGroup = processed.newState

    t.equal(bobGroup.groupContext.epoch, aliceGroup.groupContext.epoch,
        'bob follows a commit that leaves out his Update')
    await testEveryoneCanMessageEveryone([aliceGroup, bobGroup], cs, t)
}

async function bobCommitsWithHisUpdatePending (
    t:any,
    cipherSuite:CiphersuiteName,
) {
    const cs = await getCipherSuite(getCiphersuiteFromName(cipherSuite))
    let { aliceGroup, bobGroup } = await twoMembers(cs, false)

    // charlie joins, so the commit has a member besides its author
    const charlie = await member('charlie', cs)
    const addCharlie = await createCommit(
        { state: aliceGroup, cipherSuite: cs },
        {
            extraProposals: [{
                proposalType: 'add',
                add: { keyPackage: charlie.publicPackage },
            }],
        },
    )
    aliceGroup = addCharlie.newState
    bobGroup = (await receive(bobGroup, addCharlie.commit, cs)).newState
    let charlieGroup = await joinGroup(
        addCharlie.welcome!,
        charlie.publicPackage,
        charlie.privatePackage,
        emptyPskIndex,
        cs,
        aliceGroup.ratchetTree,
        undefined,
        testClientConfig,
    )

    const proposed = await createUpdateProposal(bobGroup, false, cs)
    const added = addedSecrets(bobGroup, proposed.newState)
    bobGroup = proposed.newState
    aliceGroup = (await receive(aliceGroup, proposed.message, cs)).newState
    charlieGroup = (await receive(charlieGroup, proposed.message, cs))
        .newState

    const commit = await createCommit({ state: bobGroup, cipherSuite: cs })
    const reachable = reachableBuffers(commit.newState)
    const listed = new Set(commit.consumed)
    t.ok(added.every((b) => !reachable.has(b)),
        'bob\'s committed state holds nothing his proposal added')
    t.ok(added.every((b) => listed.has(b)),
        'the pending key is in the commit\'s consumed list')
    for (const b of commit.consumed) b.fill(0)
    bobGroup = commit.newState

    let committedUpdates = -1
    aliceGroup = (await receive(aliceGroup, commit.commit, cs, (incoming) => {
        if (incoming.kind === 'commit') {
            committedUpdates = incoming.proposals.filter((p) =>
                p.proposal.proposalType === 'update').length
        }
        return 'accept'
    })).newState
    t.equal(committedUpdates, 0,
        'the commit does not include bob\'s own Update')
    charlieGroup = (await receive(charlieGroup, commit.commit, cs)).newState

    t.equal(aliceGroup.groupContext.epoch, bobGroup.groupContext.epoch,
        'alice follows bob\'s commit')
    t.equal(charlieGroup.groupContext.epoch, bobGroup.groupContext.epoch,
        'charlie follows bob\'s commit')
    await testEveryoneCanMessageEveryone(
        [aliceGroup, bobGroup, charlieGroup], cs, t)
}

async function refusedUpdateLeavesStateUnchanged (
    t:any,
    cipherSuite:CiphersuiteName,
) {
    const cs = await getCipherSuite(getCiphersuiteFromName(cipherSuite))
    let { aliceGroup, bobGroup } = await twoMembers(cs, false)

    // bob's own AuthenticationService, switched to refusing after he has
    // joined, so it refuses the leaf of his Update as a peer's would
    const policy = { refuse: false }
    const authService:AuthenticationService = {
        async validateCredential () { return !policy.refuse },
    }
    bobGroup = {
        ...bobGroup,
        clientConfig: { ...bobGroup.clientConfig, authService },
    }

    policy.refuse = true
    let refusal:unknown
    try {
        await createUpdateProposal(bobGroup, false, cs)
    } catch (error) {
        refusal = error
    }
    t.ok(refusal instanceof ValidationError,
        'an Update the receipt check refuses is refused when proposed')
    policy.refuse = false

    t.equal(listPendingProposals(bobGroup).length, 0,
        'the state passed in holds no pending proposal')
    const commit = await createCommit({ state: bobGroup, cipherSuite: cs })
    aliceGroup = (await receive(aliceGroup, commit.commit, cs)).newState
    bobGroup = commit.newState
    t.equal(aliceGroup.groupContext.epoch, bobGroup.groupContext.epoch,
        'the state passed in still commits')
    await testEveryoneCanMessageEveryone([aliceGroup, bobGroup], cs, t)
}

function equalBytes (a:Uint8Array, b:Uint8Array):boolean {
    return a.length === b.length && a.every((x, i) => x === b[i])
}

function run (
    name:string,
    cs:string,
    body:(t:any, cs:CiphersuiteName) => Promise<void>,
) {
    test(name + ' ' + cs, async (t) => {
        try {
            await body(t, cs as CiphersuiteName)
        } catch (error:any) {
            if (
                error?.name === 'NotSupportedError' ||
                error?.name === 'DependencyError'
            ) {
                t.comment(`Skipping ${cs}: ${skipReason(error)}`)
                return
            }
            throw error
        }
    })
}

for (const cs of testCiphersuites()) {
    run('a committed Update proposal keeps the proposer in the group', cs,
        (t, suite) => aliceCommitsBobsUpdate(t, suite, false))
    run('an Update proposal from leaf index 0', cs,
        (t, suite) => aliceCommitsBobsUpdate(t, suite, true))
    run('a commit without the Update drops the pending key', cs,
        aliceCommitsWithoutBobsUpdate)
    run('the proposer\'s own commit leaves its Update out', cs,
        bobCommitsWithHisUpdatePending)
    run('a refused Update leaves the state unchanged', cs,
        refusedUpdateLeavesStateUnchanged)
}
