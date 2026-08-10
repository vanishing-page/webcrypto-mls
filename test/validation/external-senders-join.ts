import { test } from '@substrate-system/tapzero'
import { createGroup, joinGroup } from '../../src/client-state.js'
import {
    createGroupInfoWithExternalPubAndRatchetTree,
    joinGroupExternal,
    createCommit
} from '../../src/create-commit.js'
import { emptyPskIndex } from '../../src/psk-index.js'
import type { ClientConfig } from '../../src/client-config.js'
import { defaultClientConfig } from '../../src/client-config.js'
import type { Credential } from '../../src/credential.js'
import type { CiphersuiteName } from '../../src/crypto/ciphersuite.js'
import { getCiphersuiteFromName } from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import { generateKeyPackage } from '../../src/key-package.js'
import type { ProposalAdd } from '../../src/proposal.js'
import { defaultLifetime } from '../../src/lifetime.js'
import { defaultCapabilities } from '../../src/default-capabilities.js'
import type { ExternalSender } from '../../src/external-sender.js'
import { encodeExternalSenders } from '../../src/external-sender.js'
import type { Extension } from '../../src/extension.js'
import { ValidationError } from '../../src/mls-error.js'
import { testCiphersuites } from '../helpers/suite-filter.js'
import { testClientConfig } from '../helpers/client-config.js'

const UNVETTED = 'unvetted-external'

/**
 * Accepts every credential except the one belonging to the external
 * sender the group advertises. A joiner running this config trusts the
 * members it finds in the tree but not the external identity that is
 * allowed to sign proposals into the group.
 */
const rejectExternalSenderConfig:ClientConfig = {
    ...defaultClientConfig,
    authService: {
        async validateCredential (credential:Credential):Promise<boolean> {
            if (credential.credentialType !== 'basic') return true
            return (
                new TextDecoder().decode(credential.identity) !== UNVETTED
            )
        },
    },
}

for (const cs of testCiphersuites()) {
    test(`external_senders validated on join ${cs}`, async (t) => {
        try {
            await externalSendersOnJoin(cs as CiphersuiteName, t)
        } catch (error:any) {
            if (
                error?.name === 'NotSupportedError' ||
                error?.name === 'DependencyError'
            ) {
                t.comment(`Skipping ${cs}: ${error.message}`)
                return
            }
            throw error
        }
    })
}

async function externalSendersOnJoin (cipherSuite:CiphersuiteName, t:any) {
    const impl = await getCipherSuite(getCiphersuiteFromName(cipherSuite))

    const makeMember = async (name:string) => {
        const credential:Credential = {
            credentialType: 'basic',
            identity: new TextEncoder().encode(name),
        }
        const kp = await generateKeyPackage(
            credential,
            defaultCapabilities(),
            defaultLifetime(),
            [],
            impl,
        )
        return { credential, ...kp }
    }

    const alice = await makeMember('alice')
    const bob = await makeMember('bob')
    const carol = await makeMember('carol')
    const dave = await makeMember('dave')
    const evil = await makeMember(UNVETTED)

    const externalSender:ExternalSender = {
        credential: evil.credential,
        signaturePublicKey: evil.publicPackage.leafNode.signaturePublicKey,
    }

    const extension:Extension = {
        extensionType: 'external_senders',
        extensionData: encodeExternalSenders([externalSender]),
    }

    const groupId = new TextEncoder().encode('external-senders-join')

    let aliceGroup = await createGroup(
        groupId,
        alice.publicPackage,
        alice.privatePackage,
        [extension],
        impl,
        testClientConfig,
    )

    const addMember = async (kp:typeof bob) => {
        const proposal:ProposalAdd = {
            proposalType: 'add',
            add: { keyPackage: kp.publicPackage },
        }
        const result = await createCommit(
            { state: aliceGroup, cipherSuite: impl },
            { extraProposals: [proposal] },
        )
        aliceGroup = result.newState
        return result
    }

    // a joiner that does trust the external sender still gets in
    const bobCommit = await addMember(bob)
    const bobGroup = await joinGroup(
        bobCommit.welcome!,
        bob.publicPackage,
        bob.privatePackage,
        emptyPskIndex,
        impl,
        aliceGroup.ratchetTree,
        undefined,
        testClientConfig,
    )
    t.equal(
        bobGroup.groupContext.epoch,
        aliceGroup.groupContext.epoch,
        'a joiner that trusts the external sender joins normally',
    )

    // a joiner that does not trust the external sender is rejected
    const carolCommit = await addMember(carol)
    try {
        await joinGroup(
            carolCommit.welcome!,
            carol.publicPackage,
            carol.privatePackage,
            emptyPskIndex,
            impl,
            aliceGroup.ratchetTree,
            undefined,
            rejectExternalSenderConfig,
        )
        t.fail('joinGroup should reject an unvetted external sender')
    } catch (err) {
        t.ok(
            err instanceof ValidationError,
            'joinGroup throws ValidationError for an unvetted external sender',
        )
    }

    // the same check applies to an external commit join
    const groupInfo = await createGroupInfoWithExternalPubAndRatchetTree(
        aliceGroup,
        [],
        impl,
    )

    try {
        await joinGroupExternal(
            groupInfo,
            dave.publicPackage,
            dave.privatePackage,
            false,
            impl,
            undefined,
            rejectExternalSenderConfig,
        )
        t.fail('joinGroupExternal should reject an unvetted external sender')
    } catch (err) {
        t.ok(
            err instanceof ValidationError,
            'joinGroupExternal throws ValidationError for an unvetted ' +
                'external sender',
        )
    }

    const daveJoin = await joinGroupExternal(
        groupInfo,
        dave.publicPackage,
        dave.privatePackage,
        false,
        impl,
        undefined,
        testClientConfig,
    )
    t.ok(
        daveJoin.newState.groupActiveState.kind === 'active',
        'an external joiner that trusts the external sender still joins',
    )
}
