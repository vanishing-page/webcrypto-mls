import { test } from '@substrate-system/tapzero'
import { skipReason } from '../helpers/skip.js'
import { createGroup, joinGroup } from '../../src/client-state.js'
import type { ClientState } from '../../src/client-state.js'
import { createCommit } from '../../src/create-commit.js'
import { processMessage } from '../../src/process-messages.js'
import { acceptAll } from '../../src/incoming-message-action.js'
import { emptyPskIndex } from '../../src/psk-index.js'
import type {
    CiphersuiteImpl,
    CiphersuiteName,
} from '../../src/crypto/ciphersuite.js'
import { getCiphersuiteFromName } from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import { generateKeyPackage } from '../../src/key-package.js'
import { defaultLifetime } from '../../src/lifetime.js'
import { defaultCapabilities } from '../../src/default-capabilities.js'
import { encodeExternalSenders } from '../../src/external-sender.js'
import { testEveryoneCanMessageEveryone } from './common.js'
import { testCiphersuites } from '../helpers/suite-filter.js'
import { testClientConfig } from '../helpers/client-config.js'

// Ported from upstream ts-mls: a GroupContextExtensions commit sent as a
// PrivateMessage to more than one receiver, setting external_senders.
// The commit changes the GroupContext every later message is protected
// under, so the check is that all three members still talk afterwards.

for (const cs of testCiphersuites()) {
    test('after a private GroupContextExtensions commit that sets ' +
        'external_senders, three members still message each other - ' + cs,
    async (t) => {
        let impl:CiphersuiteImpl
        try {
            impl = await getCipherSuite(getCiphersuiteFromName(
                cs as CiphersuiteName))
            await member('probe', impl)
        } catch (error:any) {
            if (error?.name === 'NotSupportedError' ||
                error?.name === 'DependencyError') {
                t.comment(`Skipping ${cs}: ${skipReason(error)}`)
                return
            }
            throw error
        }

        const a = await member('alice', impl)
        const b = await member('bob', impl)
        const c = await member('charlie', impl)
        const sender = await member('external-sender', impl)

        const solo = await createGroup(new TextEncoder().encode('group'),
            a.publicPackage, a.privatePackage, [], impl, testClientConfig)
        const add = await createCommit(
            { state: solo, cipherSuite: impl },
            {
                extraProposals: [b, c].map((m) => ({
                    proposalType: 'add' as const,
                    add: { keyPackage: m.publicPackage },
                })),
                ratchetTreeExtension: true,
            },
        )
        const join = (m:typeof b) => joinGroup(add.welcome!,
            m.publicPackage, m.privatePackage, emptyPskIndex, impl,
            undefined, undefined, testClientConfig)
        const bob = await join(b)
        const charlie = await join(c)

        const commit = await createCommit(
            { state: add.newState, cipherSuite: impl },
            {
                wireAsPublicMessage: false,
                extraProposals: [{
                    proposalType: 'group_context_extensions',
                    groupContextExtensions: {
                        extensions: [{
                            extensionType: 'external_senders',
                            extensionData: encodeExternalSenders([{
                                credential:
                                    sender.publicPackage.leafNode.credential,
                                signaturePublicKey: sender.publicPackage
                                    .leafNode.signaturePublicKey,
                            }]),
                        }],
                    },
                }],
            },
        )
        if (commit.commit.wireformat !== 'mls_private_message') {
            throw new Error('expected a private message')
        }

        const members:ClientState[] = [commit.newState]
        for (const receiver of [bob, charlie]) {
            const result = await processMessage(commit.commit, receiver,
                emptyPskIndex, acceptAll, impl)
            members.push(result.newState)
        }

        for (const [i, state] of members.entries()) {
            t.equal(state.groupContext.epoch,
                commit.newState.groupContext.epoch,
                `member ${i} reaches the commit's epoch`)
            t.ok(state.groupContext.extensions.some((e) =>
                e.extensionType === 'external_senders'),
            `member ${i} holds the external_senders extension`)
        }

        await testEveryoneCanMessageEveryone(members, impl, t)
    })
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
