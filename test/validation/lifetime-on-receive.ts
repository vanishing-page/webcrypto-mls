import { test } from '@substrate-system/tapzero'
import { createGroup, joinGroup, makePskIndex } from '../../src/client-state.js'
import { createCommit } from '../../src/create-commit.js'
import { processPrivateMessage } from '../../src/process-messages.js'
import { emptyPskIndex } from '../../src/psk-index.js'
import type { ClientConfig } from '../../src/client-config.js'
import type { Credential } from '../../src/credential.js'
import type { CiphersuiteName } from '../../src/crypto/ciphersuite.js'
import { getCiphersuiteFromName } from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import type { KeyPackage } from '../../src/key-package.js'
import { generateKeyPackage } from '../../src/key-package.js'
import type { ProposalAdd } from '../../src/proposal.js'
import { defaultLifetime } from '../../src/lifetime.js'
import { defaultLifetimeConfig } from '../../src/lifetime-config.js'
import { defaultCapabilities } from '../../src/default-capabilities.js'
import { ValidationError } from '../../src/mls-error.js'
import { testCiphersuites } from '../helpers/suite-filter.js'
import { testClientConfig } from '../helpers/client-config.js'

const UNSUPPORTED = ['NotSupportedError', 'DependencyError', 'CryptoError',
    'DeriveKeyPairError']

function isUnsupported (error:any):boolean {
    return UNSUPPORTED.includes(error?.name) ||
        !!error?.message?.includes('SubtleCrypto') ||
        !!error?.message?.includes('Unrecognized name')
}

test('validateLifetimeOnReceive defaults to true', (t) => {
    t.equal(
        defaultLifetimeConfig.validateLifetimeOnReceive,
        true,
        'the default config enforces lifetimes on received leaf nodes'
    )
})

for (const cs of testCiphersuites()) {
    test('expired KeyPackage in an Add is rejected by default ' + cs,
        async (t) => {
            try {
                const thrown = await addExpiredKeyPackage(
                    cs as CiphersuiteName,
                    testClientConfig
                )
                t.ok(
                    thrown instanceof ValidationError,
                    'should throw a ValidationError'
                )
                t.equal(
                    (thrown as ValidationError | undefined)?.message,
                    'Current time not within Lifetime',
                    'should report the expired lifetime window'
                )
            } catch (error:any) {
                if (isUnsupported(error)) {
                    t.comment(`Skipping ${cs}: ${error.message}`)
                    return
                }
                throw error
            }
        })

    test('expired KeyPackage in an Add is accepted when opted out ' + cs,
        async (t) => {
            const optedOut:ClientConfig = {
                ...testClientConfig,
                lifetimeConfig: {
                    ...defaultLifetimeConfig,
                    validateLifetimeOnReceive: false,
                },
            }

            try {
                const thrown = await addExpiredKeyPackage(
                    cs as CiphersuiteName,
                    optedOut
                )
                t.equal(
                    thrown,
                    undefined,
                    'an explicit opt-out still accepts the expired leaf node'
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
 * Alice adds Charlie while Charlie's KeyPackage is still valid, then Bob
 * processes that commit after the KeyPackage has expired. Returns whatever
 * Bob's processing threw, or `undefined` if it succeeded.
 */
async function addExpiredKeyPackage (
    cipherSuite:CiphersuiteName,
    bobConfig:ClientConfig
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

    // a short window, so it is expired by the time Bob sees the commit
    const now = BigInt(Math.floor(Date.now() / 1000))
    const shortLifetime = { notBefore: now - 60n, notAfter: now + 3600n }

    const charlie = await generateKeyPackage(
        credentialFor('charlie'),
        defaultCapabilities(),
        shortLifetime,
        [],
        impl
    )

    let aliceGroup = await createGroup(
        new TextEncoder().encode('lifetime-on-receive'),
        alice.publicPackage,
        alice.privatePackage,
        [],
        impl,
        testClientConfig
    )

    const addBob = await createCommit(
        { state: aliceGroup, cipherSuite: impl },
        { extraProposals: [addProposal(bob.publicPackage)] }
    )
    aliceGroup = addBob.newState

    const bobGroup = await joinGroup(
        addBob.welcome!,
        bob.publicPackage,
        bob.privatePackage,
        emptyPskIndex,
        impl,
        aliceGroup.ratchetTree,
        undefined,
        bobConfig
    )

    const addCharlie = await createCommit(
        { state: aliceGroup, cipherSuite: impl },
        { extraProposals: [addProposal(charlie.publicPackage)] }
    )

    if (addCharlie.commit.wireformat !== 'mls_private_message') {
        throw new Error('Expected private message')
    }

    // move past Charlie's notAfter, so the commit Bob is about to process
    // carries a KeyPackage that has since expired
    const realNow = Date.now
    Date.now = () => Number(shortLifetime.notAfter + 60n) * 1000

    try {
        await processPrivateMessage(
            bobGroup,
            addCharlie.commit.privateMessage,
            makePskIndex(bobGroup, {}),
            impl
        )
        return undefined
    } catch (error) {
        return error
    } finally {
        Date.now = realNow
    }
}

function credentialFor (name:string):Credential {
    return {
        credentialType: 'basic',
        identity: new TextEncoder().encode(name)
    }
}

function addProposal (keyPackage:KeyPackage):ProposalAdd {
    return { proposalType: 'add', add: { keyPackage } }
}
