import { test } from '@substrate-system/tapzero'
import { skipReason } from '../helpers/skip.js'
import {
    createGroup,
    joinGroup,
    nextEpochContext,
} from '../../src/client-state.js'
import type { ClientState } from '../../src/client-state.js'
import {
    createCommit,
    createGroupInfoWithExternalPubAndRatchetTree,
    createGroupInfoWithRatchetTree,
    joinGroupExternal,
} from '../../src/create-commit.js'
import {
    createConfirmationTag,
    createContentCommitSignature,
} from '../../src/framed-content.js'
import {
    protectPublicMessage
} from '../../src/message-protection-public.js'
import { processMessage } from '../../src/process-messages.js'
import { acceptAll } from '../../src/incoming-message-action.js'
import { emptyPskIndex } from '../../src/psk-index.js'
import type {
    CiphersuiteName,
    CiphersuiteImpl,
} from '../../src/crypto/ciphersuite.js'
import { getCiphersuiteFromName } from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import type { KemAlgorithm } from '../../src/crypto/kem.js'
import { deriveSecret } from '../../src/crypto/kdf.js'
import {
    generateKeyPackage,
    makeKeyPackageRef,
    signKeyPackage,
} from '../../src/key-package.js'
import type {
    KeyPackage,
    PrivateKeyPackage,
} from '../../src/key-package.js'
import { initializeEpoch } from '../../src/key-schedule.js'
import { signLeafNodeKeyPackage } from '../../src/leaf-node.js'
import { addLeafNode } from '../../src/ratchet-tree.js'
import { treeHashRoot } from '../../src/tree-hash.js'
import { leafToNodeIndex, toLeafIndex } from '../../src/treemath.js'
import { encryptGroupInfo, encryptGroupSecrets } from '../../src/welcome.js'
import type { Welcome } from '../../src/welcome.js'
import { defaultLifetime } from '../../src/lifetime.js'
import { defaultCapabilities } from '../../src/default-capabilities.js'
import { ValidationError } from '../../src/mls-error.js'
import { constantTimeEqual } from '../../src/util/constant-time-compare.js'
import { testCiphersuites } from '../helpers/suite-filter.js'
import { testClientConfig } from '../helpers/client-config.js'
import type { MLSMessage } from '../../src/message.js'

// Audit 2026-10-24 F3, from the other side: a committer whose own
// createCommit refuses an unusable leaf encryption key can still build
// the commit, the Welcome or the GroupInfo by hand. Every member and
// joiner has to refuse the leaf itself, as a ValidationError, before it
// enters their tree.

// u = 0, the canonical encoding and the same point with the top bit set,
// which RFC 7748 section 5 masks before decoding
const X25519_ZERO = new Uint8Array(32)
const X25519_ZERO_TOP_BIT = new Uint8Array(32)
X25519_ZERO_TOP_BIT[31] = 0x80
const X448_ZERO = new Uint8Array(56)

function lowOrderKeys (kem:KemAlgorithm):Uint8Array[] {
    if (kem === 'DHKEM-X25519-HKDF-SHA256') {
        return [X25519_ZERO, X25519_ZERO_TOP_BIT]
    }
    if (kem === 'DHKEM-X448-HKDF-SHA512') return [X448_ZERO]
    return []
}

// a one-byte key imports under no KEM
function unusableKeys (cs:CiphersuiteName):Uint8Array[] {
    const kem = getCiphersuiteFromName(cs).hpke.kem
    return [new Uint8Array([1]), ...lowOrderKeys(kem)]
}

for (const cs of testCiphersuites()) {
    // The refusals below assert only the error class, and a forgery that
    // has drifted out of step with createCommit is refused with the same
    // class (a tree hash or confirmation tag mismatch). So the forging
    // helpers are checked here with honest keys: whatever they produce
    // must be accepted, which leaves the key as the only reason a
    // refusal case can fail.
    test('the forged commit, Welcome and UpdatePath are accepted when ' +
        'every key is usable - ' + cs, async (t) => {
        const impl = await implOrSkip(t, cs)
        if (impl === undefined) return
        const { alice, bob } = await aliceAndBob(impl)
        const mallory = await member('mallory', impl)
        const carol = await member('carol', impl)

        const { commit, welcome } = await forgeAddCommit(alice,
            [mallory.publicPackage, carol.publicPackage], impl)
        const received = await receive(bob, commit, impl)
        t.equal(received.groupContext.epoch, alice.groupContext.epoch + 1n,
            'the receiver processes a forged Add of honest key packages')
        const joined = await joinGroup(welcome, carol.publicPackage,
            carol.privatePackage, emptyPskIndex, impl, undefined,
            undefined, testClientConfig)
        t.equal(joined.groupContext.epoch, received.groupContext.epoch,
            'a forged Welcome of honest key packages joins')

        const fresh = await impl.hpke.exportPublicKey(
            (await impl.hpke.generateKeyPair()).publicKey)
        const { commit: pathCommit } = await createCommit(
            { state: bob, cipherSuite: withCommitLeafKey(impl, fresh) },
            { wireAsPublicMessage: true },
        )
        const followed = await receive(alice, pathCommit, impl)
        const node = followed.ratchetTree[leafToNodeIndex(
            toLeafIndex(bob.privatePath.leafIndex))]
        t.ok(node?.nodeType === 'leaf' &&
            constantTimeEqual(node.leaf.hpkePublicKey, fresh),
        'the receiver accepts an UpdatePath leaf carrying the swapped key')
    })

    test('a commit whose Add carries an unusable leaf key is refused by ' +
        'its receiver - ' + cs, async (t) => {
        const impl = await implOrSkip(t, cs)
        if (impl === undefined) return
        const { alice, bob } = await aliceAndBob(impl)

        for (const key of unusableKeys(cs)) {
            const mallory = await member('mallory', impl)
            const kp = await withLeafKey(mallory.publicPackage,
                mallory.privatePackage, key, impl)
            const { commit } = await forgeAddCommit(alice, [kp], impl)
            await rejects(t, () => receive(bob, commit, impl), 'Add')
        }

        await honestCommitIsProcessed(t, alice, bob, impl)
    })

    test('a commit whose UpdatePath leaf carries an unusable key is ' +
        'refused by its receiver - ' + cs, async (t) => {
        const impl = await implOrSkip(t, cs)
        if (impl === undefined) return
        const { alice, bob } = await aliceAndBob(impl)

        for (const key of unusableKeys(cs)) {
            // an empty commit always carries a path
            const { commit } = await createCommit(
                { state: bob, cipherSuite: withCommitLeafKey(impl, key) },
                { wireAsPublicMessage: true },
            )
            await rejects(t, () => receive(alice, commit, impl),
                'UpdatePath leaf')
        }

        await honestCommitIsProcessed(t, bob, alice, impl)
    })

    test('a Welcome whose tree carries an unusable leaf key is refused ' +
        'and leaves the init key intact - ' + cs, async (t) => {
        const impl = await implOrSkip(t, cs)
        if (impl === undefined) return
        const { alice } = await aliceAndBob(impl)
        const carol = await member('carol', impl)

        for (const key of unusableKeys(cs)) {
            const mallory = await member('mallory', impl)
            const kp = await withLeafKey(mallory.publicPackage,
                mallory.privatePackage, key, impl)
            const { welcome } = await forgeAddCommit(alice,
                [kp, carol.publicPackage], impl)
            const initPrivateKey = carol.privatePackage.initPrivateKey.slice()
            await rejects(t, () => joinGroup(welcome, carol.publicPackage,
                { ...carol.privatePackage, initPrivateKey },
                emptyPskIndex, impl, undefined, undefined,
                testClientConfig), 'Welcome tree')
            t.ok(initPrivateKey.some((b) => b !== 0),
                'the init private key is still non-zero')
        }

        // the same key package joins an honest Welcome
        const add = await createCommit(
            { state: alice, cipherSuite: impl },
            {
                extraProposals: [{
                    proposalType: 'add',
                    add: { keyPackage: carol.publicPackage },
                }],
                ratchetTreeExtension: true,
            },
        )
        const joined = await joinGroup(add.welcome!, carol.publicPackage,
            carol.privatePackage, emptyPskIndex, impl, undefined,
            undefined, testClientConfig)
        t.equal(joined.groupContext.epoch, add.newState.groupContext.epoch,
            'an honest Welcome still joins')
    })

    test('an external join against a GroupInfo whose tree carries an ' +
        'unusable leaf key is refused - ' + cs, async (t) => {
        const impl = await implOrSkip(t, cs)
        if (impl === undefined) return
        const { alice } = await aliceAndBob(impl)
        const dave = await member('dave', impl)

        for (const key of unusableKeys(cs)) {
            const mallory = await member('mallory', impl)
            const kp = await withLeafKey(mallory.publicPackage,
                mallory.privatePackage, key, impl)
            const [tree] = addLeafNode(alice.ratchetTree, kp.leafNode)
            const signer:ClientState = {
                ...alice,
                ratchetTree: tree,
                groupContext: {
                    ...alice.groupContext,
                    treeHash: await treeHashRoot(tree, impl.hash),
                },
            }
            const groupInfo =
                await createGroupInfoWithExternalPubAndRatchetTree(
                    signer, [], impl)
            await rejects(t, () => joinGroupExternal(groupInfo,
                dave.publicPackage, dave.privatePackage, false, impl,
                undefined, testClientConfig), 'GroupInfo tree')
        }

        // the same key package joins against the honest GroupInfo, and
        // the group follows its commit
        const groupInfo =
            await createGroupInfoWithExternalPubAndRatchetTree(
                alice, [], impl)
        const joined = await joinGroupExternal(groupInfo, dave.publicPackage,
            dave.privatePackage, false, impl, undefined, testClientConfig)
        const followed = await receive(alice, {
            wireformat: 'mls_public_message',
            version: 'mls10',
            publicMessage: joined.publicMessage,
        }, impl)
        t.equal(followed.groupContext.epoch,
            joined.newState.groupContext.epoch,
            'an honest external join still succeeds')
    })
}

/**
 * The ciphersuite's implementation, or undefined after reporting a skip
 * when the environment lacks one of its primitives. Only setup runs under
 * the skip, so a provider error inside a case is still a failure.
 */
async function implOrSkip (
    t:any,
    cs:CiphersuiteName,
):Promise<CiphersuiteImpl | undefined> {
    try {
        const impl = await getCipherSuite(getCiphersuiteFromName(cs))
        await member('probe', impl)
        return impl
    } catch (error:any) {
        if (error?.name === 'NotSupportedError' ||
            error?.name === 'DependencyError') {
            t.comment(`Skipping ${cs}: ${skipReason(error)}`)
            return undefined
        }
        throw error
    }
}

async function rejects (
    t:any,
    fn:() => Promise<unknown>,
    what:string,
):Promise<void> {
    try {
        await fn()
        t.fail(what + ' with an unusable key should be rejected')
    } catch (error) {
        t.ok(error instanceof ValidationError,
            what + ' with an unusable key throws ValidationError')
    }
}

async function member (name:string, impl:CiphersuiteImpl) {
    return generateKeyPackage(
        { credentialType: 'basic', identity: new TextEncoder().encode(name) },
        defaultCapabilities(),
        defaultLifetime(),
        [],
        impl,
    )
}

/**
 * Re-mint a KeyPackage around a chosen leaf encryption key, signed by its
 * own owner, so it fails on the key and not on a signature.
 */
async function withLeafKey (
    base:KeyPackage,
    priv:PrivateKeyPackage,
    hpkePublicKey:Uint8Array,
    impl:CiphersuiteImpl,
):Promise<KeyPackage> {
    const { signature: _signature, ...tbs } = base.leafNode
    const leafNode = await signLeafNodeKeyPackage(
        {
            ...tbs,
            hpkePublicKey,
            info: { leafNodeSource: 'key_package' },
        },
        priv.signaturePrivateKey,
        impl.signature,
    )
    return signKeyPackage(
        {
            version: base.version,
            cipherSuite: base.cipherSuite,
            initKey: base.initKey,
            leafNode,
            extensions: base.extensions,
        },
        priv.signaturePrivateKey,
        impl.signature,
    )
}

/**
 * An Add-only commit of `keyPackages` from `state`, and its Welcome, built
 * the way createCommit built them before it validated a leaf's encryption
 * key: the tree, the epoch and every signature and tag are consistent, so
 * the only thing wrong with them is the key.
 */
async function forgeAddCommit (
    state:ClientState,
    keyPackages:KeyPackage[],
    impl:CiphersuiteImpl,
):Promise<{ commit:MLSMessage; welcome:Welcome }> {
    let tree = state.ratchetTree
    for (const kp of keyPackages) {
        [tree] = addLeafNode(tree, kp.leafNode)
    }

    const { signature, framedContent } = await createContentCommitSignature(
        state.groupContext,
        'mls_public_message',
        {
            proposals: keyPackages.map((keyPackage) => ({
                proposalOrRefType: 'proposal' as const,
                proposal: { proposalType: 'add', add: { keyPackage } },
            })),
            path: undefined,
        },
        { senderType: 'member', leafIndex: state.privatePath.leafIndex },
        new Uint8Array(),
        state.signaturePrivateKey,
        impl.signature,
    )
    const groupContext = await nextEpochContext(
        state.groupContext,
        'mls_public_message',
        framedContent,
        signature,
        await treeHashRoot(tree, impl.hash),
        state.confirmationTag,
        impl.hash,
    )
    // no path and no PSKs: both secrets are all-zero
    const epoch = await initializeEpoch(
        state.keySchedule.initSecret,
        new Uint8Array(impl.kdf.size),
        groupContext,
        new Uint8Array(impl.kdf.size),
        impl.kdf,
    )
    const confirmationTag = await createConfirmationTag(
        epoch.keySchedule.confirmationKey,
        groupContext.confirmedTranscriptHash,
        impl.hash,
    )
    const publicMessage = await protectPublicMessage(
        state.keySchedule.membershipKey,
        state.groupContext,
        {
            wireformat: 'mls_public_message',
            content: framedContent,
            auth: { contentType: 'commit', signature, confirmationTag },
        },
        impl,
    )

    const groupInfo = await createGroupInfoWithRatchetTree(groupContext,
        confirmationTag, state, tree, [], impl)
    const encryptedGroupInfo = await encryptGroupInfo(groupInfo,
        epoch.welcomeSecret, impl)
    const secrets = await Promise.all(keyPackages.map(async (kp) => {
        const egs = await encryptGroupSecrets(
            await impl.hpke.importPublicKey(kp.initKey),
            encryptedGroupInfo,
            {
                joinerSecret: epoch.joinerSecret,
                pathSecret: undefined,
                psks: [],
            },
            impl.hpke,
        )
        return {
            newMember: await makeKeyPackageRef(kp, impl.hash),
            encryptedGroupSecrets: { kemOutput: egs.enc, ciphertext: egs.ct },
        }
    }))

    return {
        commit: {
            wireformat: 'mls_public_message',
            version: 'mls10',
            publicMessage,
        },
        welcome: {
            cipherSuite: groupContext.cipherSuite,
            secrets,
            encryptedGroupInfo,
        },
    }
}

/**
 * A provider that hands createCommit `key` in place of the committer's new
 * leaf encryption key. The leaf key is the one exported from the key pair
 * derived as "node" from a fresh random path secret, so the swap happens
 * before the leaf is signed and hashed into the tree, and the commit stays
 * consistent apart from the key.
 */
function withCommitLeafKey (
    impl:CiphersuiteImpl,
    key:Uint8Array,
):CiphersuiteImpl {
    const fresh:Uint8Array[] = []
    return {
        ...impl,
        rng: {
            randomBytes (n:number) {
                const bytes = impl.rng.randomBytes(n)
                if (n === impl.kdf.size) fresh.push(bytes.slice())
                return bytes
            },
        },
        hpke: {
            ...impl.hpke,
            async exportPublicKey (k) {
                const exported = await impl.hpke.exportPublicKey(k)
                for (const secret of fresh) {
                    const pair = await impl.hpke.deriveKeyPair(
                        await deriveSecret(secret, 'node', impl.kdf))
                    const leaf = await impl.hpke.exportPublicKey(
                        pair.publicKey)
                    if (constantTimeEqual(leaf, exported)) return key
                }
                return exported
            },
        },
    }
}

async function receive (
    state:ClientState,
    msg:MLSMessage,
    impl:CiphersuiteImpl,
):Promise<ClientState> {
    if (msg.wireformat !== 'mls_public_message' &&
        msg.wireformat !== 'mls_private_message') {
        throw new Error('expected a framed message')
    }
    const result = await processMessage(msg, state, emptyPskIndex,
        acceptAll, impl)
    return result.newState
}

async function aliceAndBob (impl:CiphersuiteImpl) {
    const a = await member('alice', impl)
    const solo = await createGroup(new TextEncoder().encode('group'),
        a.publicPackage, a.privatePackage, [], impl, testClientConfig)
    const b = await member('bob', impl)
    const add = await createCommit(
        { state: solo, cipherSuite: impl },
        {
            extraProposals: [{
                proposalType: 'add',
                add: { keyPackage: b.publicPackage },
            }],
            ratchetTreeExtension: true,
        },
    )
    const bob = await joinGroup(add.welcome!, b.publicPackage,
        b.privatePackage, emptyPskIndex, impl, undefined, undefined,
        testClientConfig)
    return { alice: add.newState, bob }
}

/**
 * The receiver that refused the forged commit still follows an honest one
 * from the same epoch: an Add of a normal key package, then a path commit
 * back from the receiver.
 */
async function honestCommitIsProcessed (
    t:any,
    committer:ClientState,
    receiver:ClientState,
    impl:CiphersuiteImpl,
):Promise<void> {
    const carol = await member('carol', impl)
    const add = await createCommit(
        { state: committer, cipherSuite: impl },
        {
            extraProposals: [{
                proposalType: 'add',
                add: { keyPackage: carol.publicPackage },
            }],
        },
    )
    const received = await receive(receiver, add.commit, impl)
    const back = await createCommit(
        { state: received, cipherSuite: impl },
        {},
    )
    const followed = await receive(add.newState, back.commit, impl)
    t.equal(followed.groupContext.epoch, back.newState.groupContext.epoch,
        'the receiver still processes an honest commit from the same epoch')
}
