import { test, type Test } from '@substrate-system/tapzero'
import { createGroup, joinGroup, makePskIndex } from '../../src/client-state.js'
import { createCommit } from '../../src/create-commit.js'
import { processPrivateMessage } from '../../src/process-messages.js'
import { emptyPskIndex } from '../../src/psk-index.js'
import { createApplicationMessage } from '../../src/create-message.js'
import type { CiphersuiteName } from '../../src/crypto/ciphersuite.js'
import {
    getCiphersuiteFromName,
} from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import { nobleCryptoProvider } from '../../src/index.js'
import { generateKeyPackage } from '../../src/key-package.js'
import type { Credential } from '../../src/credential.js'
import type { ProposalAdd } from '../../src/proposal.js'
import { defaultLifetime } from '../../src/lifetime.js'
import { defaultCapabilities } from '../../src/default-capabilities.js'

test('Mixed provider non-extractable identity interop (AC3.3)',
    async (t:Test) => {
        try {
            await mixedProviderInterop(t)
        } catch (error:unknown) {
            // Skip if ciphersuite not supported
            if (
                error instanceof Error &&
                (error.name === 'NotSupportedError' ||
                 error.name === 'DependencyError')
            ) {
                t.comment(`Skipping: ${error.message}`)
                return
            }
            throw error
        }
    })

async function mixedProviderInterop (t:Test) {
    const cipherSuite:CiphersuiteName = 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519'

    // Get both providers
    const implA = await getCipherSuite(
        getCiphersuiteFromName(cipherSuite)
    )
    const implB = await getCipherSuite(
        getCiphersuiteFromName(cipherSuite),
        nobleCryptoProvider
    )

    const groupId = new TextEncoder().encode('mixed-provider-group')

    const makeCredential = (name:string):Credential => ({
        credentialType: 'basic',
        identity: new TextEncoder().encode(name),
    })

    // Member A: default provider with non-extractable pair
    const aCredential = makeCredential('member-a')
    const aNonExtractablePair = await crypto.subtle.generateKey(
        { name: 'Ed25519' },
        false,
        ['sign', 'verify']
    ) as CryptoKeyPair

    const aKeyPackage = await generateKeyPackage(
        aCredential,
        defaultCapabilities(),
        defaultLifetime,
        [],
        implA,
        { signatureKeyPair: aNonExtractablePair }
    )

    // Verify non-extractable
    const aPrivateKey = aKeyPackage.privatePackage
        .signaturePrivateKey as CryptoKey
    t.equal(aPrivateKey.extractable, false,
        'A private key should be non-extractable')
    t.equal(aPrivateKey, aNonExtractablePair.privateKey,
        'A private key should be the provided pair private key')

    // A creates group
    const aGroupState = await createGroup(
        groupId,
        aKeyPackage.publicPackage,
        aKeyPackage.privatePackage,
        [],
        implA
    )

    // Member B: noble provider with generated key package
    const bCredential = makeCredential('member-b')
    const bKeyPackage = await generateKeyPackage(
        bCredential,
        defaultCapabilities(),
        defaultLifetime,
        [],
        implB
    )

    // A adds B to group
    const addProposal:ProposalAdd = {
        proposalType: 'add' as const,
        add: { keyPackage: bKeyPackage.publicPackage },
    }

    const commitResult = await createCommit(
        {
            state: aGroupState,
            cipherSuite: implA,
        },
        {
            extraProposals: [addProposal],
        },
    )

    if (commitResult.commit.wireformat !== 'mls_private_message') {
        throw new Error('Expected private message')
    }

    const aUpdatedState = commitResult.newState

    // B joins from welcome
    const bState = await joinGroup(
        commitResult.welcome!,
        bKeyPackage.publicPackage,
        bKeyPackage.privatePackage,
        emptyPskIndex,
        implB,
        aUpdatedState.ratchetTree,
    )

    // A sends application message
    const aMessageText = 'Hello from member A (WebCrypto)'
    const aMessageBytes = new TextEncoder().encode(aMessageText)

    const aAppResult = await createApplicationMessage(
        aUpdatedState,
        aMessageBytes,
        implA,
    )

    const bRecvResult = await processPrivateMessage(
        bState,
        aAppResult.privateMessage,
        makePskIndex(bState, {}),
        implB,
    )

    if (bRecvResult.kind === 'newState') {
        throw new Error(
            'Expected application message result for B from A')
    }

    t.deepEqual(bRecvResult.message, aMessageBytes,
        'B should receive message from A across providers')

    const bUpdatedState = bRecvResult.newState

    // B sends application message
    const bMessageText = 'Hello from member B (noble)'
    const bMessageBytes = new TextEncoder().encode(bMessageText)

    const bAppResult = await createApplicationMessage(
        bUpdatedState,
        bMessageBytes,
        implB,
    )

    const aRecvResult = await processPrivateMessage(
        aUpdatedState,
        bAppResult.privateMessage,
        makePskIndex(aUpdatedState, {}),
        implA,
    )

    if (aRecvResult.kind === 'newState') {
        throw new Error(
            'Expected application message result for A from B')
    }

    t.deepEqual(aRecvResult.message, bMessageBytes,
        'A should receive message from B across providers')

    t.ok(true, 'mixed-provider group successfully exchanged verified messages')
}
