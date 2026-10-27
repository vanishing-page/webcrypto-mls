import { test } from '@substrate-system/tapzero'
import { skipReason } from '../helpers/skip.js'
import { createGroup, joinGroup } from '../../src/client-state.js'
import type { ClientState } from '../../src/client-state.js'
import type { ClientConfig } from '../../src/client-config.js'
import type { Capabilities } from '../../src/capabilities.js'
import type { Credential } from '../../src/credential.js'
import {
    createCommit,
    createGroupInfoWithRatchetTree,
} from '../../src/create-commit.js'
import { createConfirmationTag } from '../../src/framed-content.js'
import { emptyPskIndex } from '../../src/psk-index.js'
import type {
    CiphersuiteImpl,
    CiphersuiteName,
} from '../../src/crypto/ciphersuite.js'
import { getCiphersuiteFromName } from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import { signWithLabel } from '../../src/crypto/signature.js'
import {
    generateKeyPackage,
    makeKeyPackageRef,
} from '../../src/key-package.js'
import type {
    KeyPackage,
    PrivateKeyPackage,
} from '../../src/key-package.js'
import { initializeEpoch } from '../../src/key-schedule.js'
import { encodeLeafNodeTBS } from '../../src/leaf-node.js'
import type { LeafNode, LeafNodeUpdate } from '../../src/leaf-node.js'
import { addLeafNode } from '../../src/ratchet-tree.js'
import type { RatchetTree } from '../../src/ratchet-tree.js'
import { treeHashRoot } from '../../src/tree-hash.js'
import { leafToNodeIndex, toLeafIndex } from '../../src/treemath.js'
import { encryptGroupInfo, encryptGroupSecrets } from '../../src/welcome.js'
import type { Welcome } from '../../src/welcome.js'
import { defaultLifetime } from '../../src/lifetime.js'
import { defaultCapabilities } from '../../src/default-capabilities.js'
import {
    CryptoVerificationError,
    ValidationError,
} from '../../src/mls-error.js'
import { sameSignerKeyPackage } from '../helpers/same-signer-key-package.js'
import { withLeafKey } from '../helpers/forge-commit.js'
import { testCiphersuites } from '../helpers/suite-filter.js'
import { testClientConfig } from '../helpers/client-config.js'

// Ported from upstream ts-mls's join-time ratchet-tree rejections: a
// joiner refuses a Welcome whose tree breaks one rule, even though the
// GroupInfo around it is signed by a member and every hash and tag in it
// agrees with the tree. `forgeWelcome` recomputes all of that around any
// tree it is handed, and the first test below holds it to an honest tree,
// so the mutation in each later test is the only reason it can be
// refused.

type Errorish = typeof ValidationError | typeof CryptoVerificationError

for (const cs of testCiphersuites()) {
    test('a forged Welcome around an honest tree with every leaf node ' +
        'source joins - ' + cs, async (t) => {
        const fx = await fixtureOrSkip(t, cs)
        if (fx === undefined) return
        const tree = await honestTree(fx)

        t.deepEqual(
            [0, 1, 2, 3].map((i) => leafAt(tree, i).leafNodeSource),
            ['commit', 'key_package', 'update', 'key_package'],
            'the honest tree holds a leaf of every source')
        t.equal(tree[1]?.nodeType, 'parent',
            'the honest tree holds a non-blank parent node')

        const joined = await join(fx, await forgeWelcome(fx, tree))
        t.equal(joined.groupContext.epoch,
            fx.alice.groupContext.epoch + 1n,
            'the joiner accepts the forged Welcome')
    })

    test('a Welcome whose tree has a tampered parent hash is refused - ' +
        cs, async (t) => {
        const fx = await fixtureOrSkip(t, cs)
        if (fx === undefined) return
        const tree = await honestTree(fx)
        const parent = tree[1]
        if (parent?.nodeType !== 'parent') throw new Error('no parent')

        tree[1] = {
            nodeType: 'parent',
            parent: {
                ...parent.parent,
                parentHash: new Uint8Array(fx.impl.kdf.size).fill(7),
            },
        }

        await rejects(t, CryptoVerificationError,
            () => join(fx, forgeWelcome(fx, tree)), 'a tampered parent hash')
    })

    test('a Welcome whose GroupInfo tree hash does not match its tree ' +
        'is refused - ' + cs, async (t) => {
        const fx = await fixtureOrSkip(t, cs)
        if (fx === undefined) return
        const tree = await honestTree(fx)

        await rejects(t, ValidationError, () => join(fx, forgeWelcome(fx,
            tree, new Uint8Array(fx.impl.kdf.size).fill(7))),
        'a mismatched tree hash')
    })

    test('a Welcome whose tree repeats an HPKE key leaf to leaf is ' +
        'refused - ' + cs, async (t) => {
        const fx = await fixtureOrSkip(t, cs)
        if (fx === undefined) return
        const kp = await withLeafKey(fx.mallory.publicPackage,
            fx.mallory.privatePackage, leafAt(fx.alice.ratchetTree, 0)
                .hpkePublicKey, fx.impl)

        await rejects(t, ValidationError, async () => join(fx,
            forgeWelcome(fx, await honestTree(fx, kp.leafNode))),
        'a leaf HPKE key repeated on another leaf')
    })

    test('a Welcome whose tree repeats a parent HPKE key on a leaf is ' +
        'refused - ' + cs, async (t) => {
        const fx = await fixtureOrSkip(t, cs)
        if (fx === undefined) return
        const parent = fx.alice.ratchetTree[1]
        if (parent?.nodeType !== 'parent') throw new Error('no parent')
        const kp = await withLeafKey(fx.mallory.publicPackage,
            fx.mallory.privatePackage, parent.parent.hpkePublicKey, fx.impl)

        await rejects(t, ValidationError, async () => join(fx,
            forgeWelcome(fx, await honestTree(fx, kp.leafNode))),
        'a parent HPKE key repeated on a leaf')
    })

    test('a Welcome whose tree repeats a signature key is refused - ' +
        cs, async (t) => {
        const fx = await fixtureOrSkip(t, cs)
        if (fx === undefined) return
        // mallory's leaf, under bob's signature key pair
        const kp = await sameSignerKeyPackage(
            fx.mallory.publicPackage.leafNode.credential,
            fx.bob.publicPackage.leafNode.signaturePublicKey,
            fx.bob.privatePackage.signaturePrivateKey,
            fx.impl)

        await rejects(t, ValidationError, async () => join(fx,
            forgeWelcome(fx, await honestTree(fx,
                kp.publicPackage.leafNode))),
        'a repeated signature key')
    })

    test('a Welcome whose tree has a leaf with a bad signature is ' +
        'refused, for every leaf node source - ' + cs, async (t) => {
        const fx = await fixtureOrSkip(t, cs)
        if (fx === undefined) return

        for (const index of [0, 2, 3]) {
            const tree = await honestTree(fx)
            const leaf = leafAt(tree, index)
            const signature = leaf.signature.slice()
            signature[signature.length - 1]! ^= 0x01
            tree[leafToNodeIndex(toLeafIndex(index))] = {
                nodeType: 'leaf',
                leaf: { ...leaf, signature },
            }

            await rejects(t, CryptoVerificationError,
                () => join(fx, forgeWelcome(fx, tree)),
                `a bad ${leaf.leafNodeSource} leaf signature`)
        }
    })

    test('a joiner whose AuthenticationService rejects a member ' +
        'credential refuses the Welcome - ' + cs, async (t) => {
        const fx = await fixtureOrSkip(t, cs)
        if (fx === undefined) return
        const rejectsMallory:ClientConfig = {
            ...testClientConfig,
            authService: {
                async validateCredential (credential) {
                    return !(credential.credentialType === 'basic' &&
                        new TextDecoder().decode(credential.identity) ===
                        'mallory')
                },
            },
        }

        await rejects(t, ValidationError, async () => join(fx,
            forgeWelcome(fx, await honestTree(fx)), rejectsMallory),
        'a credential the AuthenticationService rejects')
    })

    test('a Welcome whose tree holds a leaf whose own capabilities omit ' +
        'its credential type is refused - ' + cs, async (t) => {
        const fx = await fixtureOrSkip(t, cs)
        if (fx === undefined) return
        // RFC 9420 7.3, one direction: every member, the leaf itself
        // included, supports this leaf's credential type. Only the leaf
        // itself fails it here; it supports every type in use by others.
        const kp = await member('mallory', fx.impl, x509Credential,
            withoutCredential(defaultCapabilities(), 'x509'))

        await rejects(t, ValidationError, async () => join(fx,
            forgeWelcome(fx, await honestTree(fx,
                kp.publicPackage.leafNode))),
        'a leaf no member can check the credential of')
    })

    test('a Welcome whose tree holds a leaf that omits a credential ' +
        'type in use by another member is refused - ' + cs, async (t) => {
        const fx = await fixtureOrSkip(t, cs)
        if (fx === undefined) return
        // The other direction: a leaf supports every credential type in
        // use. The two directions are one pairwise rule, so no tree breaks
        // this one alone; eve sits before the x509 member, so eve's leaf
        // is the one validated first, and this is the direction it fails.
        const eve = await member('eve', fx.impl, undefined,
            withoutCredential(defaultCapabilities(), 'x509'))
        const x509 = await member('mallory', fx.impl, x509Credential)

        await rejects(t, ValidationError, async () => join(fx,
            forgeWelcome(fx, await honestTree(fx,
                eve.publicPackage.leafNode, x509.publicPackage.leafNode))),
        'a leaf that cannot check a credential type in use')
    })

    test('a joiner\'s AuthenticationService is shown each replaced ' +
        'leaf\'s credential as priorCredential - ' + cs, async (t) => {
        const fx = await fixtureOrSkip(t, cs)
        if (fx === undefined) return
        // At join an update- or commit-sourced leaf is checked with the
        // credential at its own index as priorCredential; a service that
        // refuses any prior credential can only see one through that.
        const refusesPrior:ClientConfig = {
            ...testClientConfig,
            authService: {
                async validateCredential (_credential, _key, prior) {
                    return prior === undefined
                },
            },
        }

        await rejects(t, ValidationError, async () => join(fx,
            forgeWelcome(fx, await honestTree(fx)), refusesPrior),
        'a prior credential the AuthenticationService refuses')
    })

    test('a Welcome whose tree holds an unusable leaf encryption key is ' +
        'refused - ' + cs, async (t) => {
        const fx = await fixtureOrSkip(t, cs)
        if (fx === undefined) return

        for (const key of unusableKeys(cs)) {
            const kp = await withLeafKey(fx.mallory.publicPackage,
                fx.mallory.privatePackage, key, fx.impl)

            await rejects(t, ValidationError, async () => join(fx,
                forgeWelcome(fx, await honestTree(fx, kp.leafNode))),
            `an unusable ${key.length}-byte leaf encryption key`)
        }
    })

    test('a Welcome whose tree holds a small-order signature key is ' +
        'refused - ' + cs, async (t) => {
        const fx = await fixtureOrSkip(t, cs)
        if (fx === undefined) return
        const keys = smallOrderKeys(cs)
        if (keys.length === 0) {
            t.ok(true, 'the signature scheme has no small-order keys')
            return
        }

        for (const key of keys) {
            // R = identity, S = 0: verifies under a small-order key, so
            // the key has to be refused before the signature is checked
            const signature = new Uint8Array(key.length * 2)
            signature[0] = 1
            const leaf:LeafNode = {
                ...fx.mallory.publicPackage.leafNode,
                signaturePublicKey: key,
                signature,
            }

            await rejects(t, ValidationError, async () => join(fx,
                forgeWelcome(fx, await honestTree(fx, leaf))),
            'a small-order signature key')
        }
    })

    test('a Welcome whose tree passes the parent-hash chain but breaks ' +
        'the resolution criterion is refused - ' + cs, async (t) => {
        const fx = await fixtureOrSkip(t, cs)
        if (fx === undefined) return
        // RFC 9420 7.9.2: node 1's hash chain comes from alice's leaf, so
        // the unmerged leaves under alice's side must be the resolution of
        // that side minus alice. Listing alice herself breaks only that;
        // the sibling hash the chain covers is bob's side, untouched.
        const tree = await honestTree(fx)
        const parent = tree[1]
        if (parent?.nodeType !== 'parent') throw new Error('no parent')
        tree[1] = {
            nodeType: 'parent',
            parent: { ...parent.parent, unmergedLeaves: [0] },
        }

        await rejects(t, CryptoVerificationError,
            () => join(fx, forgeWelcome(fx, tree)),
            'an unmerged leaf outside the resolution')
    })

    test('a Welcome whose tree lists an unmerged leaf outside its ' +
        'parent\'s subtree is refused - ' + cs, async (t) => {
        const fx = await fixtureOrSkip(t, cs)
        if (fx === undefined) return
        // Dave (leaf 2) is not under node 1. Node 1's chain covers bob's
        // side, which removing dave leaves unchanged, and alice's side
        // holds no unmerged leaf, so the parent hashes still verify.
        const tree = await honestTree(fx)
        const parent = tree[1]
        if (parent?.nodeType !== 'parent') throw new Error('no parent')
        tree[1] = {
            nodeType: 'parent',
            parent: { ...parent.parent, unmergedLeaves: [2] },
        }

        await rejects(t, ValidationError,
            () => join(fx, forgeWelcome(fx, tree)),
            'an unmerged leaf that is not a descendant')
    })
}

const x509Credential:Credential = {
    credentialType: 'x509',
    certificates: [new TextEncoder().encode('not a certificate')],
}

function withoutCredential (
    caps:Capabilities,
    type:Credential['credentialType'],
):Capabilities {
    return { ...caps, credentials: caps.credentials.filter((c) => c !== type) }
}

// a one-byte key imports under no KEM; u = 0 is low order
function unusableKeys (cs:CiphersuiteName):Uint8Array[] {
    const kem = getCiphersuiteFromName(cs).hpke.kem
    const lowOrder = kem === 'DHKEM-X25519-HKDF-SHA256' ?
        [new Uint8Array(32)] :
        kem === 'DHKEM-X448-HKDF-SHA512' ? [new Uint8Array(56)] : []
    return [new Uint8Array([1]), ...lowOrder]
}

// the identity point of each Edwards curve
function smallOrderKeys (cs:CiphersuiteName):Uint8Array[] {
    const alg = getCiphersuiteFromName(cs).signature
    const identity = alg === 'Ed25519' ?
        new Uint8Array(32) :
        alg === 'Ed448' ? new Uint8Array(57) : undefined
    if (identity === undefined) return []
    identity[0] = 1
    return [identity]
}

interface Member {
    publicPackage:KeyPackage;
    privatePackage:PrivateKeyPackage;
}

interface Fixture {
    impl:CiphersuiteImpl;
    // alice after an Add of bob and an empty commit of her own: her leaf
    // is commit-sourced and the parent above it is non-blank
    alice:ClientState;
    bob:Member;
    dave:Member;
    mallory:Member;
    carol:Member;
}

/**
 * The fixture, or undefined after reporting a skip when the environment
 * lacks one of the ciphersuite's primitives. Only setup runs under the
 * skip, so a provider error inside a case is still a failure.
 */
async function fixtureOrSkip (
    t:any,
    cs:CiphersuiteName,
):Promise<Fixture | undefined> {
    let impl:CiphersuiteImpl
    let a:Member
    try {
        impl = await getCipherSuite(getCiphersuiteFromName(cs))
        a = await member('alice', impl)
    } catch (error:any) {
        if (error?.name === 'NotSupportedError' ||
            error?.name === 'DependencyError') {
            t.comment(`Skipping ${cs}: ${skipReason(error)}`)
            return undefined
        }
        throw error
    }

    const bob = await member('bob', impl)
    const solo = await createGroup(new TextEncoder().encode('group'),
        a.publicPackage, a.privatePackage, [], impl, testClientConfig)
    const added = await createCommit(
        { state: solo, cipherSuite: impl },
        {
            extraProposals: [{
                proposalType: 'add',
                add: { keyPackage: bob.publicPackage },
            }],
        },
    )
    const updated = await createCommit(
        { state: added.newState, cipherSuite: impl },
        {},
    )

    return {
        impl,
        alice: updated.newState,
        bob,
        dave: await member('dave', impl),
        mallory: await member('mallory', impl),
        carol: await member('carol', impl),
    }
}

async function member (
    name:string,
    impl:CiphersuiteImpl,
    credential:Credential = {
        credentialType: 'basic',
        identity: new TextEncoder().encode(name),
    },
    capabilities:Capabilities = defaultCapabilities(),
):Promise<Member> {
    return generateKeyPackage(
        credential,
        capabilities,
        defaultLifetime(),
        [],
        impl,
    )
}

function leafAt (tree:RatchetTree, index:number):LeafNode {
    const node = tree[leafToNodeIndex(toLeafIndex(index))]
    if (node?.nodeType !== 'leaf') throw new Error(`no leaf at ${index}`)
    return node.leaf
}

/**
 * Alice's tree with an update-sourced leaf for dave at leaf 2 and
 * `malloryLeaf` at leaf 3: a leaf of every source, and the parent above
 * alice and bob still anchored by alice's commit. Dave's leaf goes in a
 * new slot rather than replacing bob's, because the parent hash alice's
 * commit wrote covers bob's subtree. `extra` leaves follow mallory's. A
 * fresh copy each call, so a case may write into it.
 */
async function honestTree (
    fx:Fixture,
    malloryLeaf:LeafNode = fx.mallory.publicPackage.leafNode,
    ...extra:LeafNode[]
):Promise<RatchetTree> {
    let [tree] = addLeafNode(fx.alice.ratchetTree, await updateLeaf(fx, 2))
    for (const leaf of [malloryLeaf, ...extra]) [tree] = addLeafNode(tree, leaf)
    return tree
}

/**
 * Dave's leaf re-signed as an update-sourced leaf at `leafIndex` of
 * alice's group, with a fresh encryption key.
 */
async function updateLeaf (
    fx:Fixture,
    leafIndex:number,
):Promise<LeafNodeUpdate> {
    const fresh = await fx.impl.hpke.generateKeyPair()
    const {
        signature: _signature,
        lifetime: _lifetime,
        ...rest
    } = fx.dave.publicPackage.leafNode as LeafNode & { lifetime?:unknown }
    const tbs = {
        ...rest,
        leafNodeSource: 'update' as const,
        hpkePublicKey: await fx.impl.hpke.exportPublicKey(fresh.publicKey),
        info: {
            leafNodeSource: 'update' as const,
            groupId: fx.alice.groupContext.groupId,
            leafIndex,
        },
    }
    const signature = await signWithLabel(
        fx.dave.privatePackage.signaturePrivateKey,
        'LeafNodeTBS',
        encodeLeafNodeTBS(tbs),
        fx.impl.signature,
    )
    const { info: _info, ...leaf } = tbs
    return { ...leaf, signature }
}

/**
 * A Welcome for carol into the next epoch of alice's group, around
 * `tree` with carol's leaf added: the tree hash (unless `treeHash`
 * overrides it), the epoch secrets, the confirmation tag and alice's
 * GroupInfo signature all agree with the tree, so whatever is wrong with
 * the tree is the only thing wrong with the Welcome.
 */
async function forgeWelcome (
    fx:Fixture,
    tree:RatchetTree,
    treeHash?:Uint8Array,
):Promise<Welcome> {
    const { impl, alice, carol } = fx
    const [full] = addLeafNode(tree, carol.publicPackage.leafNode)
    const groupContext = {
        ...alice.groupContext,
        epoch: alice.groupContext.epoch + 1n,
        treeHash: treeHash ?? await treeHashRoot(full, impl.hash),
    }
    const epoch = await initializeEpoch(
        impl.rng.randomBytes(impl.kdf.size),
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
    const groupInfo = await createGroupInfoWithRatchetTree(groupContext,
        confirmationTag, alice, full, [], impl)
    const encryptedGroupInfo = await encryptGroupInfo(groupInfo,
        epoch.welcomeSecret, impl)
    const egs = await encryptGroupSecrets(
        await impl.hpke.importPublicKey(carol.publicPackage.initKey),
        encryptedGroupInfo,
        { joinerSecret: epoch.joinerSecret, pathSecret: undefined, psks: [] },
        impl.hpke,
    )

    return {
        cipherSuite: groupContext.cipherSuite,
        secrets: [{
            newMember: await makeKeyPackageRef(carol.publicPackage,
                impl.hash),
            encryptedGroupSecrets: { kemOutput: egs.enc, ciphertext: egs.ct },
        }],
        encryptedGroupInfo,
    }
}

async function join (
    fx:Fixture,
    welcome:Welcome | Promise<Welcome>,
    config:ClientConfig = testClientConfig,
):Promise<ClientState> {
    // joinGroup zeroizes the init key it is given, and each case joins
    // with the same KeyPackage
    const initPrivateKey = fx.carol.privatePackage.initPrivateKey.slice()
    return joinGroup(await welcome, fx.carol.publicPackage,
        { ...fx.carol.privatePackage, initPrivateKey },
        emptyPskIndex, fx.impl, undefined, undefined, config)
}

async function rejects (
    t:any,
    expected:Errorish,
    fn:() => Promise<unknown>,
    what:string,
):Promise<void> {
    try {
        await fn()
        t.fail(what + ' should be refused')
    } catch (error:any) {
        t.ok(error instanceof expected,
            `${what} is refused as ${expected.name} (got ${error?.name})`)
    }
}
