import { test, type Test } from '@substrate-system/tapzero'
import { skipReason } from '../helpers/skip.js'
import { createGroup, joinGroup } from '../../src/client-state.js'
import { createCommit } from '../../src/create-commit.js'
import { createApplicationMessage } from '../../src/create-message.js'
import {
    processMessage,
    processPrivateMessage,
} from '../../src/process-messages.js'
import { acceptAll } from '../../src/incoming-message-action.js'
import { emptyPskIndex } from '../../src/psk-index.js'
import type {
    CiphersuiteName,
    CiphersuiteImpl,
} from '../../src/crypto/ciphersuite.js'
import { getCiphersuiteFromName } from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import { nobleCryptoProvider } from '../../src/index.js'
import { generateKeyPackage } from '../../src/key-package.js'
import type { MLSMessage } from '../../src/message.js'
import { defaultLifetime } from '../../src/lifetime.js'
import { defaultCapabilities } from '../../src/default-capabilities.js'
import { testCiphersuites } from '../helpers/suite-filter.js'
import { testClientConfig } from '../helpers/client-config.js'

// Strict EdDSA verification and the small-order key check must not
// refuse anything an honest signer produces, whichever provider signed
// it. Alice uses the default provider and Bob the noble one, on every
// Ed25519 and Ed448 suite, and each verifies the other's leaf, commit
// and application message.
const edSuites = testCiphersuites().filter((cs) => {
    const alg = getCiphersuiteFromName(cs).signature
    return alg === 'Ed25519' || alg === 'Ed448'
})

for (const cs of edSuites) {
    test('an honest EdDSA group spans both providers - ' + cs,
        async (t:Test) => {
            try {
                await honestGroup(t, cs)
            } catch (error:any) {
                if (error?.name === 'NotSupportedError' ||
                    error?.name === 'DependencyError') {
                    t.comment(`Skipping ${cs}: ${skipReason(error)}`)
                    return
                }
                throw error
            }
        })
}

function framed (m:MLSMessage) {
    if (m.wireformat !== 'mls_private_message' &&
        m.wireformat !== 'mls_public_message') {
        throw new Error('Expected a framed message')
    }
    return m
}

async function member (name:string, impl:CiphersuiteImpl) {
    return generateKeyPackage(
        { credentialType: 'basic', identity: new TextEncoder().encode(name) },
        defaultCapabilities(),
        defaultLifetime(),
        [],
        impl,
    )
}

async function honestGroup (t:Test, cs:CiphersuiteName) {
    const suite = getCiphersuiteFromName(cs)
    const implA = await getCipherSuite(suite)
    const implB = await getCipherSuite(suite, nobleCryptoProvider)

    const a = await member('alice', implA)
    const b = await member('bob', implB)

    const aliceGroup = await createGroup(new TextEncoder().encode('group'),
        a.publicPackage, a.privatePackage, [], implA, testClientConfig)

    const add = await createCommit(
        { state: aliceGroup, cipherSuite: implA },
        {
            extraProposals: [{
                proposalType: 'add',
                add: { keyPackage: b.publicPackage },
            }],
            ratchetTreeExtension: true,
        },
    )

    const bob = await joinGroup(add.welcome!, b.publicPackage,
        b.privatePackage, emptyPskIndex, implB, undefined, undefined,
        testClientConfig)

    // Bob's commit carries a noble-signed UpdatePath leaf
    const bobCommit = await createCommit(
        { state: bob, cipherSuite: implB },
        {},
    )
    const aliceAfter = await processMessage(framed(bobCommit.commit),
        add.newState, emptyPskIndex, acceptAll, implA)
    t.equal(aliceAfter.kind, 'newState', 'Alice accepts Bob\'s commit')

    const hello = new TextEncoder().encode('hello')
    const fromAlice = await createApplicationMessage(aliceAfter.newState,
        hello, implA)
    const bobReceives = await processPrivateMessage(bobCommit.newState,
        fromAlice.privateMessage, emptyPskIndex, implB)
    t.equal(bobReceives.kind, 'applicationMessage',
        'Bob reads Alice\'s message')

    const fromBob = await createApplicationMessage(bobReceives.newState,
        hello, implB)
    const aliceReceives = await processPrivateMessage(fromAlice.newState,
        fromBob.privateMessage, emptyPskIndex, implA)
    t.equal(aliceReceives.kind, 'applicationMessage',
        'Alice reads Bob\'s message')
}
