import { test } from '@substrate-system/tapzero'
import { skipReason } from '../helpers/skip.js'
import {
    createGroup,
    joinGroup,
    makePskIndex,
    type ClientState,
} from '../../src/client-state.js'
import { createCommit } from '../../src/create-commit.js'
import {
    createApplicationMessage,
    createProposal,
} from '../../src/create-message.js'
import { processMessage } from '../../src/process-messages.js'
import { acceptAll } from '../../src/incoming-message-action.js'
import { emptyPskIndex } from '../../src/psk-index.js'
import type {
    CiphersuiteImpl,
    CiphersuiteName,
} from '../../src/crypto/ciphersuite.js'
import { getCiphersuiteFromName } from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import { generateKeyPackage } from '../../src/key-package.js'
import { defaultLifetime } from '../../src/lifetime.js'
import { defaultCapabilities } from '../../src/default-capabilities.js'
import { ValidationError } from '../../src/mls-error.js'
import type { ClientConfig } from '../../src/client-config.js'
import type { MLSMessage } from '../../src/message.js'
import {
    discardPendingProposal,
    listPendingProposals,
} from '../../src/index.js'
import { sampleCiphersuites } from '../helpers/suite-filter.js'
import { testClientConfig } from '../helpers/client-config.js'

const enc = new TextEncoder()

for (const cs of sampleCiphersuites()) {
    test(`pending proposals: list, discard, cap ${cs}`, async (t) => {
        try {
            await run(cs as CiphersuiteName, t)
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
    })
}

async function keyPackage (name:string, impl:CiphersuiteImpl) {
    return generateKeyPackage(
        { credentialType: 'basic', identity: enc.encode(name) },
        defaultCapabilities(),
        defaultLifetime(),
        [],
        impl,
    )
}

// only alice gets `config`; bob, the proposer, keeps the test default
async function twoMembers (impl:CiphersuiteImpl, config:ClientConfig) {
    const alice = await keyPackage('alice', impl)
    const bob = await keyPackage('bob', impl)
    const aliceGroup = await createGroup(
        enc.encode('pending-group'),
        alice.publicPackage,
        alice.privatePackage,
        [],
        impl,
        config,
    )
    const add = await createCommit(
        { state: aliceGroup, cipherSuite: impl },
        {
            extraProposals: [{
                proposalType: 'add',
                add: { keyPackage: bob.publicPackage },
            }],
        },
    )
    const bobGroup = await joinGroup(
        add.welcome!,
        bob.publicPackage,
        bob.privatePackage,
        emptyPskIndex,
        impl,
        add.newState.ratchetTree,
        undefined,
        testClientConfig,
    )
    return { alice: add.newState, bob: bobGroup }
}

// bob proposes removing alice; the authenticated data makes each
// proposal's reference distinct
async function bobProposes (bob:ClientState, impl:CiphersuiteImpl, n:number) {
    return createProposal(
        bob,
        false,
        { proposalType: 'remove', remove: { removed: 0 } },
        impl,
        enc.encode(`proposal ${n}`),
    )
}

async function receive (
    state:ClientState,
    message:MLSMessage,
    impl:CiphersuiteImpl,
):Promise<ClientState> {
    if (message.wireformat !== 'mls_private_message') {
        throw new Error('expected a private message')
    }
    const result = await processMessage(
        message,
        state,
        makePskIndex(state, {}),
        acceptAll,
        impl,
    )
    if (result.kind !== 'newState') throw new Error('expected newState')
    return result.newState
}

async function expectValidationError (
    t:any,
    p:Promise<unknown>,
    msg:string,
) {
    try {
        await p
        t.fail(`${msg}: resolved`)
    } catch (err) {
        t.ok(err instanceof ValidationError, `${msg}: ValidationError`)
    }
}

async function run (cs:CiphersuiteName, t:any) {
    const impl = await getCipherSuite(getCiphersuiteFromName(cs))

    // list and discard
    {
        let { alice, bob } = await twoMembers(impl, testClientConfig)
        const sent = await bobProposes(bob, impl, 0)
        bob = sent.newState
        const withPending = await receive(alice, sent.message, impl)

        const bobList = listPendingProposals(bob)
        const listed = listPendingProposals(withPending)
        t.equal(listed.length, 1, 'alice lists exactly one proposal')
        t.equal(listed[0].senderLeafIndex, 1, 'sender is bob')
        t.equal(listed[0].senderType, 'member', 'sender type is member')
        t.deepEqual(
            listed[0].proposal,
            { proposalType: 'remove', remove: { removed: 0 } },
            'the listed proposal is the one sent',
        )
        t.deepEqual(
            listed[0].ref,
            bobList[0].ref,
            'reference matches the one the sender computed',
        )

        try {
            await createApplicationMessage(
                withPending,
                enc.encode('blocked'),
                impl,
            )
            t.fail('application message sent with a pending proposal')
        } catch (err) {
            t.ok(err instanceof Error, 'pending proposal blocks sending')
        }

        const unknown = discardPendingProposal(
            withPending,
            new Uint8Array(listed[0].ref.length),
        )
        t.equal(
            listPendingProposals(unknown).length,
            1,
            'discarding an unknown reference changes nothing',
        )

        alice = discardPendingProposal(withPending, listed[0].ref)
        t.equal(listPendingProposals(alice).length, 0, 'discarded')
        t.equal(
            listPendingProposals(withPending).length,
            1,
            'the input state still lists the proposal',
        )

        bob = discardPendingProposal(bob, bobList[0].ref)
        const msg = await createApplicationMessage(
            alice,
            enc.encode('unblocked'),
            impl,
        )
        const got = await processMessage(
            {
                wireformat: 'mls_private_message',
                privateMessage: msg.privateMessage,
            },
            bob,
            makePskIndex(bob, {}),
            acceptAll,
            impl,
        )
        t.equal(got.kind, 'applicationMessage', 'peer gets the message')
        if (got.kind === 'applicationMessage') {
            t.deepEqual(
                got.message,
                enc.encode('unblocked'),
                'peer decrypts the message',
            )
        }
    }

    // cap of N
    {
        const N = 3
        const config = { ...testClientConfig, maxPendingProposals: N }
        let { alice, bob } = await twoMembers(impl, config)
        for (let i = 0; i < N; i++) {
            const sent = await bobProposes(bob, impl, i)
            bob = discardAll(sent.newState)
            alice = await receive(alice, sent.message, impl)
        }
        const extra = await bobProposes(bob, impl, N)
        await expectValidationError(
            t,
            receive(alice, extra.message, impl),
            'proposal N+1 at the cap',
        )
        t.equal(
            listPendingProposals(alice).length,
            N,
            'the first N are all still listed',
        )
    }

    // cap of 0
    {
        const config = { ...testClientConfig, maxPendingProposals: 0 }
        const { alice, bob } = await twoMembers(impl, config)
        const sent = await bobProposes(bob, impl, 0)
        await expectValidationError(
            t,
            receive(alice, sent.message, impl),
            'cap 0 accepts none',
        )
    }

    // default config accepts a routine number
    {
        let { alice, bob } = await twoMembers(impl, testClientConfig)
        for (let i = 0; i < 20; i++) {
            const sent = await bobProposes(bob, impl, i)
            bob = discardAll(sent.newState)
            alice = await receive(alice, sent.message, impl)
        }
        t.equal(
            listPendingProposals(alice).length,
            20,
            'default config accepts 20 proposals',
        )
    }
}

function discardAll (state:ClientState):ClientState {
    return listPendingProposals(state).reduce(
        (s, p) => discardPendingProposal(s, p.ref),
        state,
    )
}
