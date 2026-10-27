import { test } from '@substrate-system/tapzero'
import { skipReason } from '../helpers/skip.js'
import type { ClientState } from '../../src/client-state.js'
import { createGroup, joinGroup, makePskIndex } from '../../src/client-state.js'
import { createCommit } from '../../src/create-commit.js'
import { processPrivateMessage } from '../../src/process-messages.js'
import { emptyPskIndex } from '../../src/psk-index.js'
import type { Credential } from '../../src/credential.js'
import type {
    CiphersuiteImpl,
    CiphersuiteName,
} from '../../src/crypto/ciphersuite.js'
import { getCiphersuiteFromName } from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import { generateKeyPackage } from '../../src/key-package.js'
import type { KeyPackage } from '../../src/key-package.js'
import { defaultLifetime } from '../../src/lifetime.js'
import type { Capabilities } from '../../src/capabilities.js'
import type { Extension } from '../../src/extension.js'
import type { Proposal } from '../../src/proposal.js'
import {
    encodeRequiredCapabilities,
} from '../../src/required-capabilities.js'
import { ValidationError } from '../../src/mls-error.js'
import { sampleCiphersuites } from '../helpers/suite-filter.js'
import { testClientConfig } from '../helpers/client-config.js'
import { testEveryoneCanMessageEveryone } from './common.js'

// RFC 9420 12.3: a commit's GroupContextExtensions proposal is applied
// before its Adds, so an added leaf is checked against the requirement
// the commit installs, not the one it replaces.

const EXT_A = 8
const EXT_B = 9

for (const cs of sampleCiphersuites()) {
    test('GCE requiring B with an Add of a B-only member is accepted ' +
        'by everyone ' + cs, async (t) => {
        await skipping(t, cs, async (impl) => {
            const { alice, bob } = await twoMemberGroup(impl, cs)
            const charlie = await keyPackage('charlie', [EXT_B], impl, cs)

            await commitAndEveryoneAdvances(t, impl, alice, bob, charlie, [
                requiredCapabilities([EXT_B]),
            ])
        })
    })

    test('GCE removing required_capabilities with an Add of a member ' +
        'without A is accepted by everyone ' + cs, async (t) => {
        await skipping(t, cs, async (impl) => {
            const { alice, bob } = await twoMemberGroup(impl, cs)
            const charlie = await keyPackage('charlie', [], impl, cs)

            await commitAndEveryoneAdvances(t, impl, alice, bob, charlie, [])
        })
    })

    test('GCE requiring B with an Add of an A-only member is refused ' +
        'by the committer ' + cs, async (t) => {
        await skipping(t, cs, async (impl) => {
            const { alice } = await twoMemberGroup(impl, cs)
            const charlie = await keyPackage('charlie', [EXT_A], impl, cs)
            const epoch = alice.groupContext.epoch

            let error:unknown
            try {
                await createCommit({ state: alice, cipherSuite: impl }, {
                    extraProposals: [
                        gce([requiredCapabilities([EXT_B])]),
                        add(charlie.publicPackage),
                    ],
                })
            } catch (err) {
                error = err
            }

            t.ok(error instanceof ValidationError,
                'the commit is refused with a ValidationError')
            t.equal(alice.groupContext.epoch, epoch,
                'the state passed in stays in its epoch')

            // the state passed in is still usable: an empty commit goes
            // through
            const next = await createCommit({ state: alice, cipherSuite: impl })
            t.equal(next.newState.groupContext.epoch, epoch + 1n,
                'the state passed in can still commit')
        })
    })
}

async function commitAndEveryoneAdvances (
    t:any,
    impl:CiphersuiteImpl,
    alice:ClientState,
    bob:ClientState,
    charlie:Awaited<ReturnType<typeof keyPackage>>,
    newExtensions:Extension[],
):Promise<void> {
    const result = await createCommit({ state: alice, cipherSuite: impl }, {
        extraProposals: [
            gce(newExtensions),
            add(charlie.publicPackage),
        ],
    })

    if (result.commit.wireformat !== 'mls_private_message') {
        throw new Error('Expected private message')
    }

    const bobResult = await processPrivateMessage(
        bob,
        result.commit.privateMessage,
        makePskIndex(bob, {}),
        impl,
    )
    if (bobResult.kind !== 'newState') throw new Error('Expected new state')

    const charlieGroup = await joinGroup(
        result.welcome!,
        charlie.publicPackage,
        charlie.privatePackage,
        emptyPskIndex,
        impl,
        result.newState.ratchetTree,
        undefined,
        testClientConfig,
    )

    const states = [result.newState, bobResult.newState, charlieGroup]
    const epoch = alice.groupContext.epoch + 1n
    t.ok(states.every((s) => s.groupContext.epoch === epoch),
        'every member reaches the next epoch')
    t.deepEqual(
        bobResult.newState.keySchedule.epochAuthenticator,
        result.newState.keySchedule.epochAuthenticator,
        'bob agrees with alice')
    t.deepEqual(
        charlieGroup.keySchedule.epochAuthenticator,
        result.newState.keySchedule.epochAuthenticator,
        'charlie agrees with alice')

    await testEveryoneCanMessageEveryone(states, impl, t)
}

async function twoMemberGroup (
    impl:CiphersuiteImpl,
    cs:CiphersuiteName,
):Promise<{ alice:ClientState; bob:ClientState }> {
    const alice = await keyPackage('alice', [EXT_A, EXT_B], impl, cs)
    const bob = await keyPackage('bob', [EXT_A, EXT_B], impl, cs)

    const created = await createGroup(
        new TextEncoder().encode('gce-before-add'),
        alice.publicPackage,
        alice.privatePackage,
        [requiredCapabilities([EXT_A])],
        impl,
        testClientConfig,
    )

    const added = await createCommit({ state: created, cipherSuite: impl }, {
        extraProposals: [
            add(bob.publicPackage),
        ],
    })

    const bobGroup = await joinGroup(
        added.welcome!,
        bob.publicPackage,
        bob.privatePackage,
        emptyPskIndex,
        impl,
        added.newState.ratchetTree,
        undefined,
        testClientConfig,
    )

    return { alice: added.newState, bob: bobGroup }
}

function keyPackage (
    name:string,
    extensions:number[],
    impl:CiphersuiteImpl,
    cs:CiphersuiteName,
) {
    const credential:Credential = {
        credentialType: 'basic',
        identity: new TextEncoder().encode(name),
    }
    const capabilities:Capabilities = {
        extensions,
        credentials: ['basic'],
        proposals: [],
        versions: ['mls10'],
        ciphersuites: [cs],
    }
    return generateKeyPackage(
        credential,
        capabilities,
        defaultLifetime(),
        [],
        impl,
    )
}

function requiredCapabilities (extensionTypes:number[]):Extension {
    return {
        extensionType: 'required_capabilities',
        extensionData: encodeRequiredCapabilities({
            extensionTypes,
            credentialTypes: ['basic'],
            proposalTypes: [],
        }),
    }
}

function gce (extensions:Extension[]):Proposal {
    return {
        proposalType: 'group_context_extensions',
        groupContextExtensions: { extensions },
    }
}

async function skipping (
    t:any,
    cs:CiphersuiteName,
    body:(impl:CiphersuiteImpl) => Promise<void>,
):Promise<void> {
    try {
        const impl = await getCipherSuite(getCiphersuiteFromName(cs))
        await body(impl)
    } catch (error:any) {
        // Skip ciphersuites not supported in the current environment
        if (error?.name === 'NotSupportedError' ||
            error?.name === 'DependencyError') {
            t.comment(`Skipping ${cs}: ${skipReason(error)}`)
            return
        }
        throw error
    }
}

function add (keyPackage:KeyPackage):Proposal {
    return { proposalType: 'add', add: { keyPackage } }
}
