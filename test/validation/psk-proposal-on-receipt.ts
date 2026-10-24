import { test } from '@substrate-system/tapzero'
import { skipReason } from '../helpers/skip.js'
import type { ClientState } from '../../src/client-state.js'
import { createGroup, joinGroup } from '../../src/client-state.js'
import { createCommit } from '../../src/create-commit.js'
import {
    createApplicationMessage,
    createProposal
} from '../../src/create-message.js'
import { emptyPskIndex } from '../../src/psk-index.js'
import type { Credential } from '../../src/credential.js'
import type {
    CiphersuiteImpl,
    CiphersuiteName
} from '../../src/crypto/ciphersuite.js'
import {
    getCiphersuiteFromName
} from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import { generateKeyPackage } from '../../src/key-package.js'
import type {
    KeyPackage,
    PrivateKeyPackage
} from '../../src/key-package.js'
import { processMessage } from '../../src/process-messages.js'
import type { MlsPublicMessage } from '../../src/message.js'
import {
    protectProposalPublic
} from '../../src/message-protection-public.js'
import type { PreSharedKeyID } from '../../src/presharedkey.js'
import type { Proposal } from '../../src/proposal.js'
import {
    addUnappliedProposal,
    listPendingProposals
} from '../../src/unapplied-proposals.js'
import { ValidationError } from '../../src/mls-error.js'
import { defaultLifetime } from '../../src/lifetime.js'
import { defaultCapabilities } from '../../src/default-capabilities.js'
import { sampleCiphersuites } from '../helpers/suite-filter.js'
import { testClientConfig } from '../helpers/client-config.js'

// A PSK proposal no commit can carry must never reach the pending set:
// a stored one makes every createCommit and createApplicationMessage
// from that state throw. The nonce length depends only on the KDF, so
// one suite per KDF size is enough.
for (const cs of sampleCiphersuites()) {
    test(`PSK proposal with an empty nonce refused on arrival ${cs}`,
        async (t) => {
            await withSuite(t, cs, async (f) => {
                await refusedOnArrival(t, f, {
                    psktype: 'external',
                    pskId: new TextEncoder().encode('psk'),
                    pskNonce: new Uint8Array(),
                })
            })
        })

    test(`PSK proposal with a short nonce refused on arrival ${cs}`,
        async (t) => {
            await withSuite(t, cs, async (f) => {
                await refusedOnArrival(t, f, {
                    psktype: 'external',
                    pskId: new TextEncoder().encode('psk'),
                    pskNonce: f.impl.rng.randomBytes(f.impl.kdf.size - 1),
                })
            })
        })

    for (const usage of ['branch', 'reinit'] as const) {
        test(`${usage}-usage resumption PSK proposal refused on ` +
            `arrival after epoch 0 ${cs}`, async (t) => {
            await withSuite(t, cs, async (f) => {
                t.ok(f.alice.groupContext.epoch !== 0n,
                    'the group is past epoch 0')
                await refusedOnArrival(t, f, {
                    psktype: 'resumption',
                    usage,
                    pskGroupId: f.alice.groupContext.groupId,
                    pskEpoch: 0n,
                    pskNonce: f.impl.rng.randomBytes(f.impl.kdf.size),
                })
            })
        })
    }

    // availability is a commit-time decision: Alice holds no secret for
    // this id, and the proposal is stored anyway
    test(`well-formed external PSK proposal stored on arrival ${cs}`,
        async (t) => {
            await withSuite(t, cs, async (f) => {
                const msg = await fromBob(f, pskProposal({
                    psktype: 'external',
                    pskId: new TextEncoder().encode('not-held'),
                    pskNonce: f.impl.rng.randomBytes(f.impl.kdf.size),
                }))
                const result = await processMessage(
                    msg,
                    f.alice,
                    emptyPskIndex,
                    undefined,
                    f.impl,
                )
                const pending = listPendingProposals(result.newState)
                t.equal(pending.length, 1, 'the proposal is pending')
                t.equal(pending[0]?.proposal.proposalType, 'psk',
                    'and it is the PSK proposal')
            })
        })

    test(`createProposal refuses a PSK with an empty nonce ${cs}`,
        async (t) => {
            await withSuite(t, cs, async (f) => {
                let caught:unknown
                try {
                    await createProposal(f.alice, true, pskProposal({
                        psktype: 'external',
                        pskId: new TextEncoder().encode('psk'),
                        pskNonce: new Uint8Array(),
                    }), f.impl)
                } catch (err) {
                    caught = err
                }
                t.ok(caught instanceof ValidationError,
                    'createProposal rejects with ValidationError')
                t.equal(listPendingProposals(f.alice).length, 0,
                    'the pending set is unchanged')
            })
        })

    // a state that stored one before receipt checked PSKs recovers at
    // its next commit
    test(`commit drops a stored PSK proposal with an empty nonce ${cs}`,
        async (t) => {
            await withSuite(t, cs, async (f) => {
                const stored:ClientState = {
                    ...f.alice,
                    unappliedProposals: addUnappliedProposal(
                        f.impl.rng.randomBytes(f.impl.kdf.size),
                        f.alice.unappliedProposals,
                        pskProposal({
                            psktype: 'external',
                            pskId: new TextEncoder().encode('psk'),
                            pskNonce: new Uint8Array(),
                        }),
                        f.bob.privatePath.leafIndex,
                        'member',
                    ),
                }
                t.equal(listPendingProposals(stored).length, 1,
                    'the invalid proposal is pending')

                const commit = await createCommit({
                    state: stored,
                    cipherSuite: f.impl,
                })
                t.ok(
                    commit.newState.groupContext.epoch >
                        stored.groupContext.epoch,
                    'createCommit succeeds'
                )
                t.equal(listPendingProposals(commit.newState).length, 0,
                    'the new state has an empty pending set')
            })
        })
}

interface Member {
    publicPackage:KeyPackage
    privatePackage:PrivateKeyPackage
}

interface Fixture {
    impl:CiphersuiteImpl
    alice:ClientState
    bob:ClientState
    bobMember:Member
}

async function withSuite (
    t:any,
    cs:CiphersuiteName,
    body:(f:Fixture) => Promise<void>,
):Promise<void> {
    try {
        await body(await twoMemberGroup(cs))
    } catch (error:any) {
        if (
            error?.name === 'NotSupportedError' ||
            error?.name === 'DependencyError'
        ) {
            t.comment(`Skipping ${cs}: ${skipReason(error)}`)
            return
        }
        throw error
    }
}

async function member (
    name:string,
    impl:CiphersuiteImpl,
):Promise<Member> {
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

/** Alice and Bob, both at epoch 1. */
async function twoMemberGroup (cs:CiphersuiteName):Promise<Fixture> {
    const impl = await getCipherSuite(getCiphersuiteFromName(cs))
    const aliceMember = await member('alice', impl)
    const bobMember = await member('bob', impl)

    const created = await createGroup(
        new TextEncoder().encode('psk-receipt'),
        aliceMember.publicPackage,
        aliceMember.privatePackage,
        [],
        impl,
        testClientConfig,
    )
    const added = await createCommit(
        { state: created, cipherSuite: impl },
        {
            extraProposals: [{
                proposalType: 'add',
                add: { keyPackage: bobMember.publicPackage },
            }],
        },
    )
    const bob = await joinGroup(
        added.welcome!,
        bobMember.publicPackage,
        bobMember.privatePackage,
        emptyPskIndex,
        impl,
        added.newState.ratchetTree,
        undefined,
        testClientConfig,
    )
    return { impl, alice: added.newState, bob, bobMember }
}

function pskProposal (preSharedKeyId:PreSharedKeyID):Proposal {
    return { proposalType: 'psk', psk: { preSharedKeyId } }
}

/**
 * Bob's proposal, signed and MACed as `createProposal` would, but
 * without the local validation `createProposal` applies.
 */
async function fromBob (
    f:Fixture,
    proposal:Proposal,
):Promise<MlsPublicMessage> {
    const { publicMessage } = await protectProposalPublic(
        f.bobMember.privatePackage.signaturePrivateKey,
        f.bob.keySchedule.membershipKey,
        f.bob.groupContext,
        new Uint8Array(),
        proposal,
        f.bob.privatePath.leafIndex,
        f.impl,
    )
    return {
        wireformat: 'mls_public_message',
        publicMessage,
    }
}

/**
 * Alice refuses Bob's PSK proposal under the default incoming-message
 * policy, and the state she passed in still commits and sends.
 */
async function refusedOnArrival (
    t:any,
    f:Fixture,
    preSharedKeyId:PreSharedKeyID,
):Promise<void> {
    const msg = await fromBob(f, pskProposal(preSharedKeyId))

    let caught:unknown
    try {
        await processMessage(
            msg,
            f.alice,
            emptyPskIndex,
            undefined,
            f.impl,
        )
    } catch (err) {
        caught = err
    }
    t.ok(caught instanceof ValidationError,
        'processMessage rejects with ValidationError')
    t.equal(listPendingProposals(f.alice).length, 0,
        'the pending set of the input state is still empty')

    const commit = await createCommit({ state: f.alice, cipherSuite: f.impl })
    t.ok(commit.newState.groupContext.epoch > f.alice.groupContext.epoch,
        'createCommit from that state succeeds')

    const sent = await createApplicationMessage(
        f.alice,
        new TextEncoder().encode('hello'),
        f.impl,
    )
    t.ok(sent.privateMessage, 'createApplicationMessage succeeds')
}
