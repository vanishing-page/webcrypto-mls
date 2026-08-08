import { test } from '@substrate-system/tapzero'
import { createDemoState } from '../../example/demo-state.js'
import {
    initCiphersuite,
    createUser,
    createMLSGroup,
    addUserToGroup,
    sendMessage,
    decryptMessage,
    removeUserFromGroup,
    rotateKeys
} from '../../example/demo-actions.js'
import { bytesToBase64url } from '../../src/index.js'
import { getHpkePublicKey } from '../../src/ratchet-tree.js'
import { leafToNodeIndex, toLeafIndex } from '../../src/treemath.js'

test('demo-actions - full group-messaging flow (extractable keys)',
    async (t) => {
        const state = createDemoState()
        await initCiphersuite(state)
        t.ok(state.ciphersuite.value, 'ciphersuite initialized')

        await createUser(state, 'Alice')
        await createUser(state, 'Bob')
        t.equal(state.users.value.size, 2, 'both users created')
        t.ok(state.users.value.get('Alice')?.keyPackage,
            'Alice has a key package')

        await createMLSGroup(state, 'Alice')
        t.ok(state.groupId.value, 'group created')
        t.ok(state.users.value.get('Alice')?.state,
            'Alice is in the group after creating it')

        await addUserToGroup(state, 'Alice', 'Bob')
        t.ok(state.users.value.get('Bob')?.state,
            'Bob is in the group after being added')
        t.equal(
            state.users.value.get('Alice')?.state?.groupContext.epoch,
            state.users.value.get('Bob')?.state?.groupContext.epoch,
            'Alice and Bob share the same epoch after the add commit'
        )

        await sendMessage(state, 'Alice', 'hello bob')
        t.equal(state.messages.value.length, 1, 'one message sent')
        t.equal(state.decryptedMessages.value.Alice?.[0], 'hello bob',
            'sender already sees their own plaintext')
        t.equal(state.messageQueues.value.Bob?.length, 1,
            'the message is queued for Bob')

        await decryptMessage(state, 'Bob', 0)
        t.equal(state.decryptedMessages.value.Bob?.[0], 'hello bob',
            'Bob decrypts the message sent by Alice')
        t.equal(state.messageQueues.value.Bob?.length, 0,
            'the message is removed from the queue once decrypted')
    }
)

test('demo-actions - createUser with a non-extractable signature keypair',
    async (t) => {
        const state = createDemoState()
        await initCiphersuite(state)

        const signatureKeyPair = await globalThis.crypto.subtle.generateKey(
            { name: 'Ed25519' },
            false, // not extractable
            ['sign', 'verify']
        )

        await createUser(state, 'Alice', { signatureKeyPair })

        const alice = state.users.value.get('Alice')
        t.ok(alice?.keyPackage, 'key package created from the passed-in key')
        t.equal(
            alice?.privateKeys?.signaturePrivateKey,
            signatureKeyPair.privateKey,
            'the stored signature private key is the non-extractable ' +
                'CryptoKey, not raw bytes'
        )
        t.equal(
            (alice?.privateKeys?.signaturePrivateKey as CryptoKey)
                .extractable,
            false,
            'the signature private key is non-extractable'
        )

        // Distinct from a second user's independently generated key.
        const secondKeyPair = await globalThis.crypto.subtle.generateKey(
            { name: 'Ed25519' },
            false,
            ['sign', 'verify']
        )
        await createUser(state, 'Bob', {
            signatureKeyPair: secondKeyPair
        })
        t.notEqual(
            state.users.value.get('Bob')?.privateKeys?.signaturePrivateKey,
            state.users.value.get('Alice')?.privateKeys?.signaturePrivateKey,
            'each member has a distinct non-extractable keypair'
        )

        // A group with two non-extractable-keypair members still works.
        await createMLSGroup(state, 'Alice')
        await addUserToGroup(state, 'Alice', 'Bob')
        t.ok(state.users.value.get('Bob')?.state,
            'Bob (non-extractable key) joins the group successfully')
    }
)

test('demo-actions - removeUserFromGroup', async (t) => {
    const state = createDemoState()
    await initCiphersuite(state)

    await createUser(state, 'Alice')
    await createUser(state, 'Bob')
    await createMLSGroup(state, 'Alice')
    await addUserToGroup(state, 'Alice', 'Bob')

    const epochBeforeRemove =
        state.users.value.get('Alice')?.state?.groupContext.epoch

    await removeUserFromGroup(state, 'Alice', 'Bob')

    t.equal(state.users.value.get('Bob')?.state, undefined,
        'Bob no longer has group state after being removed')
    t.ok(state.users.value.get('Bob')?.keyPackage,
        'Bob keeps his key package after being removed')
    t.ok(
        (state.users.value.get('Alice')?.state?.groupContext.epoch ?? 0n) >
            (epochBeforeRemove ?? 0n),
        'the epoch advances for the remaining member after a remove'
    )
})

test('demo-actions - rotateKeys advances the epoch for every member',
    async (t) => {
        const state = createDemoState()
        await initCiphersuite(state)

        await createUser(state, 'Alice')
        await createUser(state, 'Bob')
        await createMLSGroup(state, 'Alice')
        await addUserToGroup(state, 'Alice', 'Bob')

        const before = state.users.value.get('Alice')!.state!
        const epochBefore = before.groupContext.epoch
        const leafNode = leafToNodeIndex(
            toLeafIndex(before.privatePath.leafIndex)
        )
        const keyBefore = bytesToBase64url(
            getHpkePublicKey(before.ratchetTree[leafNode]!)
        )

        await rotateKeys(state, 'Alice')

        const after = state.users.value.get('Alice')!.state!

        t.ok(after.groupContext.epoch > epochBefore,
            'the rotator epoch advances')
        t.equal(
            state.users.value.get('Bob')?.state?.groupContext.epoch,
            after.groupContext.epoch,
            'the other member processes the commit and shares the epoch'
        )
        t.notEqual(
            bytesToBase64url(
                getHpkePublicKey(after.ratchetTree[leafNode]!)
            ),
            keyBefore,
            'the rotator leaf HPKE key changes'
        )
    }
)

test('demo-actions - rotateKeys regenerates the key package for a ' +
    'member who is not in a group',
async (t) => {
    const state = createDemoState()
    await initCiphersuite(state)
    await createUser(state, 'Alice')
    await createUser(state, 'Bob')

    // Default path: no options, the built-in creator regenerates.
    const bobFirst = state.users.value.get('Bob')?.keyPackage
    const bobInitKeyBefore = bytesToBase64url(bobFirst!.initKey)
    await rotateKeys(state, 'Bob')
    const bobInitKeyAfter = bytesToBase64url(
        state.users.value.get('Bob')!.keyPackage!.initKey
    )
    t.notEqual(bobInitKeyAfter, bobInitKeyBefore,
        'the default creator regenerates the key package')

    // Injected path: the caller supplies the creation function.
    const aliceFirst = state.users.value.get('Alice')?.keyPackage
    const aliceInitKeyBefore = bytesToBase64url(aliceFirst!.initKey)
    let injectedFor:string | null = null

    await rotateKeys(state, 'Alice', {
        createUser: async (name:string) => {
            injectedFor = name
            const signatureKeyPair =
                await globalThis.crypto.subtle.generateKey(
                    { name: 'Ed25519' },
                    false, // not extractable
                    ['sign', 'verify']
                )
            await createUser(state, name, { signatureKeyPair })
        }
    })

    t.equal(injectedFor, 'Alice',
        'the injected creator runs instead of the default')
    const aliceInitKeyAfter = bytesToBase64url(
        state.users.value.get('Alice')!.keyPackage!.initKey
    )
    t.notEqual(aliceInitKeyAfter, aliceInitKeyBefore,
        'the key package is regenerated')
    t.equal(
        (state.users.value.get('Alice')?.privateKeys
            ?.signaturePrivateKey as CryptoKey).extractable,
        false,
        'the regenerated identity keeps a non-extractable key'
    )
}
)
