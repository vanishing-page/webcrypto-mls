import { test } from '@substrate-system/tapzero'
import { skipReason } from '../helpers/skip.js'
import {
    type ClientState,
    type KeyPackage,
    type PrivateKeyPackage,
    type Proposal,
    acceptAll,
    createApplicationMessage,
    createCommit,
    createGroup,
    defaultCapabilities,
    defaultLifetime,
    emptyPskIndex,
    generateKeyPackage,
    getCipherSuite,
    getCiphersuiteFromName,
    joinGroup,
    processMessage,
} from '../../src/index.js'
import type { CiphersuiteImpl } from '../../src/crypto/ciphersuite.js'
import { sampleCiphersuites } from '../helpers/suite-filter.js'
import { testClientConfig } from '../helpers/client-config.js'

// The UpdatePath sender encrypts its path secrets in batches of at most
// 512. A group of 600 built by one Add-only commit has no parent keys,
// so alice's next commit encrypts to every other leaf one by one: 599
// ciphertexts, ordered leaf 1, 2-3, 4-7, ... 256-511, then 512-599. The
// 512th and 513th ciphertexts are leaves 512 and 513, so those two sit
// on either side of the batch boundary.
const SUITE = 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519'
const SIZE = 600
const RECEIVERS = [1, 511, 512, 513, SIZE - 1]

for (const cs of sampleCiphersuites().filter(name => name === SUITE)) {
    test('an UpdatePath to more than 512 recipients reaches each of ' +
        `them ${cs}`, async (t) => {
        try {
            await batchBoundary(t)
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

function member (name:string, impl:CiphersuiteImpl) {
    return generateKeyPackage(
        {
            credentialType: 'basic',
            identity: new TextEncoder().encode(name),
        },
        defaultCapabilities(),
        defaultLifetime(),
        [],
        impl,
    )
}

async function join (
    welcome:Parameters<typeof joinGroup>[0],
    keys:{ publicPackage:KeyPackage, privatePackage:PrivateKeyPackage },
    impl:CiphersuiteImpl,
):Promise<ClientState> {
    return joinGroup(
        welcome,
        keys.publicPackage,
        keys.privatePackage,
        emptyPskIndex,
        impl,
        undefined,
        undefined,
        testClientConfig,
    )
}

async function batchBoundary (t:any) {
    const impl = await getCipherSuite(getCiphersuiteFromName(SUITE))
    const alice = await member('alice', impl)
    const created = await createGroup(
        new TextEncoder().encode('batch-boundary'),
        alice.publicPackage,
        alice.privatePackage,
        [],
        impl,
        testClientConfig,
    )

    const others = await Promise.all(
        Array.from({ length: SIZE - 1 }, (_, i) => member(`m-${i}`, impl))
    )
    const adds:Proposal[] = others.map(kp => ({
        proposalType: 'add',
        add: { keyPackage: kp.publicPackage },
    }))
    const added = await createCommit(
        { state: created, cipherSuite: impl },
        { extraProposals: adds, ratchetTreeExtension: true },
    )
    if (added.welcome === undefined) throw new Error('expected a Welcome')
    const welcome = added.welcome

    // leaf i is others[i - 1]
    const receivers = await Promise.all(
        RECEIVERS.map(leaf => join(welcome, others[leaf - 1]!, impl))
    )

    const committed = await createCommit(
        { state: added.newState, cipherSuite: impl },
    )
    const aliceNext = committed.newState
    const commit = committed.commit
    if (commit.wireformat !== 'mls_private_message' &&
        commit.wireformat !== 'mls_public_message') {
        throw new Error('expected a framed commit')
    }
    const sent = await createApplicationMessage(
        aliceNext,
        new TextEncoder().encode('after the boundary'),
        impl,
    )

    for (const [i, receiver] of receivers.entries()) {
        const leaf = RECEIVERS[i]
        const processed = await processMessage(
            commit,
            receiver,
            emptyPskIndex,
            acceptAll,
            impl,
        )
        if (processed.kind !== 'newState') {
            t.fail(`leaf ${leaf} should accept the commit`)
            continue
        }
        t.ok(processed.newState.groupContext.epoch ===
            aliceNext.groupContext.epoch,
        `leaf ${leaf} reaches alice's epoch`)

        const received = await processMessage(
            {
                wireformat: 'mls_private_message',
                privateMessage: sent.privateMessage,
            },
            processed.newState,
            emptyPskIndex,
            acceptAll,
            impl,
        )
        t.ok(received.kind === 'applicationMessage' &&
            new TextDecoder().decode(received.message) ===
                'after the boundary',
        `leaf ${leaf} reads alice's message in the new epoch`)
    }
}
