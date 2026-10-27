import { test } from '@substrate-system/tapzero'
import { skipReason } from '../helpers/skip.js'
import { createGroup, joinGroup } from '../../src/client-state.js'
import type { ClientState } from '../../src/client-state.js'
import { createCommit } from '../../src/create-commit.js'
import { createProposal } from '../../src/create-message.js'
import { processMessage } from '../../src/process-messages.js'
import { acceptAll } from '../../src/incoming-message-action.js'
import { emptyPskIndex } from '../../src/psk-index.js'
import type {
    CiphersuiteImpl,
    CiphersuiteName,
} from '../../src/crypto/ciphersuite.js'
import { getCiphersuiteFromName } from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import type { Capabilities } from '../../src/capabilities.js'
import { generateKeyPackage } from '../../src/key-package.js'
import type { MLSMessage } from '../../src/message.js'
import type { Proposal } from '../../src/proposal.js'
import { defaultLifetime } from '../../src/lifetime.js'
import {
    encodeRequiredCapabilities
} from '../../src/required-capabilities.js'
import { testEveryoneCanMessageEveryone } from './common.js'
import { testCiphersuites } from '../helpers/suite-filter.js'
import { testClientConfig } from '../helpers/client-config.js'

// Ported from upstream ts-mls (60b737b): one commit raises the group's
// required capabilities and removes the member who cannot meet them. The
// requirement holds for the group the commit leaves behind, so a
// remaining member has to process it, whether the proposals arrive by
// value inside the commit or by reference beforehand.

for (const cs of testCiphersuites()) {
    test('a remaining member processes a GroupContextExtensions commit ' +
        'with a Remove, by value - ' + cs, async (t) => {
        const fx = await fixtureOrSkip(t, cs)
        if (fx === undefined) return
        const { impl } = fx

        const commit = await createCommit(
            { state: fx.alice, cipherSuite: impl },
            { extraProposals: [requireExtensions(), removeCharlie(fx)] },
        )
        await remainingMembersFollow(t, fx, commit.newState, commit.commit)
    })

    test('a remaining member processes a GroupContextExtensions commit ' +
        'with a Remove, by reference - ' + cs, async (t) => {
        const fx = await fixtureOrSkip(t, cs)
        if (fx === undefined) return
        const { impl } = fx

        let { alice, bob, charlie } = fx
        for (const proposal of [requireExtensions(), removeCharlie(fx)]) {
            const sent = await createProposal(alice, false, proposal, impl)
            alice = sent.newState
            bob = await receive(bob, sent.message, impl)
            charlie = await receive(charlie, sent.message, impl)
        }

        const commit = await createCommit(
            { state: alice, cipherSuite: impl },
            {},
        )
        await remainingMembersFollow(t, { ...fx, bob, charlie },
            commit.newState, commit.commit)
    })
}

interface Fixture {
    impl:CiphersuiteImpl;
    alice:ClientState;
    bob:ClientState;
    // supports none of the extensions the commit goes on to require
    charlie:ClientState;
}

const REQUIRED_EXTENSIONS = [7, 8]

function requireExtensions ():Proposal {
    return {
        proposalType: 'group_context_extensions',
        groupContextExtensions: {
            extensions: [{
                extensionType: 'required_capabilities',
                extensionData: encodeRequiredCapabilities({
                    extensionTypes: REQUIRED_EXTENSIONS,
                    credentialTypes: [],
                    proposalTypes: [],
                }),
            }],
        },
    }
}

function removeCharlie (fx:Fixture):Proposal {
    return {
        proposalType: 'remove',
        remove: { removed: fx.charlie.privatePath.leafIndex },
    }
}

/**
 * Bob processes the commit into alice's new epoch, charlie learns he
 * has been removed, and the two who remain can still message.
 */
async function remainingMembersFollow (
    t:any,
    fx:Fixture,
    alice:ClientState,
    commit:MLSMessage,
):Promise<void> {
    t.ok(alice.groupContext.extensions.some((e) =>
        e.extensionType === 'required_capabilities'),
    'the commit raised the group\'s required capabilities')

    const bob = await receive(fx.bob, commit, fx.impl)
    t.equal(bob.groupContext.epoch, alice.groupContext.epoch,
        'the remaining member reaches the committer\'s epoch')
    t.deepEqual(bob.groupContext.extensions, alice.groupContext.extensions,
        'the remaining member holds the new group context extensions')

    const charlie = await receive(fx.charlie, commit, fx.impl)
    t.equal(charlie.groupActiveState.kind, 'removedFromGroup',
        'the removed member learns of the removal')

    await testEveryoneCanMessageEveryone([alice, bob], fx.impl, t)
}

/**
 * Alice, bob and charlie in one group with no requirements yet; or
 * undefined after reporting a skip when the environment lacks one of
 * the ciphersuite's primitives. Only setup runs under the skip.
 */
async function fixtureOrSkip (
    t:any,
    cs:CiphersuiteName,
):Promise<Fixture | undefined> {
    let impl:CiphersuiteImpl
    try {
        impl = await getCipherSuite(getCiphersuiteFromName(cs))
        await member('probe', capabilities(cs, []), impl)
    } catch (error:any) {
        if (error?.name === 'NotSupportedError' ||
            error?.name === 'DependencyError') {
            t.comment(`Skipping ${cs}: ${skipReason(error)}`)
            return undefined
        }
        throw error
    }

    const full = capabilities(cs, [...REQUIRED_EXTENSIONS, 9])
    const a = await member('alice', full, impl)
    const b = await member('bob', full, impl)
    const c = await member('charlie', capabilities(cs, []), impl)

    const solo = await createGroup(new TextEncoder().encode('group'),
        a.publicPackage, a.privatePackage, [], impl, testClientConfig)
    const add = await createCommit(
        { state: solo, cipherSuite: impl },
        {
            extraProposals: [b, c].map((m) => ({
                proposalType: 'add' as const,
                add: { keyPackage: m.publicPackage },
            })),
            ratchetTreeExtension: true,
        },
    )
    const join = (m:typeof b) => joinGroup(add.welcome!, m.publicPackage,
        m.privatePackage, emptyPskIndex, impl, undefined, undefined,
        testClientConfig)

    return {
        impl,
        alice: add.newState,
        bob: await join(b),
        charlie: await join(c),
    }
}

function capabilities (cs:CiphersuiteName, extensions:number[]):Capabilities {
    return {
        extensions,
        credentials: ['basic'],
        proposals: [],
        versions: ['mls10'],
        ciphersuites: [cs],
    }
}

async function member (
    name:string,
    caps:Capabilities,
    impl:CiphersuiteImpl,
) {
    return generateKeyPackage(
        { credentialType: 'basic', identity: new TextEncoder().encode(name) },
        caps,
        defaultLifetime(),
        [],
        impl,
    )
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
