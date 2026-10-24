import { test } from '@substrate-system/tapzero'
import { skipReason } from '../helpers/skip.js'
import { createGroup, joinGroup } from '../../src/client-state.js'
import type { ClientState } from '../../src/client-state.js'
import { createCommit } from '../../src/create-commit.js'
import {
    protectProposalPublic
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
import { generateKeyPackage, signKeyPackage } from '../../src/key-package.js'
import type {
    KeyPackage,
    PrivateKeyPackage,
} from '../../src/key-package.js'
import { encodeLeafNodeTBS, signLeafNodeKeyPackage } from
    '../../src/leaf-node.js'
import type { LeafNodeUpdate } from '../../src/leaf-node.js'
import { signWithLabel } from '../../src/crypto/signature.js'
import type { Proposal } from '../../src/proposal.js'
import { defaultLifetime } from '../../src/lifetime.js'
import { defaultCapabilities } from '../../src/default-capabilities.js'
import { ValidationError } from '../../src/mls-error.js'
import { listPendingProposals } from '../../src/unapplied-proposals.js'
import { testCiphersuites } from '../helpers/suite-filter.js'
import { testClientConfig } from '../helpers/client-config.js'
import type { MLSMessage } from '../../src/message.js'

// RFC 9420 5.1.1 and 7.3: a leaf's encryption key has to be a valid public
// key for the ciphersuite's KEM. One that is not imports badly or seals to
// a known shared secret, and the failure used to surface only at the next
// path commit that encrypted to it, as a provider error with nothing to
// tie it to the KeyPackage (audit 2026-10-24 F3).

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
    test('an Add whose leaf key is unusable is refused by its committer - ' +
        cs, async (t) => {
        const impl = await implOrSkip(t, cs)
        if (impl === undefined) return
        const { alice } = await aliceAndBob(impl)

        for (const key of unusableKeys(cs)) {
            const mallory = await member('mallory', impl)
            const kp = await withLeafKey(mallory.publicPackage,
                mallory.privatePackage, key, impl)
            await rejects(t, () => createCommit(
                { state: alice, cipherSuite: impl },
                { extraProposals: [addOf(kp)] },
            ), 'by-value Add')
        }

        await honestAddThenPathCommits(t, alice, impl)
    })

    test('an Add proposal whose leaf key is unusable is refused on ' +
        'receipt - ' + cs, async (t) => {
        const impl = await implOrSkip(t, cs)
        if (impl === undefined) return
        const { alice, bob, bobPriv } = await aliceAndBob(impl)

        for (const key of unusableKeys(cs)) {
            const mallory = await member('mallory', impl)
            const kp = await withLeafKey(mallory.publicPackage,
                mallory.privatePackage, key, impl)
            const msg = await signedByPeer(bob, bobPriv, {
                proposalType: 'add',
                add: { keyPackage: kp },
            }, impl)
            await rejects(t, () => receive(alice, msg, impl),
                'Add proposal')
            t.equal(listPendingProposals(alice).length, 0,
                'the pending set is unchanged')
        }

        await honestAddThenPathCommits(t, alice, impl, [bob])
    })

    test('an Update whose leaf key is unusable is refused on receipt - ' +
        cs, async (t) => {
        const impl = await implOrSkip(t, cs)
        if (impl === undefined) return
        const { alice, bob, bobPriv } = await aliceAndBob(impl)

        for (const key of unusableKeys(cs)) {
            const leaf = await updateLeaf(bob, bobPriv, key, impl)
            const msg = await signedByPeer(bob, bobPriv, {
                proposalType: 'update',
                update: { leafNode: leaf },
            }, impl)
            await rejects(t, () => receive(alice, msg, impl), 'Update')
            t.equal(listPendingProposals(alice).length, 0,
                'the pending set is unchanged')
        }

        await honestAddThenPathCommits(t, alice, impl, [bob])
    })

    test('a KeyPackage whose init key is unusable is refused on Add - ' +
        cs, async (t) => {
        const impl = await implOrSkip(t, cs)
        if (impl === undefined) return
        const { alice } = await aliceAndBob(impl)

        for (const key of unusableKeys(cs)) {
            const mallory = await member('mallory', impl)
            const kp = await signKeyPackage(
                {
                    version: mallory.publicPackage.version,
                    cipherSuite: mallory.publicPackage.cipherSuite,
                    initKey: key,
                    leafNode: mallory.publicPackage.leafNode,
                    extensions: mallory.publicPackage.extensions,
                },
                mallory.privatePackage.signaturePrivateKey,
                impl.signature,
            )
            await rejects(t, () => createCommit(
                { state: alice, cipherSuite: impl },
                { extraProposals: [addOf(kp)] },
            ), 'init key')
        }

        await honestAddThenPathCommits(t, alice, impl)
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

/** A correctly signed update-source leaf for `state`'s own leaf. */
async function updateLeaf (
    state:ClientState,
    priv:PrivateKeyPackage,
    hpkePublicKey:Uint8Array,
    impl:CiphersuiteImpl,
):Promise<LeafNodeUpdate> {
    const own = state.ratchetTree[state.privatePath.leafIndex * 2]
    if (own?.nodeType !== 'leaf') throw new Error('no own leaf')
    const {
        signature: _signature,
        lifetime: _lifetime,
        ...rest
    } = own.leaf as typeof own.leaf & { lifetime?:unknown }
    const tbs = {
        ...rest,
        leafNodeSource: 'update' as const,
        hpkePublicKey,
        info: {
            leafNodeSource: 'update' as const,
            groupId: state.groupContext.groupId,
            leafIndex: state.privatePath.leafIndex,
        },
    }
    const signature = await signWithLabel(
        priv.signaturePrivateKey,
        'LeafNodeTBS',
        encodeLeafNodeTBS(tbs),
        impl.signature,
    )
    const { info: _info, ...leaf } = tbs
    return { ...leaf, signature }
}

/**
 * A proposal signed by `state`'s member the way a hostile peer would,
 * without the receipt check `createProposal` runs before signing.
 */
async function signedByPeer (
    state:ClientState,
    priv:PrivateKeyPackage,
    proposal:Proposal,
    impl:CiphersuiteImpl,
):Promise<MLSMessage> {
    const { publicMessage } = await protectProposalPublic(
        priv.signaturePrivateKey,
        state.keySchedule.membershipKey,
        state.groupContext,
        new Uint8Array(),
        proposal,
        state.privatePath.leafIndex,
        impl,
    )
    return { wireformat: 'mls_public_message', version: 'mls10', publicMessage }
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
    return { alice: add.newState, bob, bobPriv: b.privatePackage }
}

/**
 * The control the audit saw broken: from the state that refused the bad
 * key, an honest Add goes through, and then every member, the new one
 * included, can commit with a path that encrypts to every other leaf.
 */
async function honestAddThenPathCommits (
    t:any,
    alice:ClientState,
    impl:CiphersuiteImpl,
    others:ClientState[] = [],
):Promise<void> {
    const carol = await member('carol', impl)
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
    let members = [add.newState]
    for (const other of others) {
        members.push(await receive(other, add.commit, impl))
    }
    members.push(await joinGroup(add.welcome!, carol.publicPackage,
        carol.privatePackage, emptyPskIndex, impl, undefined, undefined,
        testClientConfig))

    for (let i = 0; i < members.length; i++) {
        // an empty commit always carries a path
        const commit = await createCommit(
            { state: members[i]!, cipherSuite: impl },
            {},
        )
        const next:ClientState[] = []
        for (let j = 0; j < members.length; j++) {
            next.push(i === j ?
                commit.newState :
                await receive(members[j]!, commit.commit, impl))
        }
        members = next
    }
    t.ok(true, 'an honest Add and a path commit from every member succeed')
}

function addOf (keyPackage:KeyPackage):Proposal {
    return { proposalType: 'add', add: { keyPackage } }
}
