import { test } from '@substrate-system/tapzero'
import type { ClientState } from '../../src/client-state.js'
import {
    createGroup,
    joinGroup,
    makePskIndex
} from '../../src/client-state.js'
import type { ClientConfig } from '../../src/client-config.js'
import { createCommit } from '../../src/create-commit.js'
import { emptyPskIndex } from '../../src/psk-index.js'
import {
    branchGroup,
    joinGroupFromBranch,
    makeResumptionPsk
} from '../../src/resumption.js'
import type { Credential } from '../../src/credential.js'
import type {
    CiphersuiteImpl,
    CiphersuiteName
} from '../../src/crypto/ciphersuite.js'
import { getCiphersuiteFromName } from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import type { KeyPackage, PrivateKeyPackage } from '../../src/key-package.js'
import { generateKeyPackage } from '../../src/key-package.js'
import type { Proposal } from '../../src/proposal.js'
import type { ProtocolVersionName } from '../../src/protocol-version.js'
import { defaultLifetime } from '../../src/lifetime.js'
import { defaultCapabilities } from '../../src/default-capabilities.js'
import { constantTimeEqual } from '../../src/util/constant-time-compare.js'
import { UsageError, ValidationError } from '../../src/mls-error.js'
import { testClientConfig } from '../helpers/client-config.js'
import { sameSignerKeyPackage } from '../helpers/same-signer-key-package.js'
import { testEveryoneCanMessageEveryone } from '../scenario/common.js'

// Branch validation does not depend on the suite, and the ciphersuite
// check needs two suites that share a signature scheme.
const SUITE:CiphersuiteName = 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519'
const OTHER:CiphersuiteName =
    'MLS_128_DHKEMX25519_CHACHA20POLY1305_SHA256_Ed25519'

const enc = (s:string) => new TextEncoder().encode(s)

interface Member {
    credential:Credential
    publicPackage:KeyPackage
    privatePackage:PrivateKeyPackage
}

async function member (name:string, cs:CiphersuiteImpl):Promise<Member> {
    const credential:Credential = {
        credentialType: 'basic',
        identity: enc(name),
    }
    const kp = await generateKeyPackage(
        credential,
        defaultCapabilities(),
        defaultLifetime(),
        [],
        cs
    )
    return { credential, ...kp }
}

/** Alice and Bob in one group, both states returned. */
async function aliceAndBob (cs:CiphersuiteImpl, config:ClientConfig) {
    const alice = await member('alice', cs)
    const bob = await member('bob', cs)
    const aliceGroup = await createGroup(
        enc('group1'),
        alice.publicPackage,
        alice.privatePackage,
        [],
        cs,
        config
    )
    const commit = await createCommit(
        { state: aliceGroup, cipherSuite: cs },
        {
            extraProposals: [{
                proposalType: 'add',
                add: { keyPackage: bob.publicPackage },
            }],
        },
    )
    const bobGroup = await joinGroup(
        commit.welcome!,
        bob.publicPackage,
        bob.privatePackage,
        emptyPskIndex,
        cs,
        commit.newState.ratchetTree,
        undefined,
        config
    )
    return { alice, bob, aliceGroup: commit.newState, bobGroup }
}

function resign (m:Member, cs:CiphersuiteImpl) {
    return sameSignerKeyPackage(
        m.credential,
        m.publicPackage.leafNode.signaturePublicKey,
        m.privatePackage.signaturePrivateKey,
        cs
    )
}

async function rejects (
    t:any,
    run:() => Promise<ClientState>,
    msg:string
) {
    try {
        await run()
        t.fail(msg)
    } catch (err) {
        t.ok(err instanceof ValidationError, msg)
    }
}

test('branch Welcome under a different ciphersuite is rejected', async t => {
    const impl = await getCipherSuite(getCiphersuiteFromName(SUITE))
    const other = await getCipherSuite(getCiphersuiteFromName(OTHER))
    const { alice, bob, aliceGroup, bobGroup } =
        await aliceAndBob(impl, testClientConfig)

    const aliceNew = await resign(alice, other)
    const bobNew = await resign(bob, other)
    const branch = await branchGroup(
        aliceGroup,
        aliceNew.publicPackage,
        aliceNew.privatePackage,
        [bobNew.publicPackage],
        enc('branch'),
        other,
    )

    await rejects(t, () => joinGroupFromBranch(
        bobGroup,
        branch.welcome!,
        bobNew.publicPackage,
        bobNew.privatePackage,
        branch.newState.ratchetTree,
        other,
    ), 'ciphersuite mismatch is a ValidationError')
})

test('branch Welcome under a different version is rejected', async t => {
    const impl = await getCipherSuite(getCiphersuiteFromName(SUITE))
    const { alice, bob, aliceGroup, bobGroup } =
        await aliceAndBob(impl, testClientConfig)

    const aliceNew = await resign(alice, impl)
    const bobNew = await resign(bob, impl)
    const branch = await branchGroup(
        aliceGroup,
        aliceNew.publicPackage,
        aliceNew.privatePackage,
        [bobNew.publicPackage],
        enc('branch'),
        impl,
    )

    const bobOtherVersion:ClientState = {
        ...bobGroup,
        groupContext: {
            ...bobGroup.groupContext,
            version: 'mls2' as ProtocolVersionName,
        },
    }

    await rejects(t, () => joinGroupFromBranch(
        bobOtherVersion,
        branch.welcome!,
        bobNew.publicPackage,
        bobNew.privatePackage,
        branch.newState.ratchetTree,
        impl,
    ), 'version mismatch is a ValidationError')
})

test('branch Welcome adding a stranger is rejected', async t => {
    const impl = await getCipherSuite(getCiphersuiteFromName(SUITE))
    const { alice, bob, aliceGroup, bobGroup } =
        await aliceAndBob(impl, testClientConfig)

    const aliceNew = await resign(alice, impl)
    const bobNew = await resign(bob, impl)
    const mallory = await member('mallory', impl)
    const branch = await branchGroup(
        aliceGroup,
        aliceNew.publicPackage,
        aliceNew.privatePackage,
        [bobNew.publicPackage, mallory.publicPackage],
        enc('branch'),
        impl,
    )

    await rejects(t, () => joinGroupFromBranch(
        bobGroup,
        branch.welcome!,
        bobNew.publicPackage,
        bobNew.privatePackage,
        branch.newState.ratchetTree,
        impl,
    ), 'a member with no match in the old group is a ValidationError')
})

test('branch Welcome with two resumption PSKs is rejected', async t => {
    const impl = await getCipherSuite(getCiphersuiteFromName(SUITE))
    const { alice, bob, aliceGroup, bobGroup } =
        await aliceAndBob(impl, testClientConfig)

    const aliceNew = await resign(alice, impl)
    const bobNew = await resign(bob, impl)
    const newGroup = await createGroup(
        enc('branch'),
        aliceNew.publicPackage,
        aliceNew.privatePackage,
        [],
        impl,
        testClientConfig
    )
    const psk = ():Proposal => ({
        proposalType: 'psk',
        psk: {
            preSharedKeyId: makeResumptionPsk(aliceGroup, 'branch', impl).id,
        },
    })
    const branch = await createCommit(
        {
            state: newGroup,
            pskIndex: makePskIndex(aliceGroup, {}),
            cipherSuite: impl,
        },
        {
            extraProposals: [
                {
                    proposalType: 'add',
                    add: { keyPackage: bobNew.publicPackage },
                },
                psk(),
                psk(),
            ],
        },
    )

    await rejects(t, () => joinGroupFromBranch(
        bobGroup,
        branch.welcome!,
        bobNew.publicPackage,
        bobNew.privatePackage,
        branch.newState.ratchetTree,
        impl,
    ), 'two resumption PSKs is a ValidationError')
})

test('honest branch with the default equality config', async t => {
    const impl = await getCipherSuite(getCiphersuiteFromName(SUITE))
    const { alice, bob, aliceGroup, bobGroup } =
        await aliceAndBob(impl, testClientConfig)

    const aliceNew = await resign(alice, impl)
    const bobNew = await resign(bob, impl)
    const branch = await branchGroup(
        aliceGroup,
        aliceNew.publicPackage,
        aliceNew.privatePackage,
        [bobNew.publicPackage],
        enc('branch'),
        impl,
    )
    const bobBranch = await joinGroupFromBranch(
        bobGroup,
        branch.welcome!,
        bobNew.publicPackage,
        bobNew.privatePackage,
        branch.newState.ratchetTree,
        impl,
    )
    await testEveryoneCanMessageEveryone([branch.newState, bobBranch], impl, t)
})

test('honest branch with a custom equality config', async t => {
    const impl = await getCipherSuite(getCiphersuiteFromName(SUITE))
    // "the same member" is the same credential identity, so members may
    // rotate signature keys when they branch
    const sameIdentity = (a:Credential, b:Credential) =>
        a.credentialType === 'basic' && b.credentialType === 'basic' &&
        constantTimeEqual(a.identity, b.identity)
    const config:ClientConfig = {
        ...testClientConfig,
        keyPackageEqualityConfig: {
            compareKeyPackages: (a, b) =>
                sameIdentity(a.leafNode.credential, b.leafNode.credential),
            compareKeyPackageToLeafNode: (a, b) =>
                sameIdentity(a.leafNode.credential, b.credential),
            compareLeafNodes: (a, b) =>
                sameIdentity(a.credential, b.credential),
        },
    }
    const { aliceGroup, bobGroup } = await aliceAndBob(impl, config)

    const aliceNew = await member('alice', impl)
    const bobNew = await member('bob', impl)
    const branch = await branchGroup(
        aliceGroup,
        aliceNew.publicPackage,
        aliceNew.privatePackage,
        [bobNew.publicPackage],
        enc('branch'),
        impl,
    )
    const bobBranch = await joinGroupFromBranch(
        bobGroup,
        branch.welcome!,
        bobNew.publicPackage,
        bobNew.privatePackage,
        branch.newState.ratchetTree,
        impl,
    )
    await testEveryoneCanMessageEveryone([branch.newState, bobBranch], impl, t)
})

type Packages = Pick<Member, 'publicPackage' | 'privatePackage'>

/** Alice's new group for a branch, Welcoming `bob` with `psks` beside. */
async function welcomeWithPsks (
    aliceGroup:ClientState,
    aliceNew:Packages,
    bobNew:Packages,
    psks:Proposal[],
    groupId:string,
    cs:CiphersuiteImpl,
) {
    const newGroup = await createGroup(
        enc(groupId),
        aliceNew.publicPackage,
        aliceNew.privatePackage,
        [],
        cs,
        testClientConfig
    )
    return createCommit(
        {
            state: newGroup,
            pskIndex: makePskIndex(aliceGroup, {}),
            cipherSuite: cs,
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

const nonZero = (key:Uint8Array) => key.some((b) => b !== 0)

/**
 * After a refused Welcome, Bob's key material is intact and the honest
 * branch Welcome for the same KeyPackage joins.
 */
async function honestBranchStillJoins (
    t:any,
    aliceGroup:ClientState,
    bobGroup:ClientState,
    aliceNew:Packages,
    bobNew:Packages,
    cs:CiphersuiteImpl,
) {
    t.ok(nonZero(bobNew.privatePackage.initPrivateKey),
        'the refused join left the init private key intact')
    const branch = await branchGroup(
        aliceGroup,
        aliceNew.publicPackage,
        aliceNew.privatePackage,
        [bobNew.publicPackage],
        enc('branch'),
        cs,
    )
    const bobBranch = await joinGroupFromBranch(
        bobGroup,
        branch.welcome!,
        bobNew.publicPackage,
        bobNew.privatePackage,
        branch.newState.ratchetTree,
        cs,
    )
    t.ok(constantTimeEqual(bobBranch.groupContext.groupId, enc('branch')),
        'the honest branch Welcome joins with the same key material')
}

test('an ordinary Welcome to an unrelated group is not a branch', async t => {
    const impl = await getCipherSuite(getCiphersuiteFromName(SUITE))
    const { alice, bob, aliceGroup, bobGroup } =
        await aliceAndBob(impl, testClientConfig)

    const aliceNew = await resign(alice, impl)
    const bobNew = await resign(bob, impl)
    const unrelated = await welcomeWithPsks(
        aliceGroup, aliceNew, bobNew, [], 'unrelated', impl)

    await rejects(t, () => joinGroupFromBranch(
        bobGroup,
        unrelated.welcome!,
        bobNew.publicPackage,
        bobNew.privatePackage,
        unrelated.newState.ratchetTree,
        impl,
    ), 'a Welcome with no resumption PSK is a ValidationError')

    await honestBranchStillJoins(
        t, aliceGroup, bobGroup, aliceNew, bobNew, impl)
})

type PskList = (s:ClientState, cs:CiphersuiteImpl) => Proposal[]

const wrongPskLists:[string, PskList][] = [
    ['whose only prior-state resumption PSK has ReInit usage',
        (s, cs) => [resumptionPsk(s, 'reinit', cs)]],
    ['carrying only an application-usage resumption PSK',
        (s, cs) => [resumptionPsk(s, 'application', cs)]],
    ['carrying two resumption PSKs that require prior state',
        (s, cs) => [
            resumptionPsk(s, 'branch', cs),
            resumptionPsk(s, 'reinit', cs),
        ]],
]

for (const [name, psks] of wrongPskLists) {
    test(`a Welcome ${name} is not a branch`, async t => {
        const impl = await getCipherSuite(getCiphersuiteFromName(SUITE))
        const { alice, bob, aliceGroup, bobGroup } =
            await aliceAndBob(impl, testClientConfig)

        const aliceNew = await resign(alice, impl)
        const bobNew = await resign(bob, impl)
        const forged = await welcomeWithPsks(aliceGroup, aliceNew, bobNew,
            psks(aliceGroup, impl), 'branch', impl)

        await rejects(t, () => joinGroupFromBranch(
            bobGroup,
            forged.welcome!,
            bobNew.publicPackage,
            bobNew.privatePackage,
            forged.newState.ratchetTree,
            impl,
        ), 'the wrong resumption PSKs are a ValidationError')

        await honestBranchStillJoins(
            t, aliceGroup, bobGroup, aliceNew, bobNew, impl)
    })
}

test('a branch join with no prior state is a UsageError', async t => {
    const impl = await getCipherSuite(getCiphersuiteFromName(SUITE))
    const { alice, bob, aliceGroup } =
        await aliceAndBob(impl, testClientConfig)

    const aliceNew = await resign(alice, impl)
    const bobNew = await resign(bob, impl)
    const branch = await branchGroup(
        aliceGroup,
        aliceNew.publicPackage,
        aliceNew.privatePackage,
        [bobNew.publicPackage],
        enc('branch'),
        impl,
    )

    try {
        await joinGroup(
            branch.welcome!,
            bobNew.publicPackage,
            bobNew.privatePackage,
            emptyPskIndex,
            impl,
            branch.newState.ratchetTree,
            undefined,
            testClientConfig,
            'branch',
        )
        t.fail('joined without a prior state')
    } catch (err) {
        t.ok(err instanceof UsageError,
            'an expectation without a prior state is a UsageError')
    }
})

test('an ordinary join of an unrelated Welcome still succeeds', async t => {
    const impl = await getCipherSuite(getCiphersuiteFromName(SUITE))
    const { alice, bob, aliceGroup } =
        await aliceAndBob(impl, testClientConfig)

    const aliceNew = await resign(alice, impl)
    const bobNew = await resign(bob, impl)
    const unrelated = await welcomeWithPsks(
        aliceGroup, aliceNew, bobNew, [], 'unrelated', impl)

    const joined = await joinGroup(
        unrelated.welcome!,
        bobNew.publicPackage,
        bobNew.privatePackage,
        emptyPskIndex,
        impl,
        unrelated.newState.ratchetTree,
        undefined,
        testClientConfig,
    )
    t.ok(constantTimeEqual(joined.groupContext.groupId, enc('unrelated')),
        'the joined state is in the unrelated group')
})
