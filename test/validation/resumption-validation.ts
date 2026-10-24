import { test } from '@substrate-system/tapzero'
import { skipReason } from '../helpers/skip.js'
import type { ClientState } from '../../src/client-state.js'
import { createGroup, joinGroup, makePskIndex } from '../../src/client-state.js'
import { createCommit } from '../../src/create-commit.js'
import { emptyPskIndex } from '../../src/psk-index.js'
import {
    joinGroupFromReinit,
    makeResumptionPsk,
    reinitCreateNewGroup,
    reinitGroup
} from '../../src/resumption.js'
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
import type { Proposal, ProposalAdd } from '../../src/proposal.js'
import { constantTimeEqual } from '../../src/util/constant-time-compare.js'
import { defaultLifetime } from '../../src/lifetime.js'
import { defaultCapabilities } from '../../src/default-capabilities.js'
import { processMessage } from '../../src/process-messages.js'
import { acceptAll } from '../../src/incoming-message-action.js'
import { testCiphersuites } from '../helpers/suite-filter.js'

import type { ProtocolVersionName } from '../../src/protocol-version.js'
import { ValidationError } from '../../src/mls-error.js'
import { testClientConfig } from '../helpers/client-config.js'

// Convert test.concurrent.each to individual tests
for (const cs of testCiphersuites()) {
    test(`Reinit Validation - ${cs}`, async (t) => {
        try {
            const cipherSuite = cs as CiphersuiteName
            const impl = await getCipherSuite(getCiphersuiteFromName(cipherSuite))

            const aliceCredential:Credential = {
                credentialType: 'basic',
                identity: new TextEncoder().encode('alice')
            }
            const alice = await generateKeyPackage(
                aliceCredential,
                defaultCapabilities(),
                defaultLifetime(),
                [],
                impl
            )

            const groupId = new TextEncoder().encode('group1')

            let aliceGroup = await createGroup(
                groupId,
                alice.publicPackage,
                alice.privatePackage,
                [],
                impl,
                testClientConfig
            )

            const bobCredential:Credential = {
                credentialType: 'basic',
                identity: new TextEncoder().encode('bob')
            }
            const bob = await generateKeyPackage(
                bobCredential,
                defaultCapabilities(),
                defaultLifetime(),
                [],
                impl
            )

            const addBobProposal:ProposalAdd = {
                proposalType: 'add',
                add: {
                    keyPackage: bob.publicPackage,
                },
            }

            const commitResult = await createCommit(
                {
                    state: aliceGroup,
                    cipherSuite: impl,
                },
                { extraProposals: [addBobProposal] },
            )

            aliceGroup = commitResult.newState

            let bobGroup = await joinGroup(
                commitResult.welcome!,
                bob.publicPackage,
                bob.privatePackage,
                emptyPskIndex,
                impl,
                aliceGroup.ratchetTree,
                undefined,
                testClientConfig
            )

            const bobCommitResult = await createCommit({
                state: bobGroup,
                cipherSuite: impl,
            })

            bobGroup = bobCommitResult.newState

            if (bobCommitResult.commit.wireformat !== 'mls_private_message') throw new Error('Expected private message')

            const processBobCommitResult = await processMessage(
                bobCommitResult.commit,
                aliceGroup,
                emptyPskIndex,
                acceptAll,
                impl,
            )

            aliceGroup = processBobCommitResult.newState

            const bobNewKeyPackage = await generateKeyPackage(
                bobCredential,
                defaultCapabilities(),
                defaultLifetime(),
                [],
                impl
            )

            const aliceNewKeyPackage = await generateKeyPackage(
                aliceCredential,
                defaultCapabilities(),
                defaultLifetime(),
                [],
                impl
            )

            const newGroupId = new TextEncoder().encode('new-group1')

            const reinitCommitResult = await reinitGroup(aliceGroup, newGroupId, 'mls10', cipherSuite, [], impl)

            aliceGroup = reinitCommitResult.newState

            if (reinitCommitResult.commit.wireformat !== 'mls_private_message') throw new Error('Expected private message')

            const processReinitResult = await processMessage(
                reinitCommitResult.commit,
                bobGroup,
                makePskIndex(bobGroup, {}),
                acceptAll,
                impl,
            )

            bobGroup = processReinitResult.newState

            t.equal(bobGroup.groupActiveState.kind, 'suspendedPendingReinit', 'bobGroup should be suspendedPendingReinit')
            t.equal(aliceGroup.groupActiveState.kind, 'suspendedPendingReinit', 'aliceGroup should be suspendedPendingReinit')

            const resumeGroupResult = await reinitCreateNewGroup(
                aliceGroup,
                aliceNewKeyPackage.publicPackage,
                aliceNewKeyPackage.privatePackage,
                [bobNewKeyPackage.publicPackage],
                newGroupId,
                cipherSuite,
                [],
            )

            aliceGroup = resumeGroupResult.newState

            const reinit =
                bobGroup.groupActiveState.kind === 'suspendedPendingReinit' ? bobGroup.groupActiveState.reinit : undefined

            const bobGroupIdChanged:ClientState = {
                ...bobGroup,
                groupActiveState: {
                    kind: 'suspendedPendingReinit',
                    reinit: { ...reinit!, groupId: new TextEncoder().encode('group-bad') },
                },
            }

            try {
                await joinGroupFromReinit(
                    bobGroupIdChanged,
                    resumeGroupResult.welcome!,
                    bobNewKeyPackage.publicPackage,
                    bobNewKeyPackage.privatePackage,
                    aliceGroup.ratchetTree,
                )
                t.fail('should have thrown ValidationError for groupId change')
            } catch (error) {
                t.ok(error instanceof ValidationError, 'should throw ValidationError when groupId is changed')
            }

            const bobVersionChanged:ClientState = {
                ...bobGroup,
                groupActiveState: {
                    kind: 'suspendedPendingReinit',
                    reinit: { ...reinit!, version: 'mls2' as ProtocolVersionName },
                },
            }

            try {
                await joinGroupFromReinit(
                    bobVersionChanged,
                    resumeGroupResult.welcome!,
                    bobNewKeyPackage.publicPackage,
                    bobNewKeyPackage.privatePackage,
                    aliceGroup.ratchetTree,
                )
                t.fail('should have thrown ValidationError for version change')
            } catch (error) {
                t.ok(error instanceof ValidationError, 'should throw ValidationError when version is changed')
            }

            const bobExtensionsChanged:ClientState = {
                ...bobGroup,
                groupActiveState: {
                    kind: 'suspendedPendingReinit',
                    reinit: { ...reinit!, extensions: [{ extensionType: 17, extensionData: new Uint8Array([1]) }] },
                },
            }

            try {
                await joinGroupFromReinit(
                    bobExtensionsChanged,
                    resumeGroupResult.welcome!,
                    bobNewKeyPackage.publicPackage,
                    bobNewKeyPackage.privatePackage,
                    aliceGroup.ratchetTree,
                )
                t.fail('should have thrown ValidationError for extensions change')
            } catch (error) {
                t.ok(error instanceof ValidationError, 'should throw ValidationError when extensions are changed')
            }
        } catch (error:any) {
            // Skip ciphersuites not supported in the current environment (e.g., X448/Ed448 in browsers)
            if (error?.name === 'NotSupportedError' || error?.name === 'DependencyError' || error?.name === 'CryptoError' || error?.name === 'DeriveKeyPairError' || error?.message?.includes('SubtleCrypto') || error?.message?.includes('Unrecognized name')) {
                t.comment(`Skipping ${cs}: ${skipReason(error)}`)
                return
            }
            throw error
        }
    })
}

const enc = (s:string) => new TextEncoder().encode(s)
const nonZero = (key:Uint8Array) => key.some((b) => b !== 0)

function isUnsupported (error:any):boolean {
    return error?.name === 'NotSupportedError' ||
        error?.name === 'DependencyError' ||
        error?.name === 'CryptoError' ||
        error?.name === 'DeriveKeyPairError' ||
        error?.message?.includes('SubtleCrypto') ||
        error?.message?.includes('Unrecognized name')
}

async function freshPackage (name:string, impl:CiphersuiteImpl) {
    const credential:Credential = {
        credentialType: 'basic',
        identity: enc(name),
    }
    return generateKeyPackage(
        credential,
        defaultCapabilities(),
        defaultLifetime(),
        [],
        impl
    )
}

/**
 * Alice and Bob in one group, then a ReInit to `new-group1`, processed by
 * both. Returns both suspended states.
 */
async function suspendedPair (
    cipherSuite:CiphersuiteName,
    impl:CiphersuiteImpl,
) {
    const alice = await freshPackage('alice', impl)
    const bob = await freshPackage('bob', impl)
    const aliceGroup = await createGroup(
        enc('group1'),
        alice.publicPackage,
        alice.privatePackage,
        [],
        impl,
        testClientConfig
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
        testClientConfig
    )
    const reinit = await reinitGroup(
        add.newState, enc('new-group1'), 'mls10', cipherSuite, [], impl)
    if (reinit.commit.wireformat !== 'mls_private_message') {
        throw new Error('Expected private message')
    }
    const processed = await processMessage(
        reinit.commit,
        bobGroup,
        makePskIndex(bobGroup, {}),
        acceptAll,
        impl,
    )
    return {
        aliceSuspended: reinit.newState,
        bobSuspended: processed.newState,
    }
}

function resumptionPsk (
    state:ClientState,
    usage:'branch'|'reinit'|'application',
    cs:CiphersuiteImpl,
):Proposal {
    return {
        proposalType: 'psk',
        psk: { preSharedKeyId: makeResumptionPsk(state, usage, cs).id },
    }
}

type PskList = (s:ClientState, cs:CiphersuiteImpl) => Proposal[]

// Each forged Welcome is Alice's new group, welcoming Bob's new
// KeyPackage with `psks` beside the Add. The unrelated one has a group id
// the ReInit never agreed on; the rest use the agreed one, so only the
// PSK list is wrong.
const forgedWelcomes:[string, string, PskList][] = [
    ['an ordinary Welcome to an unrelated group', 'unrelated', () => []],
    ['a Welcome whose only prior-state resumption PSK has branch usage',
        'new-group1', (s, cs) => [resumptionPsk(s, 'branch', cs)]],
    ['a Welcome carrying only an application-usage resumption PSK',
        'new-group1', (s, cs) => [resumptionPsk(s, 'application', cs)]],
    ['a Welcome carrying a ReInit and a branch resumption PSK',
        'new-group1', (s, cs) => [
            resumptionPsk(s, 'reinit', cs),
            resumptionPsk(s, 'branch', cs),
        ]],
    ['a Welcome carrying two ReInit resumption PSKs',
        'new-group1', (s, cs) => [
            resumptionPsk(s, 'reinit', cs),
            resumptionPsk(s, 'reinit', cs),
        ]],
]

/** Alice's new group `groupId`, welcoming `bobNew` with `psks` beside. */
async function forgeWelcome (
    aliceSuspended:ClientState,
    aliceNew:Awaited<ReturnType<typeof freshPackage>>,
    bobNew:Awaited<ReturnType<typeof freshPackage>>,
    groupId:string,
    psks:Proposal[],
    impl:CiphersuiteImpl,
) {
    const newGroup = await createGroup(
        enc(groupId),
        aliceNew.publicPackage,
        aliceNew.privatePackage,
        [],
        impl,
        testClientConfig
    )
    return createCommit(
        {
            state: newGroup,
            pskIndex: makePskIndex(aliceSuspended, {}),
            cipherSuite: impl,
        },
        {
            extraProposals: [
                {
                    proposalType: 'add',
                    add: { keyPackage: bobNew.publicPackage },
                },
                ...psks,
            ],
        },
    )
}

for (const cs of testCiphersuites()) {
    test(`joinGroupFromReinit needs one ReInit PSK - ${cs}`, async (t) => {
        try {
            const cipherSuite = cs as CiphersuiteName
            const impl = await getCipherSuite(
                getCiphersuiteFromName(cipherSuite))
            const { aliceSuspended, bobSuspended } =
                await suspendedPair(cipherSuite, impl)

            for (const [name, groupId, psks] of forgedWelcomes) {
                const aliceNew = await freshPackage('alice', impl)
                const bobNew = await freshPackage('bob', impl)
                const forged = await forgeWelcome(aliceSuspended, aliceNew,
                    bobNew, groupId, psks(aliceSuspended, impl), impl)

                try {
                    await joinGroupFromReinit(
                        bobSuspended,
                        forged.welcome!,
                        bobNew.publicPackage,
                        bobNew.privatePackage,
                        forged.newState.ratchetTree,
                    )
                    t.fail(`${name} was joined as the ReInit successor`)
                } catch (error) {
                    t.ok(error instanceof ValidationError,
                        `${name} is a ValidationError`)
                }

                t.ok(nonZero(bobNew.privatePackage.initPrivateKey),
                    'the refused join left the init private key intact')

                const honest = await reinitCreateNewGroup(
                    aliceSuspended,
                    aliceNew.publicPackage,
                    aliceNew.privatePackage,
                    [bobNew.publicPackage],
                    enc('new-group1'),
                    cipherSuite,
                    [],
                )
                const bobNewGroup = await joinGroupFromReinit(
                    bobSuspended,
                    honest.welcome!,
                    bobNew.publicPackage,
                    bobNew.privatePackage,
                    honest.newState.ratchetTree,
                )
                t.ok(constantTimeEqual(
                    bobNewGroup.groupContext.groupId,
                    enc('new-group1'),
                ), 'the honest ReInit Welcome joins with the same keys')
            }
        } catch (error:any) {
            if (isUnsupported(error)) {
                t.comment(`Skipping ${cs}: ${skipReason(error)}`)
                return
            }
            throw error
        }
    })
}
