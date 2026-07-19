import { test, type Test } from '@substrate-system/tapzero'
import type { ClientState } from '../../src/client-state.js'
import {
    createGroup,
    joinGroup,
    makePskIndex
} from '../../src/client-state.js'
import { createCommit } from '../../src/create-commit.js'
import { createApplicationMessage } from '../../src/create-message.js'
import { processPrivateMessage } from '../../src/process-messages.js'
import { emptyPskIndex } from '../../src/psk-index.js'
import {
    getCiphersuiteFromName
} from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import { generateKeyPackage } from '../../src/key-package.js'
import type { Credential } from '../../src/credential.js'
import type { ProposalAdd } from '../../src/proposal.js'
import { defaultLifetime } from '../../src/lifetime.js'
import { defaultCapabilities } from '../../src/default-capabilities.js'

test('Non-extractable Ed25519 identity completes group flow', async (t) => {
    try {
        await nonExtractableIdentityFlow(t)
    } catch (error:unknown) {
        // Skip ciphersuites not supported in the current environment
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

async function nonExtractableIdentityFlow (t:Test) {
    // Use Ed25519 ciphersuite (X25519 + Ed25519)
    const cs = 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519'
    const impl = await getCipherSuite(getCiphersuiteFromName(cs))
    const groupId = new TextEncoder().encode('non-extractable-group')

    const makeCredential = (name:string):Credential => ({
        credentialType: 'basic',
        identity: new TextEncoder().encode(name),
    })

    // Step 1: Creator generates key package
    const creatorCred = makeCredential('creator')
    const creatorKP = await generateKeyPackage(
        creatorCred,
        defaultCapabilities(),
        defaultLifetime,
        [],
        impl
    )

    // Verify creator's signature private key is non-extractable CryptoKey
    t.equal(
        creatorKP.privatePackage.signaturePrivateKey
            instanceof Uint8Array,
        false,
        'signaturePrivateKey should not be Uint8Array'
    )

    const cryptoKey = creatorKP.privatePackage
        .signaturePrivateKey as CryptoKey
    t.equal(
        cryptoKey.extractable,
        false,
        'signaturePrivateKey should be non-extractable'
    )
    t.equal(
        cryptoKey.type,
        'private',
        'signaturePrivateKey should be a private key'
    )

    // Step 2: Creator creates group
    const creatorGroup = await createGroup(
        groupId,
        creatorKP.publicPackage,
        creatorKP.privatePackage,
        [],
        impl
    )

    // Step 3: Generate joiner's key package
    const joinerCred = makeCredential('joiner')
    const joinerKP = await generateKeyPackage(
        joinerCred,
        defaultCapabilities(),
        defaultLifetime,
        [],
        impl
    )

    // Step 4: Creator creates commit to add joiner
    const addJoinerProposal:ProposalAdd = {
        proposalType: 'add',
        add: {
            keyPackage: joinerKP.publicPackage
        },
    }

    const commitResult = await createCommit(
        {
            state: creatorGroup,
            cipherSuite: impl,
        },
        {
            extraProposals: [addJoinerProposal],
        },
    )

    if (!commitResult.welcome) {
        throw new Error('Expected welcome message')
    }

    const creatorState2 = commitResult.newState

    // Step 5: Joiner joins group
    let joinerState:ClientState
    try {
        const joinResult = await joinGroup(
            commitResult.welcome,
            joinerKP.publicPackage,
            joinerKP.privatePackage,
            emptyPskIndex,
            impl,
            creatorState2.ratchetTree,
        )
        joinerState = joinResult
    } catch (error) {
        t.comment(`Join failed: ${error}`)
        throw error
    }

    // Step 6: Creator sends application message
    const messageText = 'Hello from non-extractable identity'
    const messageBytes = new TextEncoder().encode(messageText)

    const { privateMessage } =
        await createApplicationMessage(
            creatorState2,
            messageBytes,
            impl
        )

    // Step 7: Joiner receives and decrypts message
    const result = await processPrivateMessage(
        joinerState,
        privateMessage,
        makePskIndex(joinerState, {}),
        impl
    )

    if (result.kind === 'newState') {
        throw new Error('Expected application message, got state update')
    }

    t.deepEqual(
        result.message,
        messageBytes,
        'Joiner should decrypt creator message successfully'
    )
}
