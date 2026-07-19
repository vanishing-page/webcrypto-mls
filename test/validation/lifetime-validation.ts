import { test } from '@substrate-system/tapzero'
import { createGroup } from '../../src/client-state.js'
import { createCommit } from '../../src/create-commit.js'
import type { Credential } from '../../src/credential.js'
import type { CiphersuiteName } from '../../src/crypto/ciphersuite.js'
import {
    ciphersuites,
    getCiphersuiteFromName
} from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import { generateKeyPackage } from '../../src/key-package.js'
import type { ProposalAdd } from '../../src/proposal.js'
import { defaultLifetime } from '../../src/lifetime.js'
import { defaultLifetimeConfig } from '../../src/lifetime-config.js'
import { defaultCapabilities } from '../../src/default-capabilities.js'
import { ValidationError } from '../../src/mls-error.js'

for (const cs of Object.keys(ciphersuites)) {
    test('reject over-long KeyPackage lifetime on commit ' + cs, async (t) => {
        try {
            await rejectsOverLongLifetime(t, cs as CiphersuiteName)
        } catch (error:any) {
            // Skip ciphersuites not supported in the current environment (e.g., X448/Ed448 in browsers)
            if (error?.name === 'NotSupportedError' || error?.name === 'DependencyError' || error?.name === 'CryptoError' || error?.name === 'DeriveKeyPairError' || error?.message?.includes('SubtleCrypto') || error?.message?.includes('Unrecognized name')) {
                t.comment(`Skipping ${cs}: ${error.message}`)
                return
            }
            throw error
        }
    })
}

async function rejectsOverLongLifetime (t:any, cipherSuite:CiphersuiteName) {
    const impl = await getCipherSuite(getCiphersuiteFromName(cipherSuite))

    const aliceCredential:Credential = {
        credentialType: 'basic',
        identity: new TextEncoder().encode('alice')
    }
    const alice = await generateKeyPackage(
        aliceCredential,
        defaultCapabilities(),
        defaultLifetime,
        [],
        impl
    )

    const groupId = new TextEncoder().encode('lifetime-group')

    const aliceGroup = await createGroup(
        groupId,
        alice.publicPackage,
        alice.privatePackage,
        [],
        impl
    )

    const bobCredential:Credential = {
        credentialType: 'basic',
        identity: new TextEncoder().encode('bob')
    }

    const currentTime = BigInt(Math.floor(Date.now() / 1000))
    const overLongLifetime = {
        notBefore: currentTime - 100n,
        notAfter: currentTime + defaultLifetimeConfig.maximumTotalLifetime + 100n,
    }

    const bob = await generateKeyPackage(
        bobCredential,
        defaultCapabilities(),
        overLongLifetime,
        [],
        impl
    )

    const addBobProposal:ProposalAdd = {
        proposalType: 'add',
        add: {
            keyPackage: bob.publicPackage,
        },
    }

    let thrown:unknown
    try {
        await createCommit(
            {
                state: aliceGroup,
                cipherSuite: impl,
            },
            {
                extraProposals: [addBobProposal],
            },
        )
    } catch (error) {
        thrown = error
    }

    t.ok(thrown instanceof ValidationError, 'should throw a ValidationError')
    t.equal(
        (thrown as ValidationError | undefined)?.message,
        'LeafNode lifetime exceeds maximumTotalLifetime',
        'should have correct error message',
    )
}
