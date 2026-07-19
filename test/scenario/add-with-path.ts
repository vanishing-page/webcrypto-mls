import { test } from '@substrate-system/tapzero'
import { createGroup, joinGroup } from '../../src/client-state.js'
import { createCommit } from '../../src/create-commit.js'
import { processPublicMessage } from '../../src/process-messages.js'
import { emptyPskIndex } from '../../src/psk-index.js'
import type { Credential } from '../../src/credential.js'
import type { CiphersuiteName } from '../../src/crypto/ciphersuite.js'
import {
    ciphersuites,
    getCiphersuiteFromName
} from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import { generateKeyPackage } from '../../src/key-package.js'
import type { ProposalAdd, ProposalRemove } from '../../src/proposal.js'
import { defaultLifetime } from '../../src/lifetime.js'
import { defaultCapabilities } from '../../src/default-capabilities.js'

for (const cs of Object.keys(ciphersuites)) {
    test('Commit with Add and UpdatePath is decryptable by a pre-existing member ' + cs, async (t) => {
        try {
            await addWithPath(t, cs as CiphersuiteName)
        } catch (error:any) {
            if (error?.name === 'NotSupportedError' || error?.name === 'DependencyError') {
                t.comment(`Skipping ${cs}: ${error.message}`)
                return
            }
            throw error
        }
    })
}

async function makeMember (name:string, impl:any) {
    const credential:Credential = {
        credentialType: 'basic',
        identity: new TextEncoder().encode(name),
    }
    return generateKeyPackage(credential, defaultCapabilities(), defaultLifetime, [], impl)
}

async function addWithPath (t:any, cipherSuite:CiphersuiteName) {
    const impl = await getCipherSuite(getCiphersuiteFromName(cipherSuite))

    const alice = await makeMember('alice', impl)
    const bob = await makeMember('bob', impl)
    const eve = await makeMember('eve', impl)
    const charlie = await makeMember('charlie', impl)
    const dave = await makeMember('dave', impl)

    const groupId = new TextEncoder().encode('group1')

    let aliceGroup = await createGroup(
        groupId,
        alice.publicPackage,
        alice.privatePackage,
        [],
        impl,
    )

    // build a width-4 tree: [alice, bob, eve, charlie]. This is an Add-only
    // commit, so no UpdatePath is sent and the parent node covering
    // [eve, charlie] is left blank.
    const addBobEveCharlie = await createCommit(
        { state: aliceGroup, cipherSuite: impl },
        {
            extraProposals: [
                { proposalType: 'add', add: { keyPackage: bob.publicPackage } } satisfies ProposalAdd,
                { proposalType: 'add', add: { keyPackage: eve.publicPackage } } satisfies ProposalAdd,
                { proposalType: 'add', add: { keyPackage: charlie.publicPackage } } satisfies ProposalAdd,
            ],
        },
    )

    aliceGroup = addBobEveCharlie.newState

    const charlieGroup = await joinGroup(
        addBobEveCharlie.welcome!,
        charlie.publicPackage,
        charlie.privatePackage,
        emptyPskIndex,
        impl,
        aliceGroup.ratchetTree,
    )

    // eve is at leaf index 2 (alice=0, bob=1, eve=2, charlie=3): remove her,
    // freeing the lower-index leaf, then add dave -- who fills that freed
    // slot, landing to the left of charlie (leaf 3) inside the still-blank
    // [_, charlie] parent's copath resolution. This forces an UpdatePath
    // alongside an Add (remove requires a path) and puts the newly added
    // leaf (dave) *before* the pre-existing member (charlie) in the
    // resolution order -- exactly the ordering that exposes an
    // unfiltered-resolution index mismatch between sender and receiver.
    const removeEveAddDave = await createCommit(
        { state: aliceGroup, cipherSuite: impl },
        {
            wireAsPublicMessage: true,
            extraProposals: [
                { proposalType: 'remove', remove: { removed: 2 } } satisfies ProposalRemove,
                { proposalType: 'add', add: { keyPackage: dave.publicPackage } } satisfies ProposalAdd,
            ],
        },
    )

    aliceGroup = removeEveAddDave.newState

    if (removeEveAddDave.commit.wireformat !== 'mls_public_message') throw new Error('Expected public message')

    t.ok(
        removeEveAddDave.commit.publicMessage.content.contentType === 'commit' &&
            removeEveAddDave.commit.publicMessage.content.commit.path !== undefined,
        'commit should carry an UpdatePath',
    )

    const charlieProcessResult = await processPublicMessage(
        charlieGroup,
        removeEveAddDave.commit.publicMessage,
        emptyPskIndex,
        impl,
    )

    t.deepEqual(
        charlieProcessResult.newState.keySchedule.epochAuthenticator,
        aliceGroup.keySchedule.epochAuthenticator,
        'a pre-existing member (charlie) should decrypt the UpdatePath and reach the same epoch as the committer',
    )
}
