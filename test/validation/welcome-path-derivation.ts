/**
 * RFC 9420 SS12.4.3.1: the path secret a joiner finds in its GroupSecrets
 * sits at the lowest node it shares with the committer, and the joiner
 * derives the rest of its path by walking the committer's *filtered*
 * direct path -- the same walk the commit path uses.
 *
 * See security-audit.md L6. The Welcome side used to walk to the
 * geometric root instead, via the first non-blank ancestor. The two walks
 * agree on any tree an honest committer produces, but they diverge as
 * soon as a non-blank node sits above the end of the committer's filtered
 * direct path: that node was not rotated by this commit, so folding it in
 * either derives a key the tree does not advertise, or -- when nothing
 * above the filtered path is populated at all -- stores a private key for
 * a blank node index that no longer exists in the tree.
 *
 * Both shapes are exercised here against `deriveWelcomePrivateKeyPath`,
 * the seam `joinGroup` uses. They are built by blanking the left half of
 * a four-member tree, which leaves the committer (leaf 2) with a filtered
 * direct path that stops below the root: the root's copath resolution is
 * empty, so an honest commit leaves the root alone. A committer can not
 * hand out such a tree through the public API -- `removeLeafNode`
 * condenses a fully blank right subtree away, and a fully blank left
 * subtree is where the next Add lands, which repopulates the root's
 * copath -- so the divergence is only reachable from a forged tree, and
 * the check is defence in depth.
 */
import { test } from '@substrate-system/tapzero'
import { createGroup, joinGroup, makePskIndex } from '../../src/client-state.js'
import { createCommit } from '../../src/create-commit.js'
import { processPrivateMessage } from '../../src/process-messages.js'
import { createUpdatePath } from '../../src/update-path.js'
import { deriveWelcomePrivateKeyPath } from '../../src/private-key-path.js'
import type { PrivateKeyPath } from '../../src/private-key-path.js'
import type { RatchetTree } from '../../src/ratchet-tree.js'
import { emptyPskIndex } from '../../src/psk-index.js'
import type { Credential } from '../../src/credential.js'
import type { CiphersuiteName } from '../../src/crypto/ciphersuite.js'
import { getCiphersuiteFromName } from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import { generateKeyPackage } from '../../src/key-package.js'
import type { ProposalAdd } from '../../src/proposal.js'
import { defaultLifetime } from '../../src/lifetime.js'
import { defaultCapabilities } from '../../src/default-capabilities.js'
import { toLeafIndex, toNodeIndex } from '../../src/treemath.js'
import { sampleCiphersuites } from '../helpers/suite-filter.js'
import { testClientConfig } from '../helpers/client-config.js'

// leaf 2 lives at node 4, its parent is node 5, the root of a four leaf
// tree is node 3
const COMMITTER_LEAF = 2
const COMMITTER_PARENT = 5
const ROOT = 3
const JOINER_LEAF = 3
const JOINER_NODE = 6

for (const cs of sampleCiphersuites()) {
    test('a Welcome path secret stops where the committer\'s filtered ' +
        'direct path stops - ' + cs, async (t) => {
        try {
            await stopsAtFilteredPathEnd(t, cs as CiphersuiteName)
        } catch (error:any) {
            if (skippable(error)) {
                t.comment(`Skipping ${cs}: ${error.message}`)
                return
            }
            throw error
        }
    })

    test('a Welcome path secret stores no key for a blank node - ' + cs,
        async (t) => {
            try {
                await storesNoKeyForBlankNodes(t, cs as CiphersuiteName)
            } catch (error:any) {
                if (skippable(error)) {
                    t.comment(`Skipping ${cs}: ${error.message}`)
                    return
                }
                throw error
            }
        })

    test('an honest four member Welcome still joins and decrypts - ' + cs,
        async (t) => {
            try {
                await honestJoinStillWorks(t, cs as CiphersuiteName)
            } catch (error:any) {
                if (skippable(error)) {
                    t.comment(`Skipping ${cs}: ${error.message}`)
                    return
                }
                throw error
            }
        })
}

function skippable (error:any):boolean {
    return error?.name === 'NotSupportedError' || error?.name === 'DependencyError'
}

async function makeMember (name:string, impl:any) {
    const credential:Credential = {
        credentialType: 'basic',
        identity: new TextEncoder().encode(name),
    }
    return generateKeyPackage(credential, defaultCapabilities(),
        defaultLifetime(), [], impl)
}

/**
 * Four members, followed by an empty commit from leaf 0 and one from leaf
 * 2, so that every parent node in the seven node tree is populated. Adds
 * alone carry no UpdatePath, so without those two commits the parents
 * stay blank.
 */
async function makeFourMemberGroup (cipherSuite:CiphersuiteName) {
    const impl = await getCipherSuite(getCiphersuiteFromName(cipherSuite))

    const alice = await makeMember('alice', impl)
    const others = await Promise.all(
        ['bob', 'carol', 'dave'].map((name) => makeMember(name, impl)),
    )

    const groupId = new TextEncoder().encode('welcome-path-derivation')

    let committer = await createGroup(groupId, alice.publicPackage,
        alice.privatePackage, [], impl, testClientConfig)

    const joined:typeof committer[] = []

    for (const member of others) {
        const commit = await createCommit(
            { state: committer, cipherSuite: impl },
            {
                extraProposals: [
                    {
                        proposalType: 'add',
                        add: { keyPackage: member.publicPackage },
                    } satisfies ProposalAdd,
                ],
            },
        )

        if (commit.welcome === undefined) throw new Error('Expected a welcome')

        for (const [index, state] of joined.entries()) {
            if (commit.commit.wireformat !== 'mls_private_message') {
                throw new Error('expected a private message commit')
            }
            const result = await processPrivateMessage(state,
                commit.commit.privateMessage, makePskIndex(state, {}), impl)
            if (result.kind !== 'newState') throw new Error('expected a commit')
            joined[index] = result.newState
        }

        committer = commit.newState

        joined.push(await joinGroup(
            commit.welcome,
            member.publicPackage,
            member.privatePackage,
            emptyPskIndex,
            impl,
            committer.ratchetTree,
            undefined,
            testClientConfig,
        ))
    }

    const all = [committer, ...joined]

    for (const committerIndex of [0, COMMITTER_LEAF]) {
        const commit = await createCommit({
            state: all[committerIndex]!,
            cipherSuite: impl,
        })

        if (commit.commit.wireformat !== 'mls_private_message') {
            throw new Error('expected a private message commit')
        }

        for (const [index, state] of all.entries()) {
            if (index === committerIndex) continue
            const result = await processPrivateMessage(state,
                commit.commit.privateMessage, makePskIndex(state, {}), impl)
            if (result.kind !== 'newState') throw new Error('expected a commit')
            all[index] = result.newState
        }

        all[committerIndex] = commit.newState
    }

    return { impl, alice: all[0]!, members: all.slice(1) }
}

/**
 * Blanks the whole left half of the four leaf tree -- leaves 0 and 1 and
 * their parent -- so the root's copath resolution, seen from leaf 2, is
 * empty and the root falls out of leaf 2's filtered direct path.
 * `keepRoot` decides whether the root is left populated (a stale key from
 * an earlier epoch) or blanked.
 */
function blankLeftHalf (tree:RatchetTree, keepRoot:boolean):RatchetTree {
    const copy = tree.slice()
    copy[0] = undefined
    copy[1] = undefined
    copy[2] = undefined
    if (!keepRoot) copy[ROOT] = undefined
    return copy
}

/**
 * Runs an honest UpdatePath by leaf 2 over the given tree and returns the
 * resulting tree plus the path secret for leaf 2's parent, which is what a
 * joiner at leaf 3 would find in its GroupSecrets.
 */
async function committerPathSecret (tree:RatchetTree, group:any, impl:any) {
    const [updatedTree, , secrets] = await createUpdatePath(
        tree,
        toLeafIndex(COMMITTER_LEAF),
        group.groupContext,
        group.signaturePrivateKey,
        impl,
    )

    const secret = secrets.find((s) => s.nodeIndex === COMMITTER_PARENT)
    if (secret === undefined) {
        throw new Error('expected a path secret for the committer\'s parent')
    }

    return { updatedTree, secret: secret.secret, secrets }
}

function joinerBasePath (privateKey:Uint8Array):PrivateKeyPath {
    return { leafIndex: JOINER_LEAF, privateKeys: { [JOINER_NODE]: privateKey } }
}

async function stopsAtFilteredPathEnd (t:any, cipherSuite:CiphersuiteName) {
    const { impl, members } = await makeFourMemberGroup(cipherSuite)

    const carol = members[1]!
    const dave = members[2]!

    const tampered = blankLeftHalf(carol.ratchetTree, true)
    t.ok(tampered[ROOT] !== undefined,
        'the root should still hold a stale key from an earlier epoch')

    const { updatedTree, secret, secrets } =
        await committerPathSecret(tampered, carol, impl)

    t.equal(secrets.length, 1,
        'the committer\'s filtered direct path should stop below the root')

    const derived = await deriveWelcomePrivateKeyPath(
        updatedTree,
        toLeafIndex(COMMITTER_LEAF),
        toNodeIndex(COMMITTER_PARENT),
        secret,
        joinerBasePath(dave.privatePath.privateKeys[JOINER_NODE]!),
        impl,
    )

    t.deepEqual(
        Object.keys(derived.privateKeys).map(Number).sort((a, b) => a - b),
        [COMMITTER_PARENT, JOINER_NODE].sort((a, b) => a - b),
        'the joiner should hold keys for its own leaf and the shared ' +
        'parent, and nothing above the committer\'s filtered direct path',
    )
}

async function storesNoKeyForBlankNodes (t:any, cipherSuite:CiphersuiteName) {
    const { impl, members } = await makeFourMemberGroup(cipherSuite)

    const carol = members[1]!
    const dave = members[2]!

    const tampered = blankLeftHalf(carol.ratchetTree, false)

    const { updatedTree, secret } =
        await committerPathSecret(tampered, carol, impl)

    t.equal(updatedTree[ROOT], undefined,
        'the root should be blank after an UpdatePath that skips it')

    const derived = await deriveWelcomePrivateKeyPath(
        updatedTree,
        toLeafIndex(COMMITTER_LEAF),
        toNodeIndex(COMMITTER_PARENT),
        secret,
        joinerBasePath(dave.privatePath.privateKeys[JOINER_NODE]!),
        impl,
    )

    t.equal(derived.privateKeys[ROOT], undefined,
        'no private key should be stored for the blank root')

    for (const nodeIndex of Object.keys(derived.privateKeys).map(Number)) {
        t.ok(updatedTree[nodeIndex] !== undefined,
            `node ${nodeIndex} should be non-blank in the tree`)
    }
}

async function honestJoinStillWorks (t:any, cipherSuite:CiphersuiteName) {
    const { impl, alice, members } = await makeFourMemberGroup(cipherSuite)

    const dave = members[2]!

    t.equal(dave.groupContext.epoch, alice.groupContext.epoch,
        'the last joiner should be at the committer\'s epoch')

    const commit = await createCommit({ state: alice, cipherSuite: impl })
    if (commit.commit.wireformat !== 'mls_private_message') {
        throw new Error('expected a private message commit')
    }

    const result = await processPrivateMessage(dave,
        commit.commit.privateMessage, makePskIndex(dave, {}), impl)

    t.equal(result.kind, 'newState',
        'the joiner should be able to process the next commit')
}
