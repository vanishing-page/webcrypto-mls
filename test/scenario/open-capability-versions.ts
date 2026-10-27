import { test } from '@substrate-system/tapzero'
import { skipReason } from '../helpers/skip.js'
import {
    createGroup,
    joinGroup,
    makePskIndex
} from '../../src/client-state.js'
import { createCommit } from '../../src/create-commit.js'
import { processPrivateMessage } from '../../src/process-messages.js'
import { emptyPskIndex } from '../../src/psk-index.js'
import type { Credential } from '../../src/credential.js'
import type { CiphersuiteName } from '../../src/crypto/ciphersuite.js'
import {
    getCiphersuiteFromName
} from '../../src/crypto/ciphersuite.js'
import {
    getCipherSuite
} from '../../src/crypto/get-ciphersuite-impl.js'
import { generateKeyPackage } from '../../src/key-package.js'
import type { MLSMessage } from '../../src/message.js'
import { decodeMlsMessage, encodeMlsMessage } from '../../src/message.js'
import {
    decodeRatchetTree,
    encodeRatchetTree
} from '../../src/ratchet-tree.js'
import { defaultLifetime } from '../../src/lifetime.js'
import {
    defaultCapabilities
} from '../../src/default-capabilities.js'
import { testEveryoneCanMessageEveryone } from './common.js'
import { testCiphersuites } from '../helpers/suite-filter.js'
import { testClientConfig } from '../helpers/client-config.js'

for (const cs of testCiphersuites()) {
    test('leaf advertising an unknown protocol version joins ' + cs,
        async (t) => {
            try {
                await unknownVersionJoins(t, cs as CiphersuiteName)
            } catch (error:any) {
                if (
                    error?.name === 'NotSupportedError' ||
                    error?.name === 'DependencyError'
                ) {
                    t.comment(`Skipping ${cs}: ${skipReason(error)}`)
                    return
                }
                throw error
            }
        })
}

function credential (name:string):Credential {
    return {
        credentialType: 'basic',
        identity: new TextEncoder().encode(name),
    }
}

async function unknownVersionJoins (t:any, cipherSuite:CiphersuiteName) {
    const impl = await getCipherSuite(getCiphersuiteFromName(cipherSuite))

    const alice = await generateKeyPackage(credential('alice'),
        defaultCapabilities(), defaultLifetime(), [], impl)
    const charlie = await generateKeyPackage(credential('charlie'),
        defaultCapabilities(), defaultLifetime(), [], impl)
    // bob's leaf advertises MLS 1.0 and a version this package does not
    // know. The leaf signature covers it, so it is built, not edited in.
    const bob = await generateKeyPackage(credential('bob'),
        { ...defaultCapabilities(), versions: ['mls10', '2'] },
        defaultLifetime(), [], impl)

    // bob's KeyPackage crosses the wire
    const kpMessage:MLSMessage = {
        version: 'mls10',
        wireformat: 'mls_key_package',
        keyPackage: bob.publicPackage,
    }
    const kpBytes = encodeMlsMessage(kpMessage)
    const decodedKp = decodeMlsMessage(kpBytes, 0)?.[0]
    if (decodedKp?.wireformat !== 'mls_key_package') {
        t.fail('KeyPackage with an unknown capability version decodes')
        return
    }
    t.deepEqual(encodeMlsMessage(decodedKp), kpBytes,
        'KeyPackage re-encodes to the same bytes')

    let aliceGroup = await createGroup(
        new TextEncoder().encode('group1'),
        alice.publicPackage,
        alice.privatePackage,
        [],
        impl,
        testClientConfig
    )

    const addCharlie = await createCommit(
        { state: aliceGroup, cipherSuite: impl },
        {
            extraProposals: [{
                proposalType: 'add',
                add: { keyPackage: charlie.publicPackage },
            }],
            ratchetTreeExtension: true,
        },
    )
    aliceGroup = addCharlie.newState
    let charlieGroup = await joinGroup(
        addCharlie.welcome!,
        charlie.publicPackage,
        charlie.privatePackage,
        emptyPskIndex,
        impl,
        undefined,
        undefined,
        testClientConfig
    )

    // alice adds bob from the decoded KeyPackage; no tree in the Welcome
    const addBob = await createCommit(
        { state: aliceGroup, cipherSuite: impl },
        {
            extraProposals: [{
                proposalType: 'add',
                add: { keyPackage: decodedKp.keyPackage },
            }],
            ratchetTreeExtension: false,
        },
    )
    aliceGroup = addBob.newState

    if (addBob.commit.wireformat !== 'mls_private_message') {
        throw new Error('Expected private message')
    }
    const charlieResult = await processPrivateMessage(
        charlieGroup,
        addBob.commit.privateMessage,
        makePskIndex(charlieGroup, {}),
        impl,
    )
    charlieGroup = charlieResult.newState
    t.equal(charlieGroup.groupContext.epoch,
        aliceGroup.groupContext.epoch,
        'charlie processes the commit adding bob')

    // the ratchet tree, holding bob's leaf, travels separately
    const treeBytes = encodeRatchetTree(aliceGroup.ratchetTree)
    const decodedTree = decodeRatchetTree(treeBytes, 0)
    if (decodedTree === undefined) {
        t.fail('ratchet tree with an unknown capability version decodes')
        return
    }
    t.deepEqual(encodeRatchetTree(decodedTree[0]), treeBytes,
        'ratchet tree re-encodes to the same bytes')

    const bobGroup = await joinGroup(
        addBob.welcome!,
        bob.publicPackage,
        bob.privatePackage,
        emptyPskIndex,
        impl,
        decodedTree[0],
        undefined,
        testClientConfig
    )
    t.deepEqual(bobGroup.keySchedule.epochAuthenticator,
        aliceGroup.keySchedule.epochAuthenticator,
        'bob joins with the separately delivered tree')

    await testEveryoneCanMessageEveryone(
        [aliceGroup, bobGroup, charlieGroup], impl, t)
}
