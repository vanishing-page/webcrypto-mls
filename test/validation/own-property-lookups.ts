import { test } from '@substrate-system/tapzero'
import { skipReason } from '../helpers/skip.js'
import type { ClientState } from '../../src/client-state.js'
import {
    createGroup,
    joinGroup,
    makePskIndex
} from '../../src/client-state.js'
import { createCommit } from '../../src/create-commit.js'
import { processPrivateMessage } from '../../src/process-messages.js'
import { emptyPskIndex } from '../../src/psk-index.js'
import type {
    CiphersuiteImpl,
    CiphersuiteName
} from '../../src/crypto/ciphersuite.js'
import {
    getCiphersuiteFromName
} from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import { generateKeyPackage } from '../../src/key-package.js'
import type { Proposal } from '../../src/proposal.js'
import { defaultLifetime } from '../../src/lifetime.js'
import { defaultCapabilities } from '../../src/default-capabilities.js'
import { ValidationError } from '../../src/mls-error.js'
import { base64ToBytes } from '../../src/util/byte-array.js'
import { sampleCiphersuites } from '../helpers/suite-filter.js'
import { testClientConfig } from '../helpers/client-config.js'

// Valid base64 strings that name Object.prototype members. An id that
// spells one of these must be treated like any other unknown id.
const PROTO_NAMES = ['toString', 'propertyIsEnumerable']

for (const cs of sampleCiphersuites()) {
    test(`own-property lookups for refs and PSK ids ${cs}`, async (t) => {
        try {
            await run(cs, t)
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

async function member (name:string, impl:CiphersuiteImpl) {
    return generateKeyPackage(
        { credentialType: 'basic', identity: new TextEncoder().encode(name) },
        defaultCapabilities(),
        defaultLifetime(),
        [],
        impl
    )
}

async function expectValidationError (
    t:any,
    p:Promise<unknown>,
    msg:string
) {
    try {
        await p
        t.fail(`${msg}: resolved`)
    } catch (err) {
        t.ok(err instanceof ValidationError, `${msg}: ValidationError`)
    }
}

async function run (cs:CiphersuiteName, t:any) {
    const impl = await getCipherSuite(getCiphersuiteFromName(cs))
    const alice = await member('alice', impl)
    const bob = await member('bob', impl)

    let aliceGroup = await createGroup(
        new TextEncoder().encode('group1'),
        alice.publicPackage,
        alice.privatePackage,
        [],
        impl,
        testClientConfig
    )
    const add = await createCommit(
        { state: aliceGroup, cipherSuite: impl },
        {
            extraProposals: [{
                proposalType: 'add',
                add: { keyPackage: bob.publicPackage }
            }]
        }
    )
    aliceGroup = add.newState
    const bobGroup = await joinGroup(
        add.welcome!,
        bob.publicPackage,
        bob.privatePackage,
        emptyPskIndex,
        impl,
        aliceGroup.ratchetTree,
        undefined,
        testClientConfig
    )

    for (const name of PROTO_NAMES) {
        // Alice holds a pending proposal under a reference that spells
        // an Object.prototype member; Bob has never seen it.
        const charlie = await member('charlie', impl)
        const hostile:ClientState = {
            ...aliceGroup,
            unappliedProposals: {
                [name]: {
                    proposal: {
                        proposalType: 'add',
                        add: { keyPackage: charlie.publicPackage }
                    },
                    senderLeafIndex: 0,
                    senderType: 'member'
                }
            }
        }
        const byRef = await createCommit(
            { state: hostile, cipherSuite: impl },
            {}
        )
        if (byRef.commit.wireformat !== 'mls_private_message') {
            throw new Error('Expected private message')
        }
        await expectValidationError(
            t,
            processPrivateMessage(
                bobGroup,
                byRef.commit.privateMessage,
                emptyPskIndex,
                impl
            ),
            `commit referencing proposal ${name}`
        )

        // A PSK whose id spells an Object.prototype member, supplied to
        // Alice but not to Bob or the joiner.
        const dave = await member('dave', impl)
        const psk:Proposal = {
            proposalType: 'psk',
            psk: {
                preSharedKeyId: {
                    psktype: 'external',
                    pskId: base64ToBytes(name),
                    pskNonce: impl.rng.randomBytes(impl.kdf.size)
                }
            }
        }
        const pskCommit = await createCommit(
            {
                state: aliceGroup,
                cipherSuite: impl,
                pskIndex: makePskIndex(aliceGroup, {
                    [name]: impl.rng.randomBytes(impl.kdf.size)
                })
            },
            {
                extraProposals: [psk, {
                    proposalType: 'add',
                    add: { keyPackage: dave.publicPackage }
                }]
            }
        )
        if (pskCommit.commit.wireformat !== 'mls_private_message') {
            throw new Error('Expected private message')
        }
        await expectValidationError(
            t,
            processPrivateMessage(
                bobGroup,
                pskCommit.commit.privateMessage,
                makePskIndex(bobGroup, {}),
                impl
            ),
            `commit naming external PSK ${name}`
        )
        await expectValidationError(
            t,
            joinGroup(
                pskCommit.welcome!,
                dave.publicPackage,
                dave.privatePackage,
                makePskIndex(undefined, {}),
                impl,
                pskCommit.newState.ratchetTree,
                undefined,
                testClientConfig
            ),
            `Welcome naming external PSK ${name}`
        )
    }
}
