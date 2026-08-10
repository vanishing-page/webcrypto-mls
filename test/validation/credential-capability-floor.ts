import { test } from '@substrate-system/tapzero'
import {
    createGroup,
    joinGroup,
    validateLeafNodeUpdateOrCommit
} from '../../src/client-state.js'
import { createCommit } from '../../src/create-commit.js'
import { emptyPskIndex } from '../../src/psk-index.js'
import type { Credential } from '../../src/credential.js'
import type { CiphersuiteName, CiphersuiteImpl } from '../../src/crypto/ciphersuite.js'
import { getCiphersuiteFromName } from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import type { Capabilities } from '../../src/capabilities.js'
import { signLeafNodeCommit } from '../../src/leaf-node.js'
import { generateKeyPackage } from '../../src/key-package.js'
import type { ProposalAdd } from '../../src/proposal.js'
import { defaultLifetime } from '../../src/lifetime.js'
import { defaultCapabilities } from '../../src/default-capabilities.js'
import { ValidationError } from '../../src/mls-error.js'
import { sampleCiphersuites } from '../helpers/suite-filter.js'
import { testClientConfig } from '../helpers/client-config.js'
import {
    unsafeAcceptAllAuthenticationService
} from '../../src/authentication-service.js'

// RFC 9420 7.3 requires both capability directions. The group already
// refused a leaf whose credential type no member supports; this covers the
// reverse -- a new or replacement leaf must itself list every credential
// type currently in use, or one member could quietly lower the group's
// credential floor and then present a credential the rest of the group
// cannot check.
for (const cs of sampleCiphersuites()) {
    test('a replacement leaf that drops an in-use credential type is ' +
        'rejected - ' + cs, async (t) => {
        try {
            await replacementLeafMustSupportInUseTypes(t, cs as CiphersuiteName)
        } catch (error:any) {
            if (isUnsupported(error)) {
                t.comment(`Skipping ${cs}: ${error.message}`)
                return
            }
            throw error
        }
    })

    test('an added leaf that drops an in-use credential type is ' +
        'rejected - ' + cs, async (t) => {
        try {
            await addedLeafMustSupportInUseTypes(t, cs as CiphersuiteName)
        } catch (error:any) {
            if (isUnsupported(error)) {
                t.comment(`Skipping ${cs}: ${error.message}`)
                return
            }
            throw error
        }
    })
}

function isUnsupported (error:any):boolean {
    return error?.name === 'NotSupportedError' ||
        error?.name === 'DependencyError'
}

/**
 * `defaultCapabilities` advertises both shipped credential types. This drops
 * one of them while leaving the greased entries alone, so the only thing the
 * leaf stops supporting is the type its peers are actually using.
 */
function withoutBasicCredential (caps:Capabilities):Capabilities {
    return {
        ...caps,
        credentials: caps.credentials.filter((c) => c !== 'basic'),
    }
}

async function makeMember (
    name:string,
    impl:CiphersuiteImpl,
    capabilities:Capabilities = defaultCapabilities(),
) {
    const credential:Credential = {
        credentialType: 'basic',
        identity: new TextEncoder().encode(name),
    }

    return generateKeyPackage(
        credential,
        capabilities,
        defaultLifetime(),
        [],
        impl,
    )
}

async function aliceAndBob (cipherSuite:CiphersuiteName) {
    const impl = await getCipherSuite(getCiphersuiteFromName(cipherSuite))

    const alice = await makeMember('alice', impl)
    const bob = await makeMember('bob', impl)

    const aliceGroup = await createGroup(
        new TextEncoder().encode('group1'),
        alice.publicPackage,
        alice.privatePackage,
        [],
        impl,
        testClientConfig
    )

    const addBob:ProposalAdd = {
        proposalType: 'add',
        add: { keyPackage: bob.publicPackage },
    }

    const addCommit = await createCommit(
        { state: aliceGroup, cipherSuite: impl },
        { extraProposals: [addBob], ratchetTreeExtension: true },
    )

    const bobGroup = await joinGroup(
        addCommit.welcome!,
        bob.publicPackage,
        bob.privatePackage,
        emptyPskIndex,
        impl,
        undefined,
        undefined,
        testClientConfig
    )

    return {
        impl,
        bob,
        bobLeafIndex: bobGroup.privatePath.leafIndex,
        aliceGroup: addCommit.newState,
    }
}

/**
 * Bob rotates his leaf with a commit path leaf whose capabilities no longer
 * list `basic` -- the credential type Alice is using. The same leaf with the
 * unmodified capabilities has to still pass, otherwise the test would prove
 * nothing about the credential list specifically.
 */
async function replacementLeafMustSupportInUseTypes (
    t:any,
    cipherSuite:CiphersuiteName,
) {
    const { impl, bob, bobLeafIndex, aliceGroup } = await aliceAndBob(
        cipherSuite,
    )

    const rotated = await makeMember('bob', impl)

    const leafFor = async (capabilities:Capabilities) => signLeafNodeCommit(
        {
            leafNodeSource: 'commit',
            parentHash: new Uint8Array([1, 2, 3]),
            hpkePublicKey: rotated.publicPackage.leafNode.hpkePublicKey,
            signaturePublicKey: bob.publicPackage.leafNode.signaturePublicKey,
            credential: bob.publicPackage.leafNode.credential,
            capabilities,
            extensions: bob.publicPackage.leafNode.extensions,
            info: {
                leafNodeSource: 'commit',
                groupId: aliceGroup.groupContext.groupId,
                leafIndex: bobLeafIndex,
            },
        },
        bob.privatePackage.signaturePrivateKey,
        impl.signature,
    )

    const narrowed = await leafFor(
        withoutBasicCredential(bob.publicPackage.leafNode.capabilities),
    )

    const rejected = await validateLeafNodeUpdateOrCommit(
        narrowed,
        bobLeafIndex,
        aliceGroup.groupContext,
        aliceGroup.ratchetTree,
        unsafeAcceptAllAuthenticationService,
        impl.signature,
    )

    t.ok(
        rejected instanceof ValidationError,
        'a leaf that stops supporting an in-use credential type is ' +
            'rejected',
    )

    const full = await leafFor(bob.publicPackage.leafNode.capabilities)

    const accepted = await validateLeafNodeUpdateOrCommit(
        full,
        bobLeafIndex,
        aliceGroup.groupContext,
        aliceGroup.ratchetTree,
        unsafeAcceptAllAuthenticationService,
        impl.signature,
    )

    t.equal(
        accepted,
        undefined,
        'the same leaf listing every in-use credential type is accepted',
    )
}

/**
 * The Add direction. Carol's KeyPackage is well formed but her capabilities
 * omit `basic`, which both existing members use, so committing the Add has to
 * fail rather than seat a member who cannot validate her peers.
 */
async function addedLeafMustSupportInUseTypes (
    t:any,
    cipherSuite:CiphersuiteName,
) {
    const { impl, aliceGroup } = await aliceAndBob(cipherSuite)

    const carol = await makeMember(
        'carol',
        impl,
        withoutBasicCredential(defaultCapabilities()),
    )

    const addCarol:ProposalAdd = {
        proposalType: 'add',
        add: { keyPackage: carol.publicPackage },
    }

    try {
        await createCommit(
            { state: aliceGroup, cipherSuite: impl },
            { extraProposals: [addCarol], ratchetTreeExtension: true },
        )
        t.fail('the Add should have been rejected')
    } catch (error) {
        t.ok(
            error instanceof ValidationError,
            'adding a leaf that does not support an in-use credential ' +
                'type throws ValidationError',
        )
    }
}
