import { test } from '@substrate-system/tapzero'
import {
    decodeMlsMessage,
    encodeMlsMessage,
    createCommit,
    bytesToBase64,
    type CiphersuiteImpl,
    type ClientState
} from '../../src/index.js'
import {
    base64ToBytes,
    base64urlToBytes
} from '../../src/util/byte-array.js'
import {
    initCiphersuite,
    createUser,
    identityOf,
    createOwnGroup,
    encryptMessage,
    encodeKeyPackageB64,
    decodeKeyPackageB64,
    joinFromWelcome,
    commitAdd,
    commitRemove,
    processEntry
} from '../../example-realistic-demo/client/mls-actions.js'
import { membersFromTree, leafIndexOf } from
    '../../example-realistic-demo/client/membership.js'
import type { DemoUser } from '../../example-shared/demo-user.js'

let cs:CiphersuiteImpl

test('the ciphersuite initialises', async (t) => {
    cs = await initCiphersuite()
    t.ok(cs, 'should return a ciphersuite')
})

test('createUser makes one key package', async (t) => {
    const alice = await createUser('alice', cs)
    t.equal(alice.name, 'alice')
    t.ok(alice.keyPackage, 'should have a key package')
    t.ok(alice.privateKeys, 'should have private keys')
})

// realistic-demo.AC2.1 -- the signature key never leaves the browser
test('the signature key is a non-extractable CryptoKey', async (t) => {
    const alice = await createUser('alice', cs)
    const signKey = alice.privateKeys!.signaturePrivateKey
    t.ok(
        signKey instanceof CryptoKey,
        'should be a CryptoKey, not raw bytes'
    )
    t.equal(
        (signKey as CryptoKey).extractable,
        false,
        'should be non-extractable'
    )
})

test('identityOf is the signature public key, not the name', async (t) => {
    const alice = await createUser('alice', cs)
    const identity = identityOf(alice.keyPackage!)
    t.equal(
        base64urlToBytes(identity).join(),
        alice.keyPackage!.leafNode.signaturePublicKey.join(),
        'should decode back to the signature public key'
    )
    t.ok(!identity.includes('alice'), 'should not carry the name')
})

test('two users of the same name get different identities', async (t) => {
    const one = await createUser('alice', cs)
    const two = await createUser('alice', cs)
    t.ok(
        identityOf(one.keyPackage!) !== identityOf(two.keyPackage!),
        'should differ'
    )
})

test('createOwnGroup makes a group of one at epoch zero', async (t) => {
    const alice = await createUser('alice', cs)
    const group = await createOwnGroup(alice, cs)
    t.equal(group.groupContext.epoch, 0n)
    t.equal(
        group.ratchetTree.filter(n => n?.nodeType === 'leaf').length,
        1,
        'should hold exactly one leaf'
    )
})

test('the group id is random, not derived', async (t) => {
    const alice = await createUser('alice', cs)
    const one = await createOwnGroup(alice, cs)
    const two = await createOwnGroup(alice, cs)
    t.equal(one.groupContext.groupId.length, 32)
    t.ok(
        one.groupContext.groupId.join() !== two.groupContext.groupId.join(),
        'two groups for one user should not share an id'
    )
})

test('createOwnGroup refuses a user with no key package', async (t) => {
    try {
        await createOwnGroup({ name: 'alice' }, cs)
        t.fail('should have thrown')
    } catch (_err) {
        t.ok(true, 'should throw')
    }
})

test('encryptMessage returns a decodable private message', async (t) => {
    const alice = await createUser('alice', cs)
    const group = await createOwnGroup(alice, cs)
    const { newState, payload } = await encryptMessage(group, 'hello', cs)

    t.ok(newState !== group, 'should return a new state')

    // Guarded rather than asserted with `!`: a `decoded` of undefined
    // would throw here and abort the whole file, so a single broken
    // payload would hide every test after this one.
    const decoded = decodeMlsMessage(base64ToBytes(payload), 0)
    t.ok(decoded, 'the payload should decode')
    t.equal(
        decoded ? decoded[0].wireformat : null,
        'mls_private_message'
    )
})

test('the ciphertext does not carry the plaintext', async (t) => {
    const alice = await createUser('alice', cs)
    const group = await createOwnGroup(alice, cs)
    const { payload } = await encryptMessage(group, 'hello', cs)
    const bytes = base64ToBytes(payload)
    const text = new TextDecoder().decode(bytes)
    t.ok(!text.includes('hello'), 'should not contain the plaintext')
})

// realistic-demo.AC3.1 -- a join request carries a key package

test('a key package round trips through the wire encoding', async (t) => {
    const alice = await createUser('alice', cs)
    const payload = encodeKeyPackageB64(alice.keyPackage!)
    const back = decodeKeyPackageB64(payload)

    t.ok(back, 'should decode back to a key package')
    t.equal(
        back ? back.leafNode.signaturePublicKey.join() : null,
        alice.keyPackage!.leafNode.signaturePublicKey.join(),
        'should carry the same signature public key'
    )
    t.equal(
        back ? new TextDecoder().decode(
            back.leafNode.credential.credentialType === 'basic' ?
                back.leafNode.credential.identity :
                new Uint8Array(0)
        ) : null,
        'alice',
        'should carry the credential the name is read from'
    )
})

test('decodeKeyPackageB64 refuses a payload that is not one', async (t) => {
    const alice = await createUser('alice', cs)
    const group = await createOwnGroup(alice, cs)
    const { payload } = await encryptMessage(group, 'hello', cs)

    t.equal(
        decodeKeyPackageB64(payload),
        null,
        'another wireformat should decode to null, not to a package'
    )
    t.equal(
        decodeKeyPackageB64(bytesToBase64(new Uint8Array([1, 2, 3]))),
        null,
        'undecodable bytes should decode to null'
    )
})

/**
 * The creator's half of an approval, inlined here rather than imported:
 * Task 4 adds `commitAdd`, and this test only needs a Welcome to join
 * from.
 */
async function welcomeFor (
    group:ClientState,
    joiner:DemoUser,
    suite:CiphersuiteImpl
):Promise<string> {
    const result = await createCommit(
        { state: group, cipherSuite: suite },
        {
            extraProposals: [
                { proposalType: 'add', add: { keyPackage: joiner.keyPackage! } }
            ],
            wireAsPublicMessage: true,
            ratchetTreeExtension: true
        }
    )

    return bytesToBase64(encodeMlsMessage({
        wireformat: 'mls_welcome',
        version: 'mls10',
        welcome: result.welcome!
    }))
}

// realistic-demo.AC3.2 -- a welcome-you joins the group

test('joinFromWelcome joins the group the Welcome names', async (t) => {
    const alice = await createUser('alice', cs)
    const bob = await createUser('bob', cs)
    const aliceGroup = await createOwnGroup(alice, cs)
    const payload = await welcomeFor(aliceGroup, bob, cs)

    const bobGroup = await joinFromWelcome(payload, bob, cs)

    t.equal(bobGroup.groupContext.epoch, 1n, 'should join at epoch one')
    t.equal(
        bobGroup.groupContext.groupId.join(),
        aliceGroup.groupContext.groupId.join(),
        'should be the same group'
    )
    t.equal(
        bobGroup.ratchetTree.filter(n => n?.nodeType === 'leaf').length,
        2,
        'the tree should hold both members'
    )
})

// realistic-demo.AC4.1 -- approving commits an Add

test('commitAdd advances the group and admits the key package',
    async (t) => {
        const alice = await createUser('alice', cs)
        const bob = await createUser('bob', cs)
        const group = await createOwnGroup(alice, cs)

        const result = await commitAdd(group, bob.keyPackage!, cs)

        t.equal(
            group.groupContext.epoch,
            0n,
            'the state it was given is left where it was'
        )
        t.equal(
            result.newState.groupContext.epoch,
            1n,
            'the returned state is one epoch on'
        )
        t.equal(
            result.newState.ratchetTree
                .filter(n => n?.nodeType === 'leaf').length,
            2,
            'and holds both leaves'
        )
    })

test('commitAdd returns a commit and a Welcome the room can carry',
    async (t) => {
        const alice = await createUser('alice', cs)
        const bob = await createUser('bob', cs)
        const group = await createOwnGroup(alice, cs)

        const { commit, welcome, newState } =
            await commitAdd(group, bob.keyPackage!, cs)

        const decodedCommit = decodeMlsMessage(base64ToBytes(commit), 0)
        t.ok(decodedCommit, 'the commit payload should decode')
        t.equal(
            decodedCommit ? decodedCommit[0].wireformat : null,
            'mls_public_message',
            'the commit goes out as a PublicMessage, as the room expects'
        )

        // The Welcome is checked by using it, not by decoding it: a
        // payload that decodes but joins nothing would pass a decode
        // assertion and fail the demo.
        const bobGroup = await joinFromWelcome(welcome, bob, cs)
        t.equal(
            bobGroup.groupContext.epoch,
            newState.groupContext.epoch,
            'the joiner lands at the epoch the committer reached'
        )
        t.equal(
            bobGroup.groupContext.groupId.join(),
            group.groupContext.groupId.join(),
            'and in the same group'
        )
    })

test('joinFromWelcome refuses anything but a Welcome', async (t) => {
    const bob = await createUser('bob', cs)
    const alice = await createUser('alice', cs)
    const group = await createOwnGroup(alice, cs)
    const notAWelcome = (await encryptMessage(group, 'hello', cs)).payload

    try {
        await joinFromWelcome(notAWelcome, bob, cs)
        t.fail('should have thrown on another wireformat')
    } catch (_err) {
        t.ok(true, 'should throw on another wireformat')
    }

    const welcome = await welcomeFor(group, bob, cs)

    try {
        await joinFromWelcome(welcome, { name: 'bob' }, cs)
        t.fail('should have thrown with no key package')
    } catch (_err) {
        t.ok(true, 'should throw when the user has no key package')
    }
})

// realistic-demo.AC5.4 -- removal, and AC5.5 -- being removed

/**
 * Alice's group with Bob in it, and both clients' states. The commit is
 * applied to Alice's state by `commitAdd` itself, and Bob builds his
 * from the Welcome, so the two are at the same epoch without either
 * processing the other's message.
 */
async function pair (cs:CiphersuiteImpl):Promise<{
    alice:DemoUser
    bob:DemoUser
    aliceState:ClientState
    bobState:ClientState
}> {
    const alice = await createUser('alice', cs)
    const bob = await createUser('bob', cs)
    const group = await createOwnGroup(alice, cs)
    const added = await commitAdd(group, bob.keyPackage!, cs)

    return {
        alice,
        bob,
        aliceState: added.newState,
        bobState: await joinFromWelcome(added.welcome, bob, cs)
    }
}

test('commitRemove blanks the leaf it names and moves the epoch on',
    async (t) => {
        const { bob, aliceState } = await pair(cs)
        const leafIndex = leafIndexOf(
            aliceState.ratchetTree,
            identityOf(bob.keyPackage!)
        )

        t.equal(leafIndex, 1, 'bob should be at leaf 1 before the remove')

        const result = await commitRemove(aliceState, leafIndex!, cs)

        t.equal(
            aliceState.groupContext.epoch,
            1n,
            'the state it was given is left where it was'
        )
        t.equal(
            result.newState.groupContext.epoch,
            2n,
            'the returned state is one epoch on'
        )

        const before = membersFromTree(aliceState.ratchetTree)
        const after = membersFromTree(result.newState.ratchetTree)

        t.equal(before.length, 2, 'both were members before')
        t.equal(after.length, 1, 'one is a member after')
        t.equal(
            after[0].leafIndex,
            0,
            'and the leaf index of whoever stayed is unchanged'
        )
        t.equal(
            leafIndexOf(
                result.newState.ratchetTree,
                identityOf(bob.keyPackage!)
            ),
            null,
            'the removed member is no longer in the tree'
        )
    })

test('commitRemove produces a commit the room can carry', async (t) => {
    const { bob, aliceState } = await pair(cs)
    const leafIndex = leafIndexOf(
        aliceState.ratchetTree,
        identityOf(bob.keyPackage!)
    )
    const { commit } = await commitRemove(aliceState, leafIndex!, cs)
    const decoded = decodeMlsMessage(base64ToBytes(commit), 0)

    t.ok(decoded, 'the commit payload should decode')
    t.equal(
        decoded ? decoded[0].wireformat : null,
        'mls_public_message',
        'the commit goes out as a PublicMessage, as the room expects'
    )
})

test('processEntry tells a member they were removed, without failing',
    async (t) => {
        const { bob, aliceState, bobState } = await pair(cs)
        const leafIndex = leafIndexOf(
            aliceState.ratchetTree,
            identityOf(bob.keyPackage!)
        )
        const { commit } = await commitRemove(aliceState, leafIndex!, cs)

        // No throw: being removed is the normal outcome of a commit that
        // processed correctly, not a processing failure.
        const result = await processEntry(bobState, commit, cs)

        t.equal(result.kind, 'newState', 'the commit should process')
        t.equal(
            result.newState.groupActiveState.kind,
            'removedFromGroup',
            'and leave the removed member outside the group'
        )
        t.equal(
            bobState.groupActiveState.kind,
            'active',
            'the state it was given is left where it was'
        )
    })

test('processEntry applies somebody else\'s commit to a member',
    async (t) => {
        const { aliceState, bobState } = await pair(cs)
        const carol = await createUser('carol', cs)
        const added = await commitAdd(aliceState, carol.keyPackage!, cs)

        const result = await processEntry(bobState, added.commit, cs)

        t.equal(result.kind, 'newState', 'the commit should process')
        t.equal(
            result.newState.groupContext.epoch,
            added.newState.groupContext.epoch,
            'the receiver lands at the epoch the committer reached'
        )
        t.deepEqual(
            membersFromTree(result.newState.ratchetTree).map(m => m.name),
            membersFromTree(added.newState.ratchetTree).map(m => m.name),
            'and sees the same members'
        )
        t.equal(
            result.newState.groupActiveState.kind,
            'active',
            'somebody else being added leaves this member in the group'
        )
    })

test('processEntry refuses a payload that is not a handshake message',
    async (t) => {
        const { bob, bobState } = await pair(cs)

        try {
            await processEntry(
                bobState,
                encodeKeyPackageB64(bob.keyPackage!),
                cs
            )
            t.fail('should have thrown on a key package')
        } catch (_err) {
            t.ok(true, 'should throw on a key package')
        }

        try {
            await processEntry(bobState, 'not base64 at all!!', cs)
            t.fail('should have thrown on an undecodable payload')
        } catch (_err) {
            t.ok(true, 'should throw on an undecodable payload')
        }
    })

// "It threw" is not enough to show the wireformat check does anything.
// `processMessage` treats everything that is not an `mls_public_message`
// as a private one, so it reads `.privateMessage` off a key package that
// has none and dies of a TypeError. Deleting the check therefore still
// throws -- from a crash rather than a refusal. What distinguishes them
// is which error arrives, so that is what this asserts.
test('processEntry refuses a wrong wireformat rather than crashing on it',
    async (t) => {
        const { bob, bobState } = await pair(cs)

        try {
            await processEntry(
                bobState,
                encodeKeyPackageB64(bob.keyPackage!),
                cs
            )
            t.fail('should have refused the key package')
        } catch (err) {
            t.ok(err instanceof Error, 'should refuse with an Error')
            t.equal(
                err instanceof TypeError,
                false,
                'and not by reading a field the payload does not have'
            )
            t.ok(
                String((err as Error).message).includes('key_package'),
                'and should say what the payload actually was'
            )
        }
    })
