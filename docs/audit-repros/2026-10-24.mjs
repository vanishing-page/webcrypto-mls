// Standalone audit evidence, not a regression suite.
// These assertions confirm vulnerable behavior at the audited revision.
// Bundle with esbuild; see AUDIT-2026-10-24.md for the exact command.
// No network requests or persistent group state are created.
import assert from 'node:assert/strict'
import {
    getCipherSuite, generateKeyPackage, defaultCapabilities,
    defaultLifetime, createGroup, createCommit, joinGroup,
    makePskIndex, processMessage, createProposal,
    createApplicationMessage, reinitGroup,
    joinGroupFromBranch, joinGroupFromReinit,
} from '../../src/index.js'
import {
    signKeyPackage,
} from '../../src/key-package.js'
import {
    signLeafNodeKeyPackage,
} from '../../src/leaf-node.js'
import {
    testClientConfig,
} from '../../test/helpers/client-config.js'

const cs = await getCipherSuite()
const bytes = text => new TextEncoder().encode(text)
async function member (name) {
    return generateKeyPackage(
        { credentialType: 'basic', identity: bytes(name) },
        defaultCapabilities(), defaultLifetime(), [], cs,
    )
}
async function group (owner, id) {
    return createGroup(
        bytes(id), owner.publicPackage, owner.privatePackage,
        [], cs, testClientConfig,
    )
}
async function add (state, kp) {
    return createCommit({ state, cipherSuite: cs }, {
        extraProposals: [{ proposalType: 'add', add: { keyPackage: kp } }],
        ratchetTreeExtension: true,
    })
}
async function join (result, user) {
    return joinGroup(
        result.welcome, user.publicPackage, user.privatePackage,
        makePskIndex(undefined, {}), cs, undefined, undefined,
        testClientConfig,
    )
}
const alice = await member('alice')
const bob = await member('bob')
const initial = await add(await group(alice, 'original'), bob.publicPackage)
const aliceState = initial.newState
const bobState = await join(initial, bob)

// A normal Welcome contains no resumption PSK and names another group.
const freshBob = await member('bob')
const unrelated = await add(
    await group(alice, 'unrelated'), freshBob.publicPackage,
)
const copyKeys = () => ({
    ...freshBob.privatePackage,
    initPrivateKey: freshBob.privatePackage.initPrivateKey.slice(),
})
const branched = await joinGroupFromBranch(
    bobState, unrelated.welcome, freshBob.publicPackage,
    copyKeys(), undefined, cs,
)
assert.equal(new TextDecoder().decode(branched.groupContext.groupId),
    'unrelated')
console.log('F1: branch wrapper accepted an ordinary unrelated Welcome')
const reinit = await reinitGroup(
    aliceState, bytes('expected-reinit'), 'mls10', cs.name, [], cs,
)
const suspended = await processMessage(
    reinit.commit, bobState, makePskIndex(bobState, {}), undefined, cs,
)
assert.equal(suspended.newState.groupActiveState.kind,
    'suspendedPendingReinit')
const resumed = await joinGroupFromReinit(
    suspended.newState, unrelated.welcome, freshBob.publicPackage,
    copyKeys(), undefined,
)
assert.equal(new TextDecoder().decode(resumed.groupContext.groupId),
    'unrelated')
console.log('F1: reinit wrapper accepted wrong groupId without its PSK')

// A zero-byte PSK nonce is impossible to commit in this ciphersuite.
const pskProposal = {
    proposalType: 'psk',
    psk: {
        preSharedKeyId: {
            psktype: 'external',
            pskId: bytes('known'),
            pskNonce: new Uint8Array(),
        }
    },
}
const proposal = await createProposal(bobState, true, pskProposal, cs)
const staged = await processMessage(
    proposal.message, aliceState, makePskIndex(aliceState, {}),
    undefined, cs,
)
assert.equal(Object.keys(staged.newState.unappliedProposals).length, 1)
await assert.rejects(createCommit({
    state: staged.newState,
    cipherSuite: cs,
    pskIndex: { findPsk: () => new Uint8Array(32).fill(7) },
}), /pskNonce length/)
await assert.rejects(createApplicationMessage(
    staged.newState, bytes('hello'), cs,
), /unapplied proposals/i)
console.log('F2: invalid PSK staged; commit and application send blocked')

// A signed KeyPackage with a one-byte leaf encryption key is admitted.
const mallory = await member('mallory')
const invalidLeaf = await signLeafNodeKeyPackage({
    ...mallory.publicPackage.leafNode,
    hpkePublicKey: new Uint8Array([1]),
    info: { leafNodeSource: 'key_package' },
}, mallory.privatePackage.signaturePrivateKey, cs.signature)
const invalidKp = await signKeyPackage({
    ...mallory.publicPackage, leafNode: invalidLeaf,
}, mallory.privatePackage.signaturePrivateKey, cs.signature)
const poisoned = await add(aliceState, invalidKp)
const maliciousJoin = await join(poisoned, {
    publicPackage: invalidKp, privatePackage: mallory.privatePackage,
})
assert.equal(maliciousJoin.ratchetTree[4].leaf.hpkePublicKey.length, 1)
const received = await processMessage(
    poisoned.commit, bobState, makePskIndex(bobState, {}), undefined, cs,
)
assert.equal(received.newState.ratchetTree[4].leaf.hpkePublicKey.length, 1)
await assert.rejects(createCommit({
    state: received.newState, cipherSuite: cs,
}), error => {
    console.log('F3: subsequent commit throws', error.name, error.message)
    return true
})
console.log('F3: Add accepted malformed leaf key on send and receive')
