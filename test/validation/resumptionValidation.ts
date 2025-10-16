import { test } from '@substrate-system/tapzero'
import type { ClientState } from '../../src/clientState.js'
import { createGroup, joinGroup, makePskIndex } from '../../src/clientState.js'
import { createCommit } from '../../src/createCommit.js'
import { emptyPskIndex } from '../../src/pskIndex.js'
import { joinGroupFromReinit, reinitCreateNewGroup, reinitGroup } from '../../src/resumption.js'
import type { Credential } from '../../src/credential.js'
import type { CiphersuiteName } from '../../src/crypto/ciphersuite.js'
import { ciphersuites, getCiphersuiteFromName } from '../../src/crypto/ciphersuite.js'
import { getCiphersuiteImpl } from '../../src/crypto/getCiphersuiteImpl.js'
import { generateKeyPackage } from '../../src/keyPackage.js'
import type { ProposalAdd } from '../../src/proposal.js'
import { defaultLifetime } from '../../src/lifetime.js'
import { defaultCapabilities } from '../../src/defaultCapabilities.js'
import { processMessage } from '../../src/processMessages.js'
import { acceptAll } from '../../src/incomingMessageAction.js'

import type { ProtocolVersionName } from '../../src/protocolVersion.js'
import { ValidationError } from '../../src/mlsError.js'

// Convert test.concurrent.each to individual tests
for (const cs of Object.keys(ciphersuites)) {
    test(`Reinit Validation - ${cs}`, async (t) => {
        const cipherSuite = cs as CiphersuiteName
        const impl = await getCiphersuiteImpl(getCiphersuiteFromName(cipherSuite))

        const aliceCredential: Credential = { credentialType: 'basic', identity: new TextEncoder().encode('alice') }
        const alice = await generateKeyPackage(aliceCredential, defaultCapabilities(), defaultLifetime, [], impl)

        const groupId = new TextEncoder().encode('group1')

        let aliceGroup = await createGroup(groupId, alice.publicPackage, alice.privatePackage, [], impl)

        const bobCredential: Credential = { credentialType: 'basic', identity: new TextEncoder().encode('bob') }
        const bob = await generateKeyPackage(bobCredential, defaultCapabilities(), defaultLifetime, [], impl)

        const addBobProposal: ProposalAdd = {
            proposalType: 'add',
            add: {
                keyPackage: bob.publicPackage,
            },
        }

        const commitResult = await createCommit(
            {
                state: aliceGroup,
                cipherSuite: impl,
            },
            { extraProposals: [addBobProposal] },
        )

        aliceGroup = commitResult.newState

        let bobGroup = await joinGroup(
      commitResult.welcome!,
      bob.publicPackage,
      bob.privatePackage,
      emptyPskIndex,
      impl,
      aliceGroup.ratchetTree,
        )

        const bobCommitResult = await createCommit({
            state: bobGroup,
            cipherSuite: impl,
        })

        bobGroup = bobCommitResult.newState

        if (bobCommitResult.commit.wireformat !== 'mls_private_message') throw new Error('Expected private message')

        const processBobCommitResult = await processMessage(
            bobCommitResult.commit,
            aliceGroup,
            emptyPskIndex,
            acceptAll,
            impl,
        )

        aliceGroup = processBobCommitResult.newState

        const bobNewKeyPackage = await generateKeyPackage(bobCredential, defaultCapabilities(), defaultLifetime, [], impl)

        const aliceNewKeyPackage = await generateKeyPackage(aliceCredential, defaultCapabilities(), defaultLifetime, [], impl)

        const newGroupId = new TextEncoder().encode('new-group1')

        const reinitCommitResult = await reinitGroup(aliceGroup, newGroupId, 'mls10', cipherSuite, [], impl)

        aliceGroup = reinitCommitResult.newState

        if (reinitCommitResult.commit.wireformat !== 'mls_private_message') throw new Error('Expected private message')

        const processReinitResult = await processMessage(
            reinitCommitResult.commit,
            bobGroup,
            makePskIndex(bobGroup, {}),
            acceptAll,
            impl,
        )

        bobGroup = processReinitResult.newState

        t.equal(bobGroup.groupActiveState.kind, 'suspendedPendingReinit', 'bobGroup should be suspendedPendingReinit')
        t.equal(aliceGroup.groupActiveState.kind, 'suspendedPendingReinit', 'aliceGroup should be suspendedPendingReinit')

        const resumeGroupResult = await reinitCreateNewGroup(
            aliceGroup,
            aliceNewKeyPackage.publicPackage,
            aliceNewKeyPackage.privatePackage,
            [bobNewKeyPackage.publicPackage],
            newGroupId,
            cipherSuite,
            [],
        )

        aliceGroup = resumeGroupResult.newState

        const reinit =
      bobGroup.groupActiveState.kind === 'suspendedPendingReinit' ? bobGroup.groupActiveState.reinit : undefined

        const bobGroupIdChanged: ClientState = {
            ...bobGroup,
            groupActiveState: {
                kind: 'suspendedPendingReinit',
                reinit: { ...reinit!, groupId: new TextEncoder().encode('group-bad') },
            },
        }

        try {
            await joinGroupFromReinit(
                bobGroupIdChanged,
        resumeGroupResult.welcome!,
        bobNewKeyPackage.publicPackage,
        bobNewKeyPackage.privatePackage,
        aliceGroup.ratchetTree,
            )
            t.fail('should have thrown ValidationError for groupId change')
        } catch (error) {
            t.ok(error instanceof ValidationError, 'should throw ValidationError when groupId is changed')
        }

        const bobVersionChanged: ClientState = {
            ...bobGroup,
            groupActiveState: {
                kind: 'suspendedPendingReinit',
                reinit: { ...reinit!, version: 'mls2' as ProtocolVersionName },
            },
        }

        try {
            await joinGroupFromReinit(
                bobVersionChanged,
        resumeGroupResult.welcome!,
        bobNewKeyPackage.publicPackage,
        bobNewKeyPackage.privatePackage,
        aliceGroup.ratchetTree,
            )
            t.fail('should have thrown ValidationError for version change')
        } catch (error) {
            t.ok(error instanceof ValidationError, 'should throw ValidationError when version is changed')
        }

        const bobExtensionsChanged: ClientState = {
            ...bobGroup,
            groupActiveState: {
                kind: 'suspendedPendingReinit',
                reinit: { ...reinit!, extensions: [{ extensionType: 17, extensionData: new Uint8Array([1]) }] },
            },
        }

        try {
            await joinGroupFromReinit(
                bobExtensionsChanged,
        resumeGroupResult.welcome!,
        bobNewKeyPackage.publicPackage,
        bobNewKeyPackage.privatePackage,
        aliceGroup.ratchetTree,
            )
            t.fail('should have thrown ValidationError for extensions change')
        } catch (error) {
            t.ok(error instanceof ValidationError, 'should throw ValidationError when extensions are changed')
        }
    })
}
