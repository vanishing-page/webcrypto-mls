import { test } from '@substrate-system/tapzero'
import { createGroup, joinGroup } from '../../src/client-state.js'
import {
    createGroupInfoWithExternalPubAndRatchetTree,
    joinGroupExternal,
} from '../../src/create-commit.js'
import { emptyPskIndex } from '../../src/psk-index.js'
import type { ClientConfig } from '../../src/client-config.js'
import type {
    CiphersuiteImpl,
    CiphersuiteName,
} from '../../src/crypto/ciphersuite.js'
import { getCiphersuiteFromName } from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import { generateKeyPackage, makeKeyPackageRef } from '../../src/key-package.js'
import { defaultLifetime } from '../../src/lifetime.js'
import { defaultCapabilities } from '../../src/default-capabilities.js'
import type { Credential } from '../../src/credential.js'
import { ValidationError } from '../../src/mls-error.js'
import type { ProtocolVersionName } from '../../src/protocol-version.js'
import { protocolVersions } from '../../src/protocol-version.js'
import { extractWelcomeSecret } from '../../src/group-info.js'
import { encryptGroupInfo, encryptGroupSecrets } from '../../src/welcome.js'
import type { Welcome } from '../../src/welcome.js'
import { testCiphersuites } from '../helpers/suite-filter.js'
import { testClientConfig } from '../helpers/client-config.js'

/**
 * A version the library does not ship. Registering it for the duration of
 * the test is the only way to build a wire-encodable KeyPackage whose
 * version differs from the group's, which is what a malicious committer
 * would hand a joiner.
 */
const FUTURE_VERSION = 'mls-future' as ProtocolVersionName

/**
 * Matches a prior leaf by credential identity rather than by signature
 * key, so a resync can use a freshly generated key package on every
 * ciphersuite (reusing a signature key only works for Ed25519).
 */
const identityResyncConfig:ClientConfig = {
    ...testClientConfig,
    keyPackageEqualityConfig: {
        ...testClientConfig.keyPackageEqualityConfig,
        compareKeyPackageToLeafNode (a, b) {
            const ai = a.leafNode.credential
            const bi = b.credential
            if (ai.credentialType !== 'basic' || bi.credentialType !== 'basic') {
                return false
            }
            return (
                new TextDecoder().decode(ai.identity) ===
                new TextDecoder().decode(bi.identity)
            )
        },
    },
}

async function makeMember (name:string, impl:CiphersuiteImpl) {
    const credential:Credential = {
        credentialType: 'basic',
        identity: new TextEncoder().encode(name),
    }
    const kp = await generateKeyPackage(
        credential,
        defaultCapabilities(),
        defaultLifetime(),
        [],
        impl,
    )
    return { credential, ...kp }
}

for (const cs of testCiphersuites()) {
    test(`joinGroup rejects a version mismatch ${cs}`, async (t) => {
        try {
            await versionMismatchOnJoin(cs as CiphersuiteName, t)
        } catch (error:any) {
            if (
                error?.name === 'NotSupportedError' ||
                error?.name === 'DependencyError'
            ) {
                t.comment(`Skipping ${cs}: ${error.message}`)
                return
            }
            throw error
        }
    })

    test(`removing the sole leaf of a group is rejected ${cs}`, async (t) => {
        try {
            await soleLeafRemove(cs as CiphersuiteName, t)
        } catch (error:any) {
            if (
                error?.name === 'NotSupportedError' ||
                error?.name === 'DependencyError'
            ) {
                t.comment(`Skipping ${cs}: ${error.message}`)
                return
            }
            throw error
        }
    })
}

async function versionMismatchOnJoin (cipherSuite:CiphersuiteName, t:any) {
    const impl = await getCipherSuite(getCiphersuiteFromName(cipherSuite))

    const alice = await makeMember('alice', impl)
    const bob = await makeMember('bob', impl)

    const aliceGroup = await createGroup(
        new TextEncoder().encode('version-mismatch'),
        alice.publicPackage,
        alice.privatePackage,
        [],
        impl,
        testClientConfig,
    )

    // A GroupInfo alice really signed, at the group's real version.
    const groupInfo = await createGroupInfoWithExternalPubAndRatchetTree(
        aliceGroup,
        [],
        impl,
    )

    const registry = protocolVersions as unknown as Record<string, number>
    registry[FUTURE_VERSION] = 0xf00d

    try {
        // A committer that skipped its own version check would encrypt the
        // group secrets to a key package from a different protocol version.
        const futureKeyPackage = { ...bob.publicPackage, version: FUTURE_VERSION }

        const joinerSecret = globalThis.crypto.getRandomValues(
            new Uint8Array(impl.kdf.size),
        )
        const welcomeSecret = await extractWelcomeSecret(
            joinerSecret,
            new Uint8Array(impl.kdf.size),
            impl.kdf,
        )
        const encryptedGroupInfo = await encryptGroupInfo(
            groupInfo,
            welcomeSecret,
            impl,
        )
        const initKey = await impl.hpke.importPublicKey(futureKeyPackage.initKey)
        const egs = await encryptGroupSecrets(
            initKey,
            encryptedGroupInfo,
            { joinerSecret, pathSecret: undefined, psks: [] },
            impl.hpke,
        )

        const welcome:Welcome = {
            cipherSuite,
            secrets: [{
                newMember: await makeKeyPackageRef(futureKeyPackage, impl.hash),
                encryptedGroupSecrets: { kemOutput: egs.enc, ciphertext: egs.ct },
            }],
            encryptedGroupInfo,
        }

        try {
            await joinGroup(
                welcome,
                futureKeyPackage,
                bob.privatePackage,
                emptyPskIndex,
                impl,
                aliceGroup.ratchetTree,
                undefined,
                testClientConfig,
            )
            t.fail('joinGroup should reject a version mismatch')
        } catch (err:any) {
            t.ok(
                err instanceof ValidationError &&
                    /version/i.test(err.message),
                'joinGroup throws ValidationError when the KeyPackage version ' +
                    'does not match the GroupContext version',
            )
        }
    } finally {
        delete registry[FUTURE_VERSION]
    }
}

async function soleLeafRemove (cipherSuite:CiphersuiteName, t:any) {
    const impl = await getCipherSuite(getCiphersuiteFromName(cipherSuite))

    const alice = await makeMember('alice', impl)
    const aliceAgain = await makeMember('alice', impl)

    const aliceGroup = await createGroup(
        new TextEncoder().encode('sole-leaf-remove'),
        alice.publicPackage,
        alice.privatePackage,
        [],
        impl,
        testClientConfig,
    )

    const groupInfo = await createGroupInfoWithExternalPubAndRatchetTree(
        aliceGroup,
        [],
        impl,
    )

    // A resync external join into a one-member group would blank the only
    // leaf in the tree before adding the new one.
    try {
        await joinGroupExternal(
            groupInfo,
            aliceAgain.publicPackage,
            aliceAgain.privatePackage,
            true,
            impl,
            undefined,
            identityResyncConfig,
        )
        t.fail('a resync that empties the tree should be rejected')
    } catch (err) {
        t.ok(
            err instanceof ValidationError,
            'removing the sole leaf of a group throws ValidationError',
        )
    }
}
