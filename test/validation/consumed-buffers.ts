/**
 * Every operation that returns a new state also returns `consumed`: the
 * secret buffers the input state references and the new state does not.
 * An application wipes them once the new state is persisted.
 *
 * This walks a whole group lifecycle, and after each operation checks
 * the rule in both directions -- nothing listed is reachable from the
 * new state, nothing listed is foreign to the input state, and nothing
 * secret the new state dropped is missing from the list -- then wipes
 * every listed buffer and carries on with the new state. The members
 * still sending, receiving and committing to the end is the proof that
 * wiping is safe.
 *
 * "Secret" is defined here by exclusion, independently of the library:
 * a buffer in the state that is not part of its public record (the
 * ratchet tree, the group context, the confirmation tag, the pending
 * proposals and the config, and the same for each retained epoch).
 * A new secret field in `ClientState` is therefore covered without
 * touching this test.
 */
import { test } from '@substrate-system/tapzero'
import { skipReason } from '../helpers/skip.js'
import type { ClientState } from '../../src/client-state.js'
import {
    createGroup,
    joinGroup,
    makePskIndex,
} from '../../src/client-state.js'
import type { ClientConfig } from '../../src/client-config.js'
import { createCommit } from '../../src/create-commit.js'
import {
    createApplicationMessage,
    createProposal,
    createUpdateProposal,
} from '../../src/create-message.js'
import { processMessage } from '../../src/process-messages.js'
import type { ProcessMessageResult } from '../../src/process-messages.js'
import { emptyPskIndex } from '../../src/psk-index.js'
import {
    branchGroup,
    joinGroupFromBranch,
    joinGroupFromReinit,
    reinitCreateNewGroup,
    reinitGroup,
} from '../../src/resumption.js'
import type {
    CiphersuiteImpl,
    CiphersuiteName,
} from '../../src/crypto/ciphersuite.js'
import { getCiphersuiteFromName } from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import type { Credential } from '../../src/credential.js'
import { generateKeyPackage } from '../../src/key-package.js'
import type { MLSMessage } from '../../src/message.js'
import { defaultLifetime } from '../../src/lifetime.js'
import { defaultCapabilities } from '../../src/default-capabilities.js'
import { defaultKeyRetentionConfig } from '../../src/key-retention-config.js'
import { sampleCiphersuites } from '../helpers/suite-filter.js'
import { testClientConfig } from '../helpers/client-config.js'
import { sameSignerKeyPackage } from '../helpers/same-signer-key-package.js'
import { testEveryoneCanMessageEveryone } from '../scenario/common.js'

function collectBuffers (
    value:unknown,
    out = new Set<Uint8Array>(),
    seen = new Set<unknown>()
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
    for (const child of children) collectBuffers(child, out, seen)
    return out
}

function publicRecord (state:ClientState):unknown[] {
    const historical = [...state.historicalReceiverData.values()]
    return [
        state.ratchetTree,
        state.groupContext,
        state.confirmationTag,
        state.unappliedProposals,
        state.clientConfig,
        state.groupActiveState,
        ...historical.map((h) => [h.ratchetTree, h.groupContext]),
    ]
}

/**
 * Checks `consumed` against the rule, then wipes every listed buffer, as
 * an application does once it has persisted `after`.
 */
function checkAndWipe (
    t:any,
    label:string,
    before:ClientState,
    after:ClientState,
    consumed:Uint8Array[],
):void {
    const reachableBefore = collectBuffers(before)
    const reachableAfter = collectBuffers(after)
    const publicBefore = collectBuffers(publicRecord(before))
    const listed = new Set(consumed)

    t.ok(consumed.every((b) => !reachableAfter.has(b)),
        `${label}: no consumed buffer is reachable from the new state`)
    t.ok(consumed.every((b) => reachableBefore.has(b)),
        `${label}: every consumed buffer came from the input state`)

    const missed = [...reachableBefore].filter((b) =>
        b.length > 0 &&
        !reachableAfter.has(b) &&
        !publicBefore.has(b) &&
        !listed.has(b))
    t.equal(missed.length, 0,
        `${label}: every secret the new state dropped is consumed`)

    for (const buffer of consumed) buffer.fill(0)
}

async function receive (
    t:any,
    label:string,
    state:ClientState,
    message:MLSMessage,
    cs:CiphersuiteImpl,
):Promise<ProcessMessageResult> {
    if (
        message.wireformat !== 'mls_private_message' &&
        message.wireformat !== 'mls_public_message'
    ) throw new Error('Expected a framed message')
    const result = await processMessage(
        message,
        state,
        makePskIndex(state, {}),
        undefined,
        cs,
    )
    checkAndWipe(t, label, state, result.newState, result.consumed)
    return result
}

async function send (
    t:any,
    label:string,
    state:ClientState,
    text:string,
    cs:CiphersuiteImpl,
):Promise<{ newState:ClientState; message:MLSMessage }> {
    const sent = await createApplicationMessage(
        state, new TextEncoder().encode(text), cs)
    checkAndWipe(t, label, state, sent.newState, sent.consumed)
    return {
        newState: sent.newState,
        message: {
            wireformat: 'mls_private_message',
            version: 'mls10',
            privateMessage: sent.privateMessage,
        },
    }
}

function credential (name:string):Credential {
    return {
        credentialType: 'basic',
        identity: new TextEncoder().encode(name),
    }
}

async function member (name:string, cs:CiphersuiteImpl) {
    return generateKeyPackage(
        credential(name),
        defaultCapabilities(),
        defaultLifetime(),
        [],
        cs,
    )
}

async function lifecycle (t:any, cipherSuite:CiphersuiteName) {
    const cs = await getCipherSuite(getCiphersuiteFromName(cipherSuite))
    // one retained epoch, so every commit after the first evicts one
    const config:ClientConfig = {
        ...testClientConfig,
        keyRetentionConfig: {
            ...defaultKeyRetentionConfig,
            retainKeysForEpochs: 1,
        },
    }
    const alice = await member('alice', cs)
    const bob = await member('bob', cs)
    const charlie = await member('charlie', cs)

    let aliceGroup = await createGroup(
        new TextEncoder().encode('group'),
        alice.publicPackage,
        alice.privatePackage,
        [],
        cs,
        config,
    )

    // add
    const addBob = await createCommit(
        { state: aliceGroup, cipherSuite: cs },
        {
            extraProposals: [{
                proposalType: 'add',
                add: { keyPackage: bob.publicPackage },
            }],
        },
    )
    checkAndWipe(t, 'add bob', aliceGroup, addBob.newState, addBob.consumed)
    aliceGroup = addBob.newState
    let bobGroup = await joinGroup(
        addBob.welcome!,
        bob.publicPackage,
        bob.privatePackage,
        emptyPskIndex,
        cs,
        aliceGroup.ratchetTree,
        undefined,
        config,
    )

    // application messages both ways
    const a1 = await send(t, 'alice sends', aliceGroup, 'a1', cs)
    aliceGroup = a1.newState
    bobGroup = (await receive(t, 'bob receives', bobGroup, a1.message, cs))
        .newState
    const b1 = await send(t, 'bob sends', bobGroup, 'b1', cs)
    bobGroup = b1.newState
    aliceGroup = (await receive(
        t, 'alice receives', aliceGroup, b1.message, cs)).newState

    // out of order: the second message skips a generation, and the first
    // then uses the key retained for it
    const a2 = await send(t, 'alice sends a2', aliceGroup, 'a2', cs)
    aliceGroup = a2.newState
    const a3 = await send(t, 'alice sends a3', aliceGroup, 'a3', cs)
    aliceGroup = a3.newState
    bobGroup = (await receive(
        t, 'bob receives a3 early', bobGroup, a3.message, cs)).newState
    const late = await receive(
        t, 'bob receives a2 late', bobGroup, a2.message, cs)
    t.equal(late.kind, 'applicationMessage', 'the late message decrypts')
    bobGroup = late.newState

    // a proposal, sent and received
    const proposed = await createProposal(bobGroup, false, {
        proposalType: 'add',
        add: { keyPackage: charlie.publicPackage },
    }, cs)
    checkAndWipe(t, 'bob proposes', bobGroup, proposed.newState,
        proposed.consumed)
    bobGroup = proposed.newState
    aliceGroup = (await receive(
        t, 'alice receives the proposal', aliceGroup, proposed.message, cs))
        .newState

    // a commit sent and a commit received
    const addCharlie = await createCommit(
        { state: aliceGroup, cipherSuite: cs })
    checkAndWipe(t, 'alice commits', aliceGroup, addCharlie.newState,
        addCharlie.consumed)
    aliceGroup = addCharlie.newState
    bobGroup = (await receive(
        t, 'bob receives the commit', bobGroup, addCharlie.commit, cs))
        .newState
    let charlieGroup = await joinGroup(
        addCharlie.welcome!,
        charlie.publicPackage,
        charlie.privatePackage,
        emptyPskIndex,
        cs,
        aliceGroup.ratchetTree,
        undefined,
        config,
    )

    // an Update proposal: bob keeps its new key, alice commits it, and
    // bob installs the key when he receives the commit
    const updated = await createUpdateProposal(bobGroup, false, cs)
    checkAndWipe(t, 'bob proposes an Update', bobGroup, updated.newState,
        updated.consumed)
    bobGroup = updated.newState
    aliceGroup = (await receive(
        t, 'alice receives the Update', aliceGroup, updated.message, cs))
        .newState
    charlieGroup = (await receive(
        t, 'charlie receives the Update', charlieGroup, updated.message, cs))
        .newState
    const commitUpdate = await createCommit(
        { state: aliceGroup, cipherSuite: cs })
    checkAndWipe(t, 'alice commits the Update', aliceGroup,
        commitUpdate.newState, commitUpdate.consumed)
    aliceGroup = commitUpdate.newState
    bobGroup = (await receive(
        t, 'bob receives the commit of his Update', bobGroup,
        commitUpdate.commit, cs)).newState
    charlieGroup = (await receive(
        t, 'charlie receives the commit of the Update', charlieGroup,
        commitUpdate.commit, cs)).newState

    // a second Update, still pending when bob commits: his own commit
    // leaves it out, so its keys are dropped. It rotates bob's signature
    // key, so the dropped keys include a pending signature key. (The
    // first Update keeps bob's key: the branch below signs with it.)
    const pendingUpdate = await createUpdateProposal(bobGroup, false, cs, {
        leafNodePatch: { signatureKeyPair: await cs.signature.keygen() },
    })
    checkAndWipe(t, 'bob proposes another Update', bobGroup,
        pendingUpdate.newState, pendingUpdate.consumed)
    bobGroup = pendingUpdate.newState

    // an epoch evicted under the one-epoch retention limit
    const evicting = await createCommit({ state: bobGroup, cipherSuite: cs })
    const evictedEpochs = [...bobGroup.historicalReceiverData.keys()]
        .filter((e) => !evicting.newState.historicalReceiverData.has(e))
    t.ok(evictedEpochs.length > 0, 'the commit evicts a retained epoch')
    checkAndWipe(t, 'bob commits and evicts', bobGroup, evicting.newState,
        evicting.consumed)
    bobGroup = evicting.newState
    aliceGroup = (await receive(
        t, 'alice receives and evicts', aliceGroup, evicting.commit, cs))
        .newState
    charlieGroup = (await receive(
        t, 'charlie receives', charlieGroup, evicting.commit, cs)).newState

    ;[aliceGroup, bobGroup, charlieGroup] = (
        await testEveryoneCanMessageEveryone(
            [aliceGroup, bobGroup, charlieGroup], cs, t)
    ).updatedGroups as [ClientState, ClientState, ClientState]

    // a branch: the old group goes on, so nothing of it is consumed
    const aliceBranchKp = await sameSignerKeyPackage(
        credential('alice'),
        alice.publicPackage.leafNode.signaturePublicKey,
        alice.privatePackage.signaturePrivateKey,
        cs,
    )
    const bobBranchKp = await sameSignerKeyPackage(
        credential('bob'),
        bob.publicPackage.leafNode.signaturePublicKey,
        bob.privatePackage.signaturePrivateKey,
        cs,
    )
    const branched = await branchGroup(
        aliceGroup,
        aliceBranchKp.publicPackage,
        aliceBranchKp.privatePackage,
        [bobBranchKp.publicPackage],
        new TextEncoder().encode('branch'),
        cs,
    )
    t.equal(branched.consumed.length, 0,
        'a branch consumes nothing of the group it branches from')
    const bobBranch = await joinGroupFromBranch(
        bobGroup,
        branched.welcome!,
        bobBranchKp.publicPackage,
        bobBranchKp.privatePackage,
        branched.newState.ratchetTree,
        cs,
    )
    await testEveryoneCanMessageEveryone(
        [branched.newState, bobBranch], cs, t)

    // a reinit: the commit that suspends the group, then the new group
    const reinit = await reinitGroup(
        aliceGroup,
        new TextEncoder().encode('reinit'),
        'mls10',
        cipherSuite,
        [],
        cs,
    )
    checkAndWipe(t, 'alice commits the reinit', aliceGroup, reinit.newState,
        reinit.consumed)
    aliceGroup = reinit.newState
    bobGroup = (await receive(
        t, 'bob receives the reinit', bobGroup, reinit.commit, cs)).newState
    charlieGroup = (await receive(
        t, 'charlie receives the reinit', charlieGroup, reinit.commit, cs))
        .newState

    const aliceReinitKp = await member('alice', cs)
    const bobReinitKp = await member('bob', cs)
    const resumed = await reinitCreateNewGroup(
        aliceGroup,
        aliceReinitKp.publicPackage,
        aliceReinitKp.privatePackage,
        [bobReinitKp.publicPackage],
        new TextEncoder().encode('reinit'),
        cipherSuite,
        [],
    )
    t.equal(resumed.consumed.length, 0,
        'the resumed group consumes nothing of the suspended one')
    const bobResumed = await joinGroupFromReinit(
        bobGroup,
        resumed.welcome!,
        bobReinitKp.publicPackage,
        bobReinitKp.privatePackage,
        resumed.newState.ratchetTree,
    )

    // the new group still commits after a wiped commit result
    const final = await createCommit(
        { state: resumed.newState, cipherSuite: cs })
    checkAndWipe(t, 'alice commits in the new group', resumed.newState,
        final.newState, final.consumed)
    const bobFinal = (await receive(
        t, 'bob receives in the new group', bobResumed, final.commit, cs))
        .newState
    await testEveryoneCanMessageEveryone([final.newState, bobFinal], cs, t)
}

for (const cs of sampleCiphersuites()) {
    test('consumed secrets are safe to wipe ' + cs, async (t) => {
        try {
            await lifecycle(t, cs as CiphersuiteName)
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
