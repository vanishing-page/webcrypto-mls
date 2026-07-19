import { test } from '@substrate-system/tapzero'
import { createGroup, joinGroup, makePskIndex, validateRatchetTree } from '../../src/client-state.js'
import { createCommit } from '../../src/create-commit.js'
import { processPrivateMessage } from '../../src/process-messages.js'
import { emptyPskIndex } from '../../src/psk-index.js'
import type { Credential } from '../../src/credential.js'
import type { CiphersuiteName } from '../../src/crypto/ciphersuite.js'
import {
    ciphersuites,
    getCiphersuiteFromName
} from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import { generateKeyPackage } from '../../src/key-package.js'
import type { ProposalAdd } from '../../src/proposal.js'
import { defaultLifetime } from '../../src/lifetime.js'
import { defaultCapabilities } from '../../src/default-capabilities.js'
import { defaultLifetimeConfig } from '../../src/lifetime-config.js'
import { defaultAuthenticationService } from '../../src/authentication-service.js'
import { CryptoVerificationError } from '../../src/mls-error.js'
import { treeHashRoot } from '../../src/tree-hash.js'
import type { RatchetTree } from '../../src/ratchet-tree.js'

// RFC 9420 SS7.9.2: the parent hash of D is valid with respect to P only if,
// in addition to the hash-chain match, D is in the resolution of C (the
// child of P on D's side), and the intersection of P's unmerged_leaves with
// the subtree under C equals the resolution of C with D removed. This test
// builds a tree with a genuine, valid parent-hash chain, then tampers with a
// non-blank parent node's unmerged_leaves to smuggle in a leaf that is not
// actually part of the resolution -- the classic H2 attack. The tree hash is
// recomputed from the tampered tree so it stays self-consistent (a real
// malicious inviter would craft both the tree and its GroupInfo tree_hash
// together), and the hash chain itself remains untouched, so this only fails
// the new resolution/unmerged-leaves criterion, not the pre-existing checks.
for (const cs of Object.keys(ciphersuites)) {
    test('rejects tree that passes hash chain but violates unmerged-leaves ' +
        'resolution criterion (H2) - ' + cs, async (t) => {
        try {
            await tamperedUnmergedLeaves(t, cs as CiphersuiteName)
        } catch (error:any) {
            if (error?.name === 'NotSupportedError' || error?.name === 'DependencyError') {
                t.comment(`Skipping ${cs}: ${error.message}`)
                return
            }
            throw error
        }
    })
}

async function tamperedUnmergedLeaves (t:any, cipherSuite:CiphersuiteName) {
    const impl = await getCipherSuite(getCiphersuiteFromName(cipherSuite))

    async function makeMember (name:string) {
        const credential:Credential = {
            credentialType: 'basic',
            identity: new TextEncoder().encode(name),
        }
        return generateKeyPackage(
            credential,
            defaultCapabilities(),
            defaultLifetime,
            [],
            impl,
        )
    }

    const alice = await makeMember('alice')
    const bob = await makeMember('bob')
    const charlie = await makeMember('charlie')
    const dave = await makeMember('dave')

    const groupId = new TextEncoder().encode('group1')

    let aliceGroup = await createGroup(
        groupId,
        alice.publicPackage,
        alice.privatePackage,
        [],
        impl,
    )

    const addBobProposal:ProposalAdd = {
        proposalType: 'add',
        add: { keyPackage: bob.publicPackage },
    }
    const addCharlieProposal:ProposalAdd = {
        proposalType: 'add',
        add: { keyPackage: charlie.publicPackage },
    }
    const addDaveProposal:ProposalAdd = {
        proposalType: 'add',
        add: { keyPackage: dave.publicPackage },
    }

    // Reach a 4-leaf tree (tree.length === 7): alice, bob, charlie, dave.
    const addAllCommitResult = await createCommit(
        { state: aliceGroup, cipherSuite: impl },
        { extraProposals: [addBobProposal, addCharlieProposal, addDaveProposal] },
    )

    aliceGroup = addAllCommitResult.newState

    const bobJoinGroup = await joinGroup(
        addAllCommitResult.welcome!,
        bob.publicPackage,
        bob.privatePackage,
        emptyPskIndex,
        impl,
        aliceGroup.ratchetTree,
    )

    // A follow-up empty-proposal commit gives alice's own leaf node a
    // 'commit'-sourced parent hash chained all the way to the root, which is
    // the chain the H2 criterion needs to be checked against.
    const updatePathCommitResult = await createCommit({
        state: aliceGroup,
        cipherSuite: impl,
    })

    if (updatePathCommitResult.commit.wireformat !== 'mls_private_message') {
        throw new Error('Expected private message')
    }

    aliceGroup = updatePathCommitResult.newState

    const bobProcessResult = await processPrivateMessage(
        bobJoinGroup,
        updatePathCommitResult.commit.privateMessage,
        makePskIndex(bobJoinGroup, {}),
        impl,
    )

    // Sanity check the honestly-generated tree validates cleanly first.
    const honestError = await validateRatchetTree(
        aliceGroup.ratchetTree,
        aliceGroup.groupContext,
        defaultLifetimeConfig,
        defaultAuthenticationService,
        await treeHashRoot(aliceGroup.ratchetTree, impl.hash),
        impl,
    )
    t.equal(honestError, undefined, 'honestly-generated tree should validate')
    t.deepEqual(
        bobProcessResult.newState.keySchedule.epochAuthenticator,
        aliceGroup.keySchedule.epochAuthenticator,
        'sanity check: bob converges with alice before tampering',
    )

    // Root is node index 3 in a 4-leaf tree; alice (leaf 0) and bob (leaf 1)
    // are its left child's (node 1) subtree. Root's stored parent hash and
    // hash chain are untouched by this tamper: root's unmerged_leaves only
    // feeds into the *sibling* (node 5, charlie/dave's side) tree hash
    // computation used by the existing hash-chain check, and bob's leaf
    // (index 1) is not under node 5, so the pre-existing chain check still
    // passes. Only the new resolution/unmerged-leaves intersection check --
    // which looks at root's *own* child subtree (node 1) -- catches this.
    const tamperedTree:RatchetTree = aliceGroup.ratchetTree.map((n) => {
        if (n?.nodeType !== 'parent') return n
        return { ...n, parent: { ...n.parent, unmergedLeaves: [...n.parent.unmergedLeaves] } }
    })
    const rootIndex = 3
    const rootNode = tamperedTree[rootIndex]
    if (rootNode === undefined || rootNode.nodeType !== 'parent') {
        throw new Error('Expected root to be a non-blank parent node')
    }
    rootNode.parent.unmergedLeaves = [...rootNode.parent.unmergedLeaves, 1]

    const tamperedTreeHash = await treeHashRoot(tamperedTree, impl.hash)

    const error = await validateRatchetTree(
        tamperedTree,
        aliceGroup.groupContext,
        defaultLifetimeConfig,
        defaultAuthenticationService,
        tamperedTreeHash,
        impl,
    )

    t.ok(error instanceof CryptoVerificationError,
        'should reject a tree that violates the unmerged-leaves resolution criterion')
}
