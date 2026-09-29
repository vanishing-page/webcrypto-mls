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
 *
 * The commit cases below are audit 2026-09 H1: merging and pruning the
 * private key path used to wipe the superseded HPKE path keys, which
 * belong to the input state. A bad-tag commit wiped them before its
 * confirmation tag was checked, a lost commit race wiped the loser's
 * own keys, and a later commit from the retained state could no longer
 * be decrypted.
 */
import { skipReason } from '../helpers/skip.js'
import { test } from '@substrate-system/tapzero'
import type { ClientState } from '../../src/client-state.js'
import { createGroup, joinGroup, makePskIndex } from '../../src/client-state.js'
import {
    createCommit,
    createGroupInfoWithExternalPubAndRatchetTree,
    joinGroupExternal
} from '../../src/create-commit.js'
import { createApplicationMessage } from '../../src/create-message.js'
import {
    processMessage,
    processPrivateMessage
} from '../../src/process-messages.js'
import {
    protectPublicMessage
} from '../../src/message-protection-public.js'
import { protect } from '../../src/message-protection.js'
import { createContentCommitSignature } from '../../src/framed-content.js'
import type {
    MLSMessage,
    MlsPrivateMessage,
    MlsPublicMessage
} from '../../src/message.js'
import { CryptoVerificationError } from '../../src/mls-error.js'
import { emptyPskIndex } from '../../src/psk-index.js'
import type { Credential } from '../../src/credential.js'
import type { CiphersuiteName } from '../../src/crypto/ciphersuite.js'
import { getCiphersuiteFromName } from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import { generateKeyPackage } from '../../src/key-package.js'
import type { ProposalAdd, Proposal } from '../../src/proposal.js'
import type { CiphersuiteImpl } from '../../src/crypto/ciphersuite.js'
import { constantTimeEqual } from '../../src/util/constant-time-compare.js'
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
                t.comment(`Skipping ${cs}: ${skipReason(error)}`)
                return
            }
            throw error
        }
    })

    test('a bad confirmation tag leaves the receiver able to process ' +
        'an honest commit ' + cs, async (t) => {
        try {
            await badTagCommitLeavesStateUsable(t, cs as CiphersuiteName)
        } catch (error:any) {
            if (skippable(error)) {
                t.comment(`Skipping ${cs}: ${skipReason(error)}`)
                return
            }
            throw error
        }
    })

    test('a bad confirmation tag in a PrivateMessage leaves the receiver ' +
        'able to process an honest commit ' + cs, async (t) => {
        try {
            await badTagPrivateCommitLeavesStateUsable(
                t,
                cs as CiphersuiteName
            )
        } catch (error:any) {
            if (skippable(error)) {
                t.comment(`Skipping ${cs}: ${skipReason(error)}`)
                return
            }
            throw error
        }
    })

    test('a bad confirmation tag in an external commit leaves the ' +
        'receiver able to process an honest commit ' + cs, async (t) => {
        try {
            await badTagExternalCommitLeavesStateUsable(
                t,
                cs as CiphersuiteName
            )
        } catch (error:any) {
            if (skippable(error)) {
                t.comment(`Skipping ${cs}: ${skipReason(error)}`)
                return
            }
            throw error
        }
    })

    test('the loser of a commit race processes the winner from its ' +
        'prior state ' + cs, async (t) => {
        try {
            await losingCommitRaceRecovers(t, cs as CiphersuiteName)
        } catch (error:any) {
            if (skippable(error)) {
                t.comment(`Skipping ${cs}: ${skipReason(error)}`)
                return
            }
            throw error
        }
    })

    test('a createCommit that throws after its UpdatePath can be retried ' +
        'from the same state ' + cs, async (t) => {
        try {
            await failedCreateCommitCanBeRetried(t, cs as CiphersuiteName)
        } catch (error:any) {
            if (skippable(error)) {
                t.comment(`Skipping ${cs}: ${skipReason(error)}`)
                return
            }
            throw error
        }
    })

    test('a successful processMessage leaves the input state usable ' +
        cs, async (t) => {
        try {
            await processedStateCanBeReused(t, cs as CiphersuiteName)
        } catch (error:any) {
            if (skippable(error)) {
                t.comment(`Skipping ${cs}: ${skipReason(error)}`)
                return
            }
            throw error
        }
    })

    test('a successful createCommit leaves the input state usable ' +
        cs, async (t) => {
        try {
            await committedStateCanBeReused(t, cs as CiphersuiteName)
        } catch (error:any) {
            if (skippable(error)) {
                t.comment(`Skipping ${cs}: ${skipReason(error)}`)
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
                t.comment(`Skipping ${cs}: ${skipReason(error)}`)
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

async function makeKeyPackage (name:string, impl:any) {
    const credential:Credential = {
        credentialType: 'basic',
        identity: new TextEncoder().encode(name),
    }
    return generateKeyPackage(
        credential,
        defaultCapabilities(),
        defaultLifetime(),
        [],
        impl
    )
}

function accept () {
    return 'accept' as const
}

async function process (
    state:ClientState,
    message:MLSMessage,
    impl:any,
):Promise<ClientState> {
    if (
        message.wireformat !== 'mls_public_message' &&
        message.wireformat !== 'mls_private_message'
    ) {
        throw new Error('Expected a handshake message')
    }
    const result = await processMessage(
        message as MlsPublicMessage | MlsPrivateMessage,
        state,
        makePskIndex(state, {}),
        accept,
        impl,
    )
    return result.newState
}

/**
 * alice, bob, charlie and dave at leaves 0 to 3, after charlie has
 * committed a path. charlie then holds the private key for node 5, his
 * parent, and any later commit from alice or bob is encrypted to it:
 * node 5 is the copath resolution of the root on their side. A commit
 * from dave (or anyone landing at leaf 3) rotates node 5, so it is the
 * key a wipe of superseded path keys would take from charlie.
 */
async function makeFourMemberGroup (cipherSuite:CiphersuiteName) {
    const impl = await getCipherSuite(getCiphersuiteFromName(cipherSuite))

    const alice = await makeKeyPackage('alice', impl)
    const bob = await makeKeyPackage('bob', impl)
    const charlie = await makeKeyPackage('charlie', impl)
    const dave = await makeKeyPackage('dave', impl)

    const created = await createGroup(
        new TextEncoder().encode('prior-state-commit-group'),
        alice.publicPackage,
        alice.privatePackage,
        [],
        impl,
        testClientConfig
    )

    const adds:ProposalAdd[] = [bob, charlie, dave].map((kp) => ({
        proposalType: 'add',
        add: { keyPackage: kp.publicPackage },
    }))

    const addAll = await createCommit(
        { state: created, cipherSuite: impl },
        { extraProposals: adds, ratchetTreeExtension: true }
    )
    const welcome = addAll.welcome
    if (welcome === undefined) throw new Error('Expected a welcome')

    const join = (kp:typeof bob) => joinGroup(
        welcome,
        kp.publicPackage,
        kp.privatePackage,
        emptyPskIndex,
        impl,
        undefined,
        undefined,
        testClientConfig
    )

    const charlieCommit = await createCommit({
        state: await join(charlie),
        cipherSuite: impl,
    })

    return {
        impl,
        dave,
        alice: await process(addAll.newState, charlieCommit.commit, impl),
        bob: await process(await join(bob), charlieCommit.commit, impl),
        charlie: charlieCommit.newState,
        daveGroup: await process(await join(dave), charlieCommit.commit, impl),
    }
}

function flipped (tag:Uint8Array):Uint8Array {
    const copy = tag.slice()
    copy[0]! ^= 0x01
    return copy
}

/**
 * dave commits a path as a PublicMessage, then flips its confirmation
 * tag and re-MACs the membership tag, so the signature and the MAC both
 * verify and only the confirmation tag is wrong.
 */
async function badTagPublicCommit (
    dave:ClientState,
    impl:any,
):Promise<MLSMessage> {
    const honest = await createCommit(
        { state: dave, cipherSuite: impl },
        { wireAsPublicMessage: true }
    )
    if (honest.commit.wireformat !== 'mls_public_message') {
        throw new Error('Expected a public message commit')
    }
    const pm = honest.commit.publicMessage
    if (pm.auth.contentType !== 'commit') throw new Error('Expected a commit')

    const publicMessage = await protectPublicMessage(
        dave.keySchedule.membershipKey,
        dave.groupContext,
        {
            wireformat: 'mls_public_message',
            content: pm.content,
            auth: {
                ...pm.auth,
                confirmationTag: flipped(pm.auth.confirmationTag),
            },
        },
        impl,
    )

    return {
        version: 'mls10',
        wireformat: 'mls_public_message',
        publicMessage,
    }
}

async function rejection (fn:() => Promise<unknown>):Promise<unknown> {
    try {
        await fn()
    } catch (err) {
        return err
    }
    return undefined
}

/**
 * charlie rejects `bad`, then processes an honest path commit from alice
 * out of the same retained state. alice's path reaches charlie through
 * node 5, the key `bad` would have superseded.
 */
async function honestCommitAfterRejection (
    t:any,
    group:Awaited<ReturnType<typeof makeFourMemberGroup>>,
    bad:MLSMessage,
) {
    const { impl, alice, bob, charlie } = group

    const err = await rejection(() => process(charlie, bad, impl))
    t.ok(
        err instanceof CryptoVerificationError,
        'charlie should reject the bad confirmation tag'
    )

    const honest = await createCommit({ state: alice, cipherSuite: impl })
    const charlieNext = await process(charlie, honest.commit, impl)
    const bobNext = await process(bob, honest.commit, impl)

    t.equal(
        charlieNext.groupContext.epoch,
        alice.groupContext.epoch + 1n,
        'charlie should process the honest commit from the retained state'
    )

    const hello = new TextEncoder().encode('after the bad commit')
    const sent = await createApplicationMessage(charlieNext, hello, impl)
    const read = await receive(bobNext, sent.privateMessage, impl)
    t.deepEqual(read.message, hello, 'bob should read charlie afterwards')
}

async function badTagCommitLeavesStateUsable (
    t:any,
    cipherSuite:CiphersuiteName
) {
    const group = await makeFourMemberGroup(cipherSuite)
    const bad = await badTagPublicCommit(group.daveGroup, group.impl)
    await honestCommitAfterRejection(t, group, bad)
}

/**
 * The same bad-tag commit from dave, re-signed for the PrivateMessage
 * wireformat and encrypted under dave's own handshake ratchet, so it
 * decrypts and verifies and only the confirmation tag is wrong.
 */
async function badTagPrivateCommit (
    dave:ClientState,
    impl:any,
):Promise<MLSMessage> {
    const honest = await createCommit(
        { state: dave, cipherSuite: impl },
        { wireAsPublicMessage: true }
    )
    if (honest.commit.wireformat !== 'mls_public_message') {
        throw new Error('Expected a public message commit')
    }
    const pm = honest.commit.publicMessage
    if (pm.auth.contentType !== 'commit') throw new Error('Expected a commit')
    if (pm.content.contentType !== 'commit') throw new Error('Expected commit')

    const { framedContent, signature } = await createContentCommitSignature(
        dave.groupContext,
        'mls_private_message',
        pm.content.commit,
        { senderType: 'member', leafIndex: dave.privatePath.leafIndex },
        new Uint8Array(),
        dave.signaturePrivateKey,
        impl.signature,
    )

    const { privateMessage } = await protect(
        dave.keySchedule.senderDataSecret,
        new Uint8Array(),
        dave.groupContext,
        dave.secretTree,
        {
            ...framedContent,
            auth: {
                contentType: 'commit',
                signature,
                confirmationTag: flipped(pm.auth.confirmationTag),
            },
        },
        dave.privatePath.leafIndex,
        dave.clientConfig.paddingConfig,
        impl,
    )

    return {
        version: 'mls10',
        wireformat: 'mls_private_message',
        privateMessage,
    }
}

async function badTagPrivateCommitLeavesStateUsable (
    t:any,
    cipherSuite:CiphersuiteName
) {
    const group = await makeFourMemberGroup(cipherSuite)
    const bad = await badTagPrivateCommit(group.daveGroup, group.impl)
    await honestCommitAfterRejection(t, group, bad)
}

/**
 * dave resyncs through an external commit, which removes his old leaf 3
 * and lands him back on it, so its path rotates node 5 just as a member
 * commit from leaf 3 would. A `new_member_commit` carries no membership
 * tag, so the flipped confirmation tag needs no re-MAC.
 */
async function badTagExternalCommit (
    group:Awaited<ReturnType<typeof makeFourMemberGroup>>,
):Promise<MLSMessage> {
    const { impl, alice, dave } = group

    const groupInfo = await createGroupInfoWithExternalPubAndRatchetTree(
        alice,
        [],
        impl
    )

    const { publicMessage } = await joinGroupExternal(
        groupInfo,
        dave.publicPackage,
        dave.privatePackage,
        true,
        impl,
        undefined,
        testClientConfig
    )
    if (publicMessage.auth.contentType !== 'commit') {
        throw new Error('Expected a commit')
    }

    return {
        version: 'mls10',
        wireformat: 'mls_public_message',
        publicMessage: {
            ...publicMessage,
            auth: {
                ...publicMessage.auth,
                confirmationTag: flipped(publicMessage.auth.confirmationTag),
            },
        },
    }
}

async function badTagExternalCommitLeavesStateUsable (
    t:any,
    cipherSuite:CiphersuiteName
) {
    const group = await makeFourMemberGroup(cipherSuite)
    const bad = await badTagExternalCommit(group)
    await honestCommitAfterRejection(t, group, bad)
}

/**
 * charlie and alice both commit from the same epoch and the delivery
 * service orders alice's first. charlie drops his own commit and, as RFC
 * 9420 SS14 expects, processes alice's from the state he held before
 * calling `createCommit`. alice's path reaches charlie through node 5,
 * the very key charlie's own commit rotated.
 */
async function losingCommitRaceRecovers (
    t:any,
    cipherSuite:CiphersuiteName
) {
    const { impl, alice, bob, charlie } =
        await makeFourMemberGroup(cipherSuite)

    const lost = await createCommit({ state: charlie, cipherSuite: impl })
    t.equal(
        lost.newState.groupContext.epoch,
        charlie.groupContext.epoch + 1n,
        'sanity: charlie\'s own commit succeeds'
    )

    const won = await createCommit({ state: alice, cipherSuite: impl })
    const charlieNext = await process(charlie, won.commit, impl)
    const bobNext = await process(bob, won.commit, impl)

    t.equal(
        charlieNext.groupContext.epoch,
        won.newState.groupContext.epoch,
        'charlie should process the winning commit from his prior state'
    )

    const hello = new TextEncoder().encode('alice won the race')
    const sent = await createApplicationMessage(won.newState, hello, impl)
    const read = await receive(charlieNext, sent.privateMessage, impl)
    t.deepEqual(read.message, hello, 'charlie should read alice afterwards')

    // and a later epoch still works: bob commits, charlie follows
    const later = await createCommit({ state: bobNext, cipherSuite: impl })
    const charlieLater = await process(read.newState, later.commit, impl)
    const reply = new TextEncoder().encode('two epochs on')
    const replySent = await createApplicationMessage(charlieLater, reply, impl)
    const replyRead = await receive(
        later.newState,
        replySent.privateMessage,
        impl
    )
    t.deepEqual(replyRead.message, reply, 'bob should read charlie later on')
}

class InjectedFailure extends Error {}

/**
 * `impl` with an HPKE that refuses to import `initKey` once any HPKE
 * seal has run. createCommit seals path secrets while building its
 * UpdatePath and imports each joiner's init key only afterwards, in
 * Welcome construction, so the injected failure lands after the path
 * has been generated whatever validation runs on the Add beforehand.
 */
function failingWelcome (
    impl:CiphersuiteImpl,
    initKey:Uint8Array
):CiphersuiteImpl {
    let sealed = false
    const hpke = new Proxy(impl.hpke, {
        get (target, prop) {
            if (prop === 'seal') {
                return (...args:Parameters<typeof target.seal>) => {
                    sealed = true
                    return target.seal(...args)
                }
            }
            if (prop === 'importPublicKey') {
                return (k:Uint8Array) => {
                    if (sealed && constantTimeEqual(k, initKey)) {
                        return Promise.reject(new InjectedFailure())
                    }
                    return target.importPublicKey(k)
                }
            }
            const value = Reflect.get(target, prop, target)
            return typeof value === 'function' ? value.bind(target) : value
        },
    })
    return { ...impl, hpke }
}

/**
 * charlie removes dave and adds eve in one commit, which needs a path
 * (the Remove) and a Welcome (the Add). The first attempt fails while
 * building eve's Welcome; charlie retries from the same state.
 */
async function failedCreateCommitCanBeRetried (
    t:any,
    cipherSuite:CiphersuiteName
) {
    const { impl, alice, bob, charlie } =
        await makeFourMemberGroup(cipherSuite)

    const eve = await makeKeyPackage('eve', impl)
    const proposals:Proposal[] = [
        { proposalType: 'remove', remove: { removed: 3 } },
        { proposalType: 'add', add: { keyPackage: eve.publicPackage } },
    ]
    const options = { extraProposals: proposals, ratchetTreeExtension: true }

    const err = await rejection(() => createCommit(
        {
            state: charlie,
            cipherSuite: failingWelcome(impl, eve.publicPackage.initKey),
        },
        options,
    ))
    t.ok(
        err instanceof InjectedFailure,
        'the first createCommit should fail building the Welcome'
    )

    const retry = await createCommit(
        { state: charlie, cipherSuite: impl },
        options
    )
    if (retry.welcome === undefined) throw new Error('Expected a welcome')

    const aliceNext = await process(alice, retry.commit, impl)
    const bobNext = await process(bob, retry.commit, impl)
    const eveGroup = await joinGroup(
        retry.welcome,
        eve.publicPackage,
        eve.privatePackage,
        emptyPskIndex,
        impl,
        undefined,
        undefined,
        testClientConfig
    )

    const epoch = retry.newState.groupContext.epoch
    t.equal(aliceNext.groupContext.epoch, epoch, 'alice should follow')
    t.equal(bobNext.groupContext.epoch, epoch, 'bob should follow')
    t.equal(eveGroup.groupContext.epoch, epoch, 'eve should join')

    const hello = new TextEncoder().encode('after the retry')
    const sent = await createApplicationMessage(eveGroup, hello, impl)
    const read = await receive(aliceNext, sent.privateMessage, impl)
    t.deepEqual(read.message, hello, 'alice should read eve')

    // charlie can equally abandon the retry and follow a commit from
    // alice instead, which reaches him through node 5 -- a key the
    // failed attempt had already rotated
    const other = await createCommit({ state: alice, cipherSuite: impl })
    const charlieOther = await process(charlie, other.commit, impl)
    t.equal(
        charlieOther.groupContext.epoch,
        other.newState.groupContext.epoch,
        'charlie should follow alice from the state the failure left'
    )
}

/**
 * charlie accepts an honest commit from dave, then resolves a fork the
 * other way: from the state he held before, he follows a commit from
 * alice instead. dave's commit rotated node 5 in the state charlie
 * returned; alice's reaches charlie through node 5 in the one he kept.
 */
async function processedStateCanBeReused (
    t:any,
    cipherSuite:CiphersuiteName
) {
    const { impl, alice, charlie, daveGroup } =
        await makeFourMemberGroup(cipherSuite)

    const fromDave = await createCommit({ state: daveGroup, cipherSuite: impl })
    const charlieAfterDave = await process(charlie, fromDave.commit, impl)
    t.equal(
        charlieAfterDave.groupContext.epoch,
        charlie.groupContext.epoch + 1n,
        'sanity: charlie processes dave\'s commit'
    )

    const fromAlice = await createCommit({ state: alice, cipherSuite: impl })
    const charlieAfterAlice = await process(charlie, fromAlice.commit, impl)
    t.equal(
        charlieAfterAlice.groupContext.epoch,
        fromAlice.newState.groupContext.epoch,
        'charlie should follow alice from the state he held before'
    )

    const hello = new TextEncoder().encode('the other branch')
    const sent = await createApplicationMessage(charlieAfterAlice, hello, impl)
    const read = await receive(fromAlice.newState, sent.privateMessage, impl)
    t.deepEqual(read.message, hello, 'alice should read charlie')
}

/**
 * charlie commits successfully and the commit is lost in transit. From
 * the same input state he can commit again, and every member follows
 * that; or he can follow a commit from alice instead, which reaches him
 * through node 5 -- a key his successful first commit rotated.
 */
async function committedStateCanBeReused (
    t:any,
    cipherSuite:CiphersuiteName
) {
    const { impl, alice, bob, charlie, daveGroup } =
        await makeFourMemberGroup(cipherSuite)

    await createCommit({ state: charlie, cipherSuite: impl })

    const fork = await createCommit({ state: alice, cipherSuite: impl })
    const charlieFork = await process(charlie, fork.commit, impl)
    t.equal(
        charlieFork.groupContext.epoch,
        fork.newState.groupContext.epoch,
        'charlie should follow alice from the state he committed from'
    )

    const second = await createCommit({ state: charlie, cipherSuite: impl })

    const aliceNext = await process(alice, second.commit, impl)
    const bobNext = await process(bob, second.commit, impl)
    const daveNext = await process(daveGroup, second.commit, impl)

    const epoch = second.newState.groupContext.epoch
    t.equal(aliceNext.groupContext.epoch, epoch, 'alice should follow')
    t.equal(bobNext.groupContext.epoch, epoch, 'bob should follow')
    t.equal(daveNext.groupContext.epoch, epoch, 'dave should follow')

    const fromAlice = await createCommit({
        state: aliceNext,
        cipherSuite: impl,
    })
    const charlieNext = await process(second.newState, fromAlice.commit, impl)
    t.equal(
        charlieNext.groupContext.epoch,
        epoch + 1n,
        'charlie should follow alice after the second commit'
    )
}
