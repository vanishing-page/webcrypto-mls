/**
 * A PrivateMessage labelled with an epoch later than the receiver's is
 * refused before it is unprotected, and `createProposal` refuses to run
 * from a state that cannot send handshake messages.
 *
 * See security-audit-2026-09.md L6 and L9.
 */
import { skipReason } from '../helpers/skip.js'
import { test } from '@substrate-system/tapzero'
import type { ClientState } from '../../src/client-state.js'
import { createGroup, joinGroup, makePskIndex } from '../../src/client-state.js'
import { createCommit } from '../../src/create-commit.js'
import {
    createApplicationMessage,
    createProposal
} from '../../src/create-message.js'
import { processPrivateMessage } from '../../src/process-messages.js'
import { reinitGroup } from '../../src/resumption.js'
import { emptyPskIndex } from '../../src/psk-index.js'
import type { Credential } from '../../src/credential.js'
import type { CiphersuiteName } from '../../src/crypto/ciphersuite.js'
import { getCiphersuiteFromName } from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import { generateKeyPackage } from '../../src/key-package.js'
import type { ProposalAdd, ProposalRemove } from '../../src/proposal.js'
import type { PrivateMessage } from '../../src/private-message.js'
import type { MLSMessage } from '../../src/message.js'
import { defaultLifetime } from '../../src/lifetime.js'
import { defaultCapabilities } from '../../src/default-capabilities.js'
import { ValidationError } from '../../src/mls-error.js'
import { sampleCiphersuites } from '../helpers/suite-filter.js'
import { testClientConfig } from '../helpers/client-config.js'

function skippable (error:any):boolean {
    return error?.name === 'NotSupportedError' ||
        error?.name === 'DependencyError'
}

function run (
    name:string,
    body:(t:any, cs:CiphersuiteName) => Promise<void>
) {
    for (const cs of sampleCiphersuites()) {
        test(`${name} ${cs}`, async (t) => {
            try {
                await body(t, cs as CiphersuiteName)
            } catch (error:any) {
                if (skippable(error)) {
                    t.comment(`Skipping ${cs}: ${skipReason(error)}`)
                    return
                }
                throw error
            }
        })
    }
}

async function makeMember (name:string, impl:any) {
    const credential:Credential = {
        credentialType: 'basic',
        identity: new TextEncoder().encode(name),
    }
    return generateKeyPackage(
        credential,
        defaultCapabilities(),
        defaultLifetime(),
        [],
        impl
    )
}

function privateMessage (message:MLSMessage):PrivateMessage {
    if (message.wireformat !== 'mls_private_message') {
        throw new Error('Expected a private message')
    }
    return message.privateMessage
}

async function errorOf (fn:() => Promise<unknown>):Promise<unknown> {
    try {
        await fn()
    } catch (error) {
        return error
    }
    return undefined
}

/** alice, bob and charlie at epoch 1 */
async function threeMembers (cipherSuite:CiphersuiteName) {
    const impl = await getCipherSuite(getCiphersuiteFromName(cipherSuite))
    const alice = await makeMember('alice', impl)
    const bob = await makeMember('bob', impl)
    const charlie = await makeMember('charlie', impl)

    const created = await createGroup(
        new TextEncoder().encode('future-epoch'),
        alice.publicPackage,
        alice.privatePackage,
        [],
        impl,
        testClientConfig
    )

    const adds:ProposalAdd[] = [bob, charlie].map(m => ({
        proposalType: 'add',
        add: { keyPackage: m.publicPackage },
    }))

    const addResult = await createCommit(
        { state: created, cipherSuite: impl },
        { extraProposals: adds },
    )
    const aliceState:ClientState = addResult.newState

    const bobState = await joinGroup(
        addResult.welcome!,
        bob.publicPackage,
        bob.privatePackage,
        emptyPskIndex,
        impl,
        aliceState.ratchetTree,
        undefined,
        testClientConfig
    )

    return { impl, aliceState, bobState }
}

run('future-epoch application message is rejected', async (t, cs) => {
    const { impl, aliceState, bobState } = await threeMembers(cs)

    const first = await createApplicationMessage(
        aliceState,
        new TextEncoder().encode('one'),
        impl,
    )
    const second = await createApplicationMessage(
        first.newState,
        new TextEncoder().encode('two'),
        impl,
    )

    const forged:PrivateMessage = {
        ...first.privateMessage,
        epoch: bobState.groupContext.epoch + 1n,
    }

    const error = await errorOf(() => processPrivateMessage(
        bobState,
        forged,
        makePskIndex(bobState, {}),
        impl,
    ))
    t.ok(error instanceof ValidationError,
        'a message labelled with the next epoch throws ValidationError')

    const honest = await processPrivateMessage(
        bobState,
        first.privateMessage,
        makePskIndex(bobState, {}),
        impl,
    )
    t.equal(honest.kind, 'applicationMessage',
        'the honest message still decrypts')
    const next = await processPrivateMessage(
        honest.newState,
        second.privateMessage,
        makePskIndex(honest.newState, {}),
        impl,
    )
    t.equal(next.kind, 'applicationMessage',
        'the following generation still decrypts')
})

run('future-epoch proposal is rejected', async (t, cs) => {
    const { impl, aliceState, bobState } = await threeMembers(cs)

    const removeCharlie:ProposalRemove = {
        proposalType: 'remove',
        remove: { removed: 2 },
    }
    const proposal = await createProposal(bobState, false, removeCharlie, impl)
    const forged:PrivateMessage = {
        ...privateMessage(proposal.message),
        epoch: aliceState.groupContext.epoch + 5n,
    }

    const error = await errorOf(() => processPrivateMessage(
        aliceState,
        forged,
        makePskIndex(aliceState, {}),
        impl,
    ))
    t.ok(error instanceof ValidationError,
        'a proposal labelled with a future epoch throws ValidationError')

    // no pending proposal: alice can still send application messages
    const sent = await createApplicationMessage(
        aliceState,
        new TextEncoder().encode('still clear'),
        impl,
    )
    t.ok(sent.privateMessage, 'nothing entered the pending set')
})

run('createProposal is gated after removal', async (t, cs) => {
    const { impl, aliceState, bobState } = await threeMembers(cs)

    const removeBob:ProposalRemove = {
        proposalType: 'remove',
        remove: { removed: bobState.privatePath.leafIndex },
    }
    const removal = await createCommit(
        { state: aliceState, cipherSuite: impl },
        { extraProposals: [removeBob] },
    )
    const removed = (await processPrivateMessage(
        bobState,
        privateMessage(removal.commit),
        makePskIndex(bobState, {}),
        impl,
    )).newState

    const commitError = await errorOf(() => createCommit(
        { state: removed, cipherSuite: impl }
    ))
    const proposalError = await errorOf(() => createProposal(
        removed,
        false,
        { proposalType: 'remove', remove: { removed: 2 } },
        impl,
    ))
    t.ok(commitError instanceof Error, 'createCommit rejects')
    t.equal(
        (proposalError as any)?.constructor,
        (commitError as any)?.constructor,
        'createProposal rejects with the same error class'
    )
})

run('createProposal is gated while suspended', async (t, cs) => {
    const { impl, aliceState } = await threeMembers(cs)

    const reinit = await reinitGroup(
        aliceState,
        new TextEncoder().encode('future-epoch-next'),
        'mls10',
        cs,
        [],
        impl,
    )
    const suspended = reinit.newState

    const commitError = await errorOf(() => createCommit(
        { state: suspended, cipherSuite: impl }
    ))
    const proposalError = await errorOf(() => createProposal(
        suspended,
        true,
        { proposalType: 'remove', remove: { removed: 2 } },
        impl,
    ))
    t.ok(commitError instanceof Error, 'createCommit rejects')
    t.equal(
        (proposalError as any)?.constructor,
        (commitError as any)?.constructor,
        'createProposal rejects with the same error class'
    )
})
