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
import { ValidationError } from '../../src/mls-error.js'
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
