/**
 * RFC 9420 12.4.2: once a ReInit commit is processed, the old group is
 * finished. A member that ignores the ReInit can still produce traffic
 * that authenticates under the old group's keys, so the suspended
 * receiver has to refuse it rather than rely on the sender's own flag.
 *
 * The nonconforming sender is alice's own post-ReInit state with
 * `groupActiveState` flipped back to `active`: only her local flag
 * changes, so everything she sends is genuinely authenticated. Bob's
 * state is never touched directly.
 */
import { test } from '@substrate-system/tapzero'
import { skipReason } from '../helpers/skip.js'
import type { ClientState } from '../../src/client-state.js'
import {
    createGroup,
    joinGroup,
    makePskIndex
} from '../../src/client-state.js'
import { createCommit } from '../../src/create-commit.js'
import {
    createApplicationMessage,
    createProposal
} from '../../src/create-message.js'
import {
    processMessage,
    processPrivateMessage
} from '../../src/process-messages.js'
import type {
    MLSMessage,
    MlsPrivateMessage,
    MlsPublicMessage
} from '../../src/message.js'
import { emptyPskIndex } from '../../src/psk-index.js'
import {
    joinGroupFromReinit,
    reinitCreateNewGroup,
    reinitGroup
} from '../../src/resumption.js'
import type { Credential } from '../../src/credential.js'
import type {
    CiphersuiteImpl,
    CiphersuiteName
} from '../../src/crypto/ciphersuite.js'
import { getCiphersuiteFromName } from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import { generateKeyPackage } from '../../src/key-package.js'
import type { PrivateMessage } from '../../src/private-message.js'
import { defaultLifetime } from '../../src/lifetime.js'
import { defaultCapabilities } from '../../src/default-capabilities.js'
import { ValidationError } from '../../src/mls-error.js'
import { acceptAll } from '../../src/incoming-message-action.js'
import { sampleCiphersuites } from '../helpers/suite-filter.js'
import { testClientConfig } from '../helpers/client-config.js'

const enc = new TextEncoder()
const dec = new TextDecoder()

for (const cs of sampleCiphersuites()) {
    test('Suspended member refuses old-group traffic ' + cs, async (t) => {
        try {
            await suspendedReceive(t, cs)
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

function credential (name:string):Credential {
    return { credentialType: 'basic', identity: enc.encode(name) }
}

async function keyPackage (name:string, impl:CiphersuiteImpl) {
    return generateKeyPackage(
        credential(name),
        defaultCapabilities(),
        defaultLifetime(),
        [],
        impl
    )
}

async function refusal (
    run:() => Promise<unknown>
):Promise<unknown> {
    try {
        await run()
    } catch (error) {
        return error
    }
    return undefined
}

function asPrivate (message:MLSMessage):PrivateMessage {
    if (message.wireformat !== 'mls_private_message') {
        throw new Error('Expected a private message')
    }
    return message.privateMessage
}

function asFramed (
    message:MLSMessage
):MlsPrivateMessage|MlsPublicMessage {
    if (
        message.wireformat !== 'mls_private_message' &&
        message.wireformat !== 'mls_public_message'
    ) {
        throw new Error('Expected a framed message')
    }
    return message
}

async function suspendedReceive (t:any, cipherSuite:CiphersuiteName) {
    const impl = await getCipherSuite(getCiphersuiteFromName(cipherSuite))

    const alice = await keyPackage('alice', impl)
    const bob = await keyPackage('bob', impl)

    let aliceGroup = await createGroup(
        enc.encode('group1'),
        alice.publicPackage,
        alice.privatePackage,
        [],
        impl,
        testClientConfig
    )

    const addBob = await createCommit(
        { state: aliceGroup, cipherSuite: impl },
        {
            extraProposals: [{
                proposalType: 'add',
                add: { keyPackage: bob.publicPackage }
            }]
        }
    )
    aliceGroup = addBob.newState

    const bobActive = await joinGroup(
        addBob.welcome!,
        bob.publicPackage,
        bob.privatePackage,
        emptyPskIndex,
        impl,
        aliceGroup.ratchetTree,
        undefined,
        testClientConfig
    )

    // sent in the epoch before the ReInit, delivered after it
    const inFlight = await createApplicationMessage(
        aliceGroup,
        enc.encode('in flight'),
        impl
    )
    aliceGroup = inFlight.newState

    const newGroupId = enc.encode('new-group1')
    const reinitCommit = await reinitGroup(
        aliceGroup,
        newGroupId,
        'mls10',
        cipherSuite,
        [],
        impl
    )
    aliceGroup = reinitCommit.newState

    const processed = await processPrivateMessage(
        bobActive,
        asPrivate(reinitCommit.commit),
        makePskIndex(bobActive, {}),
        impl
    )
    const bobGroup:ClientState = processed.newState
    const suspension = bobGroup.groupActiveState
    t.equal(suspension.kind, 'suspendedPendingReinit',
        'bob is suspended after the ReInit')

    // the nonconforming sender: alice ignores her own suspension
    const rogue:ClientState = {
        ...aliceGroup,
        groupActiveState: { kind: 'active' }
    }

    const privateCommit = await createCommit(
        { state: rogue, cipherSuite: impl }
    )
    const privateCommitError = await refusal(() => processMessage(
        asFramed(privateCommit.commit),
        bobGroup,
        makePskIndex(bobGroup, {}),
        undefined,
        impl
    ))
    t.ok(privateCommitError instanceof ValidationError,
        'a private commit after the ReInit is refused')

    const publicCommit = await createCommit(
        { state: rogue, cipherSuite: impl },
        { wireAsPublicMessage: true }
    )
    const publicCommitError = await refusal(() => processMessage(
        asFramed(publicCommit.commit),
        bobGroup,
        makePskIndex(bobGroup, {}),
        undefined,
        impl
    ))
    t.ok(publicCommitError instanceof ValidationError,
        'a public commit after the ReInit is refused')

    t.deepEqual(bobGroup.groupActiveState, suspension,
        'bob stays suspended with the same ReInit parameters')

    const carol = await keyPackage('carol', impl)
    const addCarol = {
        proposalType: 'add' as const,
        add: { keyPackage: carol.publicPackage }
    }
    for (const publicMessage of [false, true]) {
        const proposal = await createProposal(
            rogue,
            publicMessage,
            addCarol,
            impl
        )
        const proposalError = await refusal(() => processMessage(
            asFramed(proposal.message),
            bobGroup,
            makePskIndex(bobGroup, {}),
            acceptAll,
            impl
        ))
        t.ok(proposalError instanceof ValidationError,
            `a ${publicMessage ? 'public' : 'private'} proposal after ` +
            'the ReInit is refused')
    }

    const atSuspendedEpoch = await createApplicationMessage(
        rogue,
        enc.encode('after the reinit'),
        impl
    )
    const applicationError = await refusal(() => processPrivateMessage(
        bobGroup,
        atSuspendedEpoch.privateMessage,
        makePskIndex(bobGroup, {}),
        impl
    ))
    t.ok(applicationError instanceof ValidationError,
        'an application message at the suspended epoch is refused')

    // the same input state survived every refusal above
    const historical = await processPrivateMessage(
        bobGroup,
        inFlight.privateMessage,
        makePskIndex(bobGroup, {}),
        impl
    )
    t.equal(historical.kind, 'applicationMessage',
        'a message from the epoch before the ReInit is delivered')
    if (historical.kind === 'applicationMessage') {
        t.equal(dec.decode(historical.message), 'in flight',
            'it decrypts to the original plaintext')
    }
    const bobAfter = historical.newState
    t.deepEqual(bobAfter.groupActiveState, suspension,
        'bob is still suspended with the same ReInit parameters')

    const sendError = await refusal(() => createApplicationMessage(
        bobAfter,
        enc.encode('bob speaks'),
        impl
    ))
    t.ok(sendError !== undefined, 'bob still cannot send on the old group')

    const aliceNew = await keyPackage('alice', impl)
    const bobNew = await keyPackage('bob', impl)
    const resumed = await reinitCreateNewGroup(
        aliceGroup,
        aliceNew.publicPackage,
        aliceNew.privatePackage,
        [bobNew.publicPackage],
        newGroupId,
        cipherSuite,
        []
    )
    const bobResumed = await joinGroupFromReinit(
        bobAfter,
        resumed.welcome!,
        bobNew.publicPackage,
        bobNew.privatePackage,
        resumed.newState.ratchetTree
    )
    t.equal(bobResumed.groupActiveState.kind, 'active',
        'bob joins the new group from the ReInit')
    t.ok(bobResumed.groupContext.epoch === resumed.newState.groupContext.epoch,
        'bob and alice agree on the new group epoch')
}
