/**
 * A `ClientState` is an immutable value: every operation returns a new
 * state and the caller may still hold the old one. These tests hold the
 * prior state deliberately -- the natural pattern on a transport failure,
 * a rejected-commit retry, or a re-render that kept the old object -- and
 * check that nothing in the ratchet has been zeroized out from under it.
 *
 * See security-audit.md C1: `createRatchetResultWithSecret` used to wipe
 * the buffer it was handed, which is the *input* tree's live node secret
 * on the send path, so a second send from a prior state derived its AEAD
 * key from an all-zero secret.
 */
import { test } from '@substrate-system/tapzero'
import type { ClientState } from '../../src/client-state.js'
import { createGroup, joinGroup, makePskIndex } from '../../src/client-state.js'
import { createCommit } from '../../src/create-commit.js'
import { createApplicationMessage } from '../../src/create-message.js'
import { processPrivateMessage } from '../../src/process-messages.js'
import { emptyPskIndex } from '../../src/psk-index.js'
import type { Credential } from '../../src/credential.js'
import type { CiphersuiteName } from '../../src/crypto/ciphersuite.js'
import { getCiphersuiteFromName } from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import { generateKeyPackage } from '../../src/key-package.js'
import type { ProposalAdd } from '../../src/proposal.js'
import type { PrivateMessage } from '../../src/private-message.js'
import { defaultLifetime } from '../../src/lifetime.js'
import { defaultCapabilities } from '../../src/default-capabilities.js'
import { leafToNodeIndex, toLeafIndex } from '../../src/treemath.js'
import { sampleCiphersuites } from '../helpers/suite-filter.js'
import { testClientConfig } from '../helpers/client-config.js'

function skippable (error:any):boolean {
    return error?.name === 'NotSupportedError' || error?.name === 'DependencyError'
}

for (const cs of sampleCiphersuites()) {
    test('sending twice from the same prior ClientState keeps both messages readable ' + cs, async (t) => {
        try {
            await sendTwiceFromPriorState(t, cs as CiphersuiteName)
        } catch (error:any) {
            if (skippable(error)) {
                t.comment(`Skipping ${cs}: ${error.message}`)
                return
            }
            throw error
        }
    })

    test('a failed decrypt leaves the receiver able to send and receive ' + cs, async (t) => {
        try {
            await failedDecryptLeavesStateUsable(t, cs as CiphersuiteName)
        } catch (error:any) {
            if (skippable(error)) {
                t.comment(`Skipping ${cs}: ${error.message}`)
                return
            }
            throw error
        }
    })
}

async function makeTwoMemberGroup (cipherSuite:CiphersuiteName) {
    const impl = await getCipherSuite(getCiphersuiteFromName(cipherSuite))

    const makeMember = async (name:string) => {
        const credential:Credential = {
            credentialType: 'basic',
            identity: new TextEncoder().encode(name),
        }
        return generateKeyPackage(credential, defaultCapabilities(), defaultLifetime(), [], impl)
    }

    const alice = await makeMember('alice')
    const bob = await makeMember('bob')

    const groupId = new TextEncoder().encode('prior-state-reuse-group')

    const created = await createGroup(groupId, alice.publicPackage, alice.privatePackage, [], impl, testClientConfig)

    const addBob:ProposalAdd = {
        proposalType: 'add',
        add: { keyPackage: bob.publicPackage },
    }

    const commit = await createCommit({ state: created, cipherSuite: impl }, { extraProposals: [addBob] })

    if (commit.welcome === undefined) throw new Error('Expected a welcome for bob')

    const aliceGroup = commit.newState

    const bobGroup = await joinGroup(
        commit.welcome,
        bob.publicPackage,
        bob.privatePackage,
        emptyPskIndex,
        impl,
        aliceGroup.ratchetTree,
        undefined,
        testClientConfig
    )

    return { impl, aliceGroup, bobGroup }
}

/**
 * The live application ratchet secret `state` holds for `leafIndex`,
 * defaulting to the state's own leaf (the one a send consumes).
 */
function applicationRatchetSecret (state:ClientState, leafIndex?:number):Uint8Array {
    const leaf = leafIndex ?? state.privatePath.leafIndex
    const index = leafToNodeIndex(toLeafIndex(leaf))
    return state.secretTree[index]!.application.secret
}

async function receive (
    state:ClientState,
    privateMessage:PrivateMessage,
    impl:any,
):Promise<{ newState:ClientState; message:Uint8Array }> {
    const result = await processPrivateMessage(state, privateMessage, makePskIndex(state, {}), impl)

    if (result.kind === 'newState') throw new Error('Expected an application message')

    return { newState: result.newState, message: result.message }
}

async function sendTwiceFromPriorState (t:any, cipherSuite:CiphersuiteName) {
    const { impl, aliceGroup, bobGroup } = await makeTwoMemberGroup(cipherSuite)

    const liveSecret = applicationRatchetSecret(aliceGroup)
    const before = liveSecret.slice()
    t.ok(before.some((b) => b !== 0), 'sanity: alice\'s application ratchet secret is non-zero')

    const first = new TextEncoder().encode('first send')
    const firstResult = await createApplicationMessage(aliceGroup, first, impl)

    t.deepEqual(
        applicationRatchetSecret(aliceGroup),
        before,
        'the prior state\'s ratchet secret should be unchanged after the first send',
    )

    // the transport dropped the first message, so alice retries from the
    // state she still holds rather than from the one the send returned
    const second = new TextEncoder().encode('second send')
    const secondResult = await createApplicationMessage(aliceGroup, second, impl)

    t.deepEqual(
        applicationRatchetSecret(aliceGroup),
        before,
        'the prior state\'s ratchet secret should be unchanged after the second send',
    )

    const firstReceived = await receive(bobGroup, firstResult.privateMessage, impl)
    t.deepEqual(firstReceived.message, first, 'bob should read the first message')

    // both sends used generation 0 from the same prior state, so bob reads
    // the second one from the same starting state as the first
    const secondReceived = await receive(bobGroup, secondResult.privateMessage, impl)
    t.deepEqual(secondReceived.message, second, 'bob should read the retried message')

    // and the state the first send returned still works for a later send
    const third = new TextEncoder().encode('third send')
    const thirdResult = await createApplicationMessage(firstResult.newState, third, impl)
    const thirdReceived = await receive(firstReceived.newState, thirdResult.privateMessage, impl)
    t.deepEqual(thirdReceived.message, third, 'bob should read a message sent from the advanced state')
}

async function failedDecryptLeavesStateUsable (t:any, cipherSuite:CiphersuiteName) {
    const { impl, aliceGroup, bobGroup } = await makeTwoMemberGroup(cipherSuite)

    const good = new TextEncoder().encode('a real message')
    const goodResult = await createApplicationMessage(aliceGroup, good, impl)

    const corrupt:PrivateMessage = {
        ...goodResult.privateMessage,
        ciphertext: goodResult.privateMessage.ciphertext.slice(),
    }
    corrupt.ciphertext[corrupt.ciphertext.length - 1]! ^= 0xff

    // the ratchet a decrypt consumes is the *sender's* leaf in the
    // receiver's own tree, so that is the buffer to watch
    const senderLeaf = aliceGroup.privatePath.leafIndex
    const senderRatchetBefore = applicationRatchetSecret(bobGroup, senderLeaf).slice()

    let threw = false
    try {
        await processPrivateMessage(bobGroup, corrupt, makePskIndex(bobGroup, {}), impl)
    } catch {
        threw = true
    }
    t.ok(threw, 'a corrupted ciphertext should be rejected')

    t.deepEqual(
        applicationRatchetSecret(bobGroup, senderLeaf),
        senderRatchetBefore,
        'the failed decrypt should leave the sender ratchet in bob\'s state intact',
    )

    // bob can still send, and alice can still read it
    const fromBob = new TextEncoder().encode('bob still works')
    const bobSend = await createApplicationMessage(bobGroup, fromBob, impl)
    const aliceReceived = await receive(aliceGroup, bobSend.privateMessage, impl)
    t.deepEqual(aliceReceived.message, fromBob, 'alice should read bob\'s message after the failed decrypt')

    // and bob can still read the uncorrupted original
    const bobReceived = await receive(bobSend.newState, goodResult.privateMessage, impl)
    t.deepEqual(bobReceived.message, good, 'bob should still read the untampered message')
}
