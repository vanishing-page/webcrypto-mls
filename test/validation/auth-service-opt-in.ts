import { test } from '@substrate-system/tapzero'
import { createGroup } from '../../src/client-state.js'
import { createCommit } from '../../src/create-commit.js'
import { emptyPskIndex } from '../../src/psk-index.js'
import type { ClientConfig } from '../../src/client-config.js'
import { defaultClientConfig } from '../../src/client-config.js'
import {
    failClosedAuthenticationService,
    unsafeAcceptAllAuthenticationService
} from '../../src/authentication-service.js'
import type { Credential } from '../../src/credential.js'
import type { CiphersuiteName } from '../../src/crypto/ciphersuite.js'
import { getCiphersuiteFromName } from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import { generateKeyPackage } from '../../src/key-package.js'
import type { ProposalAdd } from '../../src/proposal.js'
import { defaultLifetime } from '../../src/lifetime.js'
import { defaultCapabilities } from '../../src/default-capabilities.js'
import { UsageError } from '../../src/mls-error.js'
import { testClientConfig } from '../helpers/client-config.js'
import { sampleCiphersuites } from '../helpers/suite-filter.js'

const UNSUPPORTED = ['NotSupportedError', 'DependencyError', 'CryptoError',
    'DeriveKeyPairError']

function isUnsupported (error:any):boolean {
    return UNSUPPORTED.includes(error?.name) ||
        !!error?.message?.includes('SubtleCrypto') ||
        !!error?.message?.includes('Unrecognized name')
}

test('the default AuthenticationService authenticates nothing', async (t) => {
    t.equal(
        defaultClientConfig.authService,
        failClosedAuthenticationService,
        'defaultClientConfig does not silently accept every credential'
    )

    try {
        await defaultClientConfig.authService.validateCredential(
            { credentialType: 'basic', identity: new Uint8Array([1]) },
            new Uint8Array([2])
        )
        t.fail('the default service should refuse to make a decision')
    } catch (err) {
        t.ok(err instanceof UsageError, 'it throws a UsageError')
        t.ok(
            (err as Error).message.includes(
                'unsafeAcceptAllAuthenticationService'
            ),
            'and names the opt-in a test can reach for'
        )
    }
})

test('accept-all is reachable, but only by name', async (t) => {
    t.equal(
        await unsafeAcceptAllAuthenticationService.validateCredential(
            { credentialType: 'basic', identity: new Uint8Array([1]) },
            new Uint8Array([2])
        ),
        true,
        'the explicitly unsafe service still accepts anything'
    )
})

for (const cs of sampleCiphersuites()) {
    test('an Add is refused without a configured authService - ' + cs,
        async (t) => {
            try {
                const thrown = await addBob(
                    cs as CiphersuiteName,
                    defaultClientConfig
                )
                t.ok(
                    thrown instanceof UsageError,
                    'committing an Add throws a UsageError'
                )
            } catch (error:any) {
                if (isUnsupported(error)) {
                    t.comment(`Skipping ${cs}: ${error.message}`)
                    return
                }
                throw error
            }
        })

    test('an Add succeeds once accept-all is opted into - ' + cs,
        async (t) => {
            try {
                const thrown = await addBob(
                    cs as CiphersuiteName,
                    testClientConfig
                )
                t.equal(
                    thrown,
                    undefined,
                    'the explicit opt-in accepts the added credential'
                )
            } catch (error:any) {
                if (isUnsupported(error)) {
                    t.comment(`Skipping ${cs}: ${error.message}`)
                    return
                }
                throw error
            }
        })
}

/**
 * Alice creates a group under `config` and commits an Add of Bob. Returns
 * whatever the commit threw, or `undefined` if it succeeded.
 */
async function addBob (
    cipherSuite:CiphersuiteName,
    config:ClientConfig
):Promise<unknown> {
    const impl = await getCipherSuite(getCiphersuiteFromName(cipherSuite))

    const alice = await generateKeyPackage(
        credentialFor('alice'),
        defaultCapabilities(),
        defaultLifetime(),
        [],
        impl
    )
    const bob = await generateKeyPackage(
        credentialFor('bob'),
        defaultCapabilities(),
        defaultLifetime(),
        [],
        impl
    )

    const aliceGroup = await createGroup(
        new TextEncoder().encode('auth-service-opt-in'),
        alice.publicPackage,
        alice.privatePackage,
        [],
        impl,
        config
    )

    const addBobProposal:ProposalAdd = {
        proposalType: 'add',
        add: { keyPackage: bob.publicPackage },
    }

    try {
        await createCommit(
            { state: aliceGroup, cipherSuite: impl, pskIndex: emptyPskIndex },
            { extraProposals: [addBobProposal] }
        )
    } catch (err) {
        return err
    }

    return undefined
}

function credentialFor (name:string):Credential {
    return {
        credentialType: 'basic',
        identity: new TextEncoder().encode(name),
    }
}
