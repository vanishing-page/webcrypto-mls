/**
 * Audit 2026-09 L1 and L8: anything a peer can put on the wire has to
 * surface as the documented error class -- `CodecError` for bytes that
 * do not decode, `ValidationError` for decoded input the protocol
 * refuses, `CryptoVerificationError` for a failed authenticity check --
 * never `InternalError`, `UsageError`, `TypeError` or a `DOMException`.
 *
 * Each case builds an honest group, then has a test-only peer alter
 * one field of a message the group produced.
 */
import { test } from '@substrate-system/tapzero'
import { createGroup, joinGroup } from '../../src/client-state.js'
import {
    createCommit,
    createGroupInfoWithExternalPubAndRatchetTree,
    joinGroupExternal,
} from '../../src/create-commit.js'
import { createProposal } from '../../src/create-message.js'
import { processMessage } from '../../src/process-messages.js'
import { acceptAll } from '../../src/incoming-message-action.js'
import { emptyPskIndex } from '../../src/psk-index.js'
import type { Credential } from '../../src/credential.js'
import type { CiphersuiteName } from '../../src/crypto/ciphersuite.js'
import { getCiphersuiteFromName } from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import type { CiphersuiteImpl } from '../../src/crypto/ciphersuite.js'
import { generateKeyPackage } from '../../src/key-package.js'
import { defaultLifetime } from '../../src/lifetime.js'
import { defaultCapabilities } from '../../src/default-capabilities.js'
import type { GroupInfo } from '../../src/group-info.js'
import {
    encodeNode,
    encodeRatchetTree,
} from '../../src/ratchet-tree.js'
import type { Node, RatchetTree } from '../../src/ratchet-tree.js'
import { encodeVarLenType } from '../../src/codec/variable-length.js'
import { encodeOptional } from '../../src/codec/optional.js'
import type { Welcome } from '../../src/welcome.js'
import {
    decryptGroupInfo,
    encryptGroupInfo,
    encryptGroupSecrets,
} from '../../src/welcome.js'
import { decryptGroupSecrets } from '../../src/welcome.js'
import { extractWelcomeSecret } from '../../src/group-info.js'
import { makeKeyPackageRef } from '../../src/key-package.js'
import type { MLSMessage } from '../../src/message.js'
import {
    CodecError,
    CryptoVerificationError,
    ValidationError,
} from '../../src/mls-error.js'
import { testClientConfig } from '../helpers/client-config.js'

const SUITE:CiphersuiteName = 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519'

function encodeRawTree (nodes:(Node | undefined)[]):Uint8Array {
    return encodeVarLenType(encodeOptional(encodeNode))(nodes)
}

async function member (name:string, impl:CiphersuiteImpl) {
    const credential:Credential = {
        credentialType: 'basic',
        identity: new TextEncoder().encode(name),
    }
    return generateKeyPackage(
        credential,
        defaultCapabilities(),
        defaultLifetime(),
        [],
        impl,
    )
}

async function aliceAddsBob (impl:CiphersuiteImpl) {
    const alice = await member('alice', impl)
    const bob = await member('bob', impl)
    const aliceGroup = await createGroup(
        new TextEncoder().encode('group1'),
        alice.publicPackage,
        alice.privatePackage,
        [],
        impl,
        testClientConfig,
    )
    const commit = await createCommit(
        { state: aliceGroup, cipherSuite: impl },
        {
            extraProposals: [{
                proposalType: 'add',
                add: { keyPackage: bob.publicPackage },
            }],
            ratchetTreeExtension: true,
        },
    )
    return { alice, bob, aliceGroup: commit.newState, commit }
}

/**
 * The hostile sender re-encrypts the Welcome with an altered GroupInfo.
 * It holds the joiner secret because it built the Welcome in the first
 * place; the test recovers it with the joiner's key to stand in.
 */
async function rewrapWelcome (
    welcome:Welcome,
    bob:Awaited<ReturnType<typeof member>>,
    impl:CiphersuiteImpl,
    alter:(gi:GroupInfo) => GroupInfo,
):Promise<Welcome> {
    const ref = await makeKeyPackageRef(bob.publicPackage, impl.hash)
    const priv = await impl.hpke.importPrivateKey(
        bob.privatePackage.initPrivateKey,
    )
    const secrets = (await decryptGroupSecrets(priv, ref, welcome, impl.hpke))!
    const zeroes = new Uint8Array(impl.kdf.size)
    const gi = (await decryptGroupInfo(
        welcome, secrets.joinerSecret, zeroes, impl,
    ))!
    const welcomeSecret = await extractWelcomeSecret(
        secrets.joinerSecret, zeroes, impl.kdf,
    )
    const encryptedGroupInfo = await encryptGroupInfo(
        alter(gi), welcomeSecret, impl,
    )
    const initKey = await impl.hpke.importPublicKey(
        bob.publicPackage.initKey,
    )
    const { ct, enc } = await encryptGroupSecrets(
        initKey, encryptedGroupInfo, secrets, impl.hpke,
    )
    return {
        cipherSuite: welcome.cipherSuite,
        encryptedGroupInfo,
        secrets: [{
            newMember: ref,
            encryptedGroupSecrets: { kemOutput: enc, ciphertext: ct },
        }],
    }
}

function withTreeExtension (gi:GroupInfo, data:Uint8Array):GroupInfo {
    return {
        ...gi,
        extensions: [
            ...gi.extensions.filter((e) => e.extensionType !== 'ratchet_tree'),
            { extensionType: 'ratchet_tree', extensionData: data },
        ],
    }
}

async function rejectsWith (
    t:any,
    p:Promise<unknown>,
    cls:new (...args:any[]) => Error,
    label:string,
) {
    try {
        await p
        t.ok(false, `${label} should reject`)
    } catch (err) {
        t.ok(err instanceof cls,
            `${label} rejects with ${cls.name}, got ` +
            `${(err as any)?.constructor?.name}`)
    }
}

async function malformedTrees (impl:CiphersuiteImpl):Promise<[
    string, Uint8Array
][]> {
    const { aliceGroup } = await aliceAddsBob(impl)
    const nodes:RatchetTree = aliceGroup.ratchetTree
    return [
        ['an empty node list', encodeRawTree([])],
        ['a node list ending in a blank node',
            encodeRawTree([...nodes.filter((n) => n !== undefined),
                undefined])],
    ]
}

test('joinGroup surfaces CodecError for a malformed ratchet_tree',
    async (t) => {
        const impl = await getCipherSuite(getCiphersuiteFromName(SUITE))
        for (const [label, data] of await malformedTrees(impl)) {
            const { bob, commit } = await aliceAddsBob(impl)
            const welcome = await rewrapWelcome(
                commit.welcome!, bob, impl,
                (gi) => withTreeExtension(gi, data),
            )
            await rejectsWith(t, joinGroup(
                welcome,
                bob.publicPackage,
                bob.privatePackage,
                emptyPskIndex,
                impl,
                undefined,
                undefined,
                testClientConfig,
            ), CodecError, label)
        }
    })

test('joinGroupExternal surfaces CodecError for a malformed ratchet_tree',
    async (t) => {
        const impl = await getCipherSuite(getCiphersuiteFromName(SUITE))
        for (const [label, data] of await malformedTrees(impl)) {
            const { aliceGroup } = await aliceAddsBob(impl)
            const charlie = await member('charlie', impl)
            const gi = await createGroupInfoWithExternalPubAndRatchetTree(
                aliceGroup, [], impl,
            )
            await rejectsWith(t, joinGroupExternal(
                withTreeExtension(gi, data),
                charlie.publicPackage,
                charlie.privatePackage,
                false,
                impl,
                undefined,
                testClientConfig,
            ), CodecError, label)
        }
    })

test('a leaf with a GREASE credential type is a CodecError', async (t) => {
    const impl = await getCipherSuite(getCiphersuiteFromName(SUITE))
    const { aliceGroup } = await aliceAddsBob(impl)
    const charlie = await member('charlie', impl)
    const gi = await createGroupInfoWithExternalPubAndRatchetTree(
        aliceGroup, [], impl,
    )
    const tree = aliceGroup.ratchetTree.map((n):Node | undefined => {
        if (n?.nodeType !== 'leaf') return n
        return {
            nodeType: 'leaf',
            leaf: {
                ...n.leaf,
                credential: {
                    credentialType: '2570',
                    data: new Uint8Array([1, 2, 3]),
                } as unknown as Credential,
            },
        }
    })
    await rejectsWith(t, joinGroupExternal(
        withTreeExtension(gi, encodeRatchetTree(tree)),
        charlie.publicPackage,
        charlie.privatePackage,
        false,
        impl,
        undefined,
        testClientConfig,
    ), CodecError, 'a 0x0A0A credential type')
})

test('a PublicMessage carrying application content is a ValidationError',
    async (t) => {
        const impl = await getCipherSuite(getCiphersuiteFromName(SUITE))
        const { bob, commit, aliceGroup } = await aliceAddsBob(impl)
        const bobGroup = await joinGroup(
            commit.welcome!,
            bob.publicPackage,
            bob.privatePackage,
            emptyPskIndex,
            impl,
            undefined,
            undefined,
            testClientConfig,
        )
        const { message } = await createProposal(
            aliceGroup, true,
            { proposalType: 'remove', remove: { removed: 1 } },
            impl,
        )
        if (message.wireformat !== 'mls_public_message') {
            throw new Error('expected a public message')
        }
        const pm = message.publicMessage
        const hostile:MLSMessage = {
            ...message,
            publicMessage: {
                ...pm,
                content: {
                    ...pm.content,
                    contentType: 'application',
                    applicationData: new Uint8Array([1]),
                } as any,
                auth: { ...pm.auth, contentType: 'application' } as any,
            },
        }
        await rejectsWith(t, processMessage(
            hostile as any, bobGroup, emptyPskIndex, acceptAll, impl,
        ), ValidationError, 'an application PublicMessage')
    })

test('a 31-byte Ed25519 signature key is a ValidationError', async (t) => {
    const impl = await getCipherSuite(getCiphersuiteFromName(SUITE))
    const alice = await member('alice', impl)
    const bob = await member('bob', impl)
    const aliceGroup = await createGroup(
        new TextEncoder().encode('group1'),
        alice.publicPackage,
        alice.privatePackage,
        [],
        impl,
        testClientConfig,
    )
    const short = bob.publicPackage.leafNode.signaturePublicKey.slice(0, 31)
    const keyPackage = {
        ...bob.publicPackage,
        leafNode: {
            ...bob.publicPackage.leafNode,
            signaturePublicKey: short,
        },
    }
    await rejectsWith(t, createCommit(
        { state: aliceGroup, cipherSuite: impl },
        { extraProposals: [{ proposalType: 'add', add: { keyPackage } }] },
    ), ValidationError, 'a 31-byte key')
})

test('a Welcome with a tampered HPKE tag is a CryptoVerificationError',
    async (t) => {
        const impl = await getCipherSuite(getCiphersuiteFromName(SUITE))
        const { bob, commit } = await aliceAddsBob(impl)
        const welcome = commit.welcome!
        const egs = welcome.secrets[0]!.encryptedGroupSecrets
        const ciphertext = egs.ciphertext.slice()
        ciphertext[ciphertext.length - 1]! ^= 0x01
        const tampered:Welcome = {
            ...welcome,
            secrets: [{
                ...welcome.secrets[0]!,
                encryptedGroupSecrets: { ...egs, ciphertext },
            }],
        }
        await rejectsWith(t, joinGroup(
            tampered,
            bob.publicPackage,
            bob.privatePackage,
            emptyPskIndex,
            impl,
            undefined,
            undefined,
            testClientConfig,
        ), CryptoVerificationError, 'a flipped tag byte')
    })
