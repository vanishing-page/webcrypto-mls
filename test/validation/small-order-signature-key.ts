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
import { generateKeyPackage } from '../../src/key-package.js'
import type { KeyPackage } from '../../src/key-package.js'
import type { LeafNodeUpdate } from '../../src/leaf-node.js'
import type { Proposal } from '../../src/proposal.js'
import { defaultLifetime } from '../../src/lifetime.js'
import { defaultCapabilities } from '../../src/default-capabilities.js'
import { ValidationError } from '../../src/mls-error.js'
import { testCiphersuites } from '../helpers/suite-filter.js'
import { testClientConfig } from '../helpers/client-config.js'
import type { MLSMessage } from '../../src/message.js'
import type { SignatureSecretKey } from '../../src/crypto/signature.js'

function framed (m:MLSMessage) {
    if (m.wireformat !== 'mls_private_message' &&
        m.wireformat !== 'mls_public_message') {
        throw new Error('Expected a framed message')
    }
    return m
}

// A small-order EdDSA key with R = identity, S = 0 is a universal forgery,
// so a leaf carrying one has to be refused as a leaf, before any signature
// over it is checked (audit M4).

const IDENTITY_25519 = new Uint8Array(32)
IDENTITY_25519[0] = 1
// an order-8 point
const ORDER_8_25519 = Uint8Array.from(
    ('c7176a703d4dd84fba3c0b760d10670f' +
        '2a2053fa2c39ccc64ec7fd7792ac037a').match(/../g)!,
    (h) => parseInt(h, 16),
)
const IDENTITY_448 = new Uint8Array(57)
IDENTITY_448[0] = 1
// (0, -1), order 2
const ORDER_2_448 = new Uint8Array(57).fill(0xff)
ORDER_2_448[28] = 0xfe
ORDER_2_448[56] = 0

function smallOrderKeys (cs:CiphersuiteName):Uint8Array[] {
    const alg = getCiphersuiteFromName(cs).signature
    if (alg === 'Ed25519') return [IDENTITY_25519, ORDER_8_25519]
    if (alg === 'Ed448') return [IDENTITY_448, ORDER_2_448]
    return []
}

// R = identity, S = 0
function forgedSignature (key:Uint8Array):Uint8Array {
    const sig = new Uint8Array(key.length * 2)
    sig[0] = 1
    return sig
}

// One suite per curve in this shard: the check is per signature scheme,
// and a second suite on the same curve would tell it nothing.
const edSuites = ['Ed25519', 'Ed448'].flatMap((alg) =>
    testCiphersuites()
        .filter((cs) => getCiphersuiteFromName(cs).signature === alg)
        .slice(0, 1))

for (const cs of edSuites) {
    test('a KeyPackage with a small-order signature key is rejected - ' +
        cs, async (t) => {
        await orSkip(t, cs, async () => {
            const { impl, alice } = await aliceAlone(cs)
            for (const key of smallOrderKeys(cs)) {
                const bob = await member('bob', impl)
                const kp:KeyPackage = {
                    ...bob.publicPackage,
                    signature: forgedSignature(key),
                    leafNode: {
                        ...bob.publicPackage.leafNode,
                        signaturePublicKey: key,
                        signature: forgedSignature(key),
                    },
                }
                await rejects(t, () => createCommit(
                    { state: alice, cipherSuite: impl },
                    {
                        extraProposals: [{
                            proposalType: 'add',
                            add: { keyPackage: kp },
                        }],
                    },
                ), 'Add')
            }
        })
    })

    test('an Update with a small-order signature key is rejected - ' +
        cs, async (t) => {
        await orSkip(t, cs, async () => {
            for (const key of smallOrderKeys(cs)) {
                const { impl, alice, bobGroup, bobSignKey } =
                    await aliceAndBob(cs)
                const rotated = await member('bob', impl)
                const own = bobGroup.ratchetTree[
                    bobGroup.privatePath.leafIndex * 2]
                if (own?.nodeType !== 'leaf') throw new Error('no leaf')
                const leaf:LeafNodeUpdate = {
                    ...own.leaf,
                    leafNodeSource: 'update',
                    hpkePublicKey:
                        rotated.publicPackage.leafNode.hpkePublicKey,
                    signaturePublicKey: key,
                    signature: forgedSignature(key),
                }
                const update:Proposal = {
                    proposalType: 'update',
                    update: { leafNode: leaf },
                }
                // createProposal refuses this before signing, so sign it
                // the way a hostile peer would, without that check.
                const { publicMessage } = await protectProposalPublic(
                    bobSignKey,
                    bobGroup.keySchedule.membershipKey,
                    bobGroup.groupContext,
                    new Uint8Array(),
                    update,
                    bobGroup.privatePath.leafIndex,
                    impl,
                )
                const sent:MLSMessage = {
                    wireformat: 'mls_public_message',
                    version: 'mls10',
                    publicMessage,
                }
                await rejects(t, async () => {
                    const received = await processMessage(framed(sent),
                        alice, emptyPskIndex, acceptAll, impl)
                    return createCommit(
                        { state: received.newState, cipherSuite: impl },
                        {},
                    )
                }, 'Update')
            }
        })
    })

    test('a commit leaf with a small-order signature key is rejected - ' +
        cs, async (t) => {
        await orSkip(t, cs, async () => {
            for (const key of smallOrderKeys(cs)) {
                const { impl, alice, bobGroup } = await aliceAndBob(cs)
                // Bob's own copy of his leaf names the small-order key,
                // so his UpdatePath leaf carries it to Alice.
                const index = bobGroup.privatePath.leafIndex * 2
                const own = bobGroup.ratchetTree[index]
                if (own?.nodeType !== 'leaf') throw new Error('no leaf')
                const tree = [...bobGroup.ratchetTree]
                tree[index] = {
                    ...own,
                    leaf: { ...own.leaf, signaturePublicKey: key },
                }
                const commit = await createCommit(
                    {
                        state: { ...bobGroup, ratchetTree: tree },
                        cipherSuite: impl,
                    },
                    {},
                )
                await rejects(t, () => processMessage(
                    framed(commit.commit), alice,
                    emptyPskIndex, acceptAll, impl), 'commit leaf')
            }
        })
    })
}

async function rejects (
    t:any,
    fn:() => Promise<unknown>,
    what:string,
):Promise<void> {
    try {
        await fn()
        t.fail(what + ' with a small-order key should be rejected')
    } catch (error) {
        t.ok(error instanceof ValidationError,
            what + ' with a small-order key throws ValidationError')
    }
}

async function orSkip (
    t:any,
    cs:CiphersuiteName,
    fn:() => Promise<void>,
):Promise<void> {
    try {
        await fn()
    } catch (error:any) {
        if (error?.name === 'NotSupportedError' ||
            error?.name === 'DependencyError') {
            t.comment(`Skipping ${cs}: ${skipReason(error)}`)
            return
        }
        throw error
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

async function aliceAlone (cs:CiphersuiteName) {
    const impl = await getCipherSuite(getCiphersuiteFromName(cs))
    const a = await member('alice', impl)
    const alice = await createGroup(new TextEncoder().encode('group'),
        a.publicPackage, a.privatePackage, [], impl, testClientConfig)
    return { impl, alice }
}

async function aliceAndBob (cs:CiphersuiteName):Promise<{
    impl:CiphersuiteImpl;
    alice:ClientState;
    bobGroup:ClientState;
    bobSignKey:SignatureSecretKey;
}> {
    const { impl, alice } = await aliceAlone(cs)
    const bob = await member('bob', impl)
    const add = await createCommit(
        { state: alice, cipherSuite: impl },
        {
            extraProposals: [{
                proposalType: 'add',
                add: { keyPackage: bob.publicPackage },
            }],
            ratchetTreeExtension: true,
        },
    )
    const bobGroup = await joinGroup(add.welcome!, bob.publicPackage,
        bob.privatePackage, emptyPskIndex, impl, undefined, undefined,
        testClientConfig)
    return {
        impl,
        alice: add.newState,
        bobGroup,
        bobSignKey: bob.privatePackage.signaturePrivateKey,
    }
}
