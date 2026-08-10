/**
 * RFC 9420 SS7.5 / SS12.4.3.1: a receiver that decrypts a path secret from
 * an UpdatePath MUST check that the key pair it derives for each node
 * equals the `hpkePublicKey` the committer advertised for that node.
 *
 * See security-audit.md M2. Without the check, a malicious committer can
 * publish an UpdatePath whose advertised keys it controls while the
 * encrypted path secret it sends to victim V derives to something else.
 * V accepts the epoch and then holds a private path that cannot decrypt
 * any later commit -- a silent, targeted split of the group.
 *
 * The malicious commit here is built from two honestly generated
 * UpdatePaths over the same tree. The advertised public keys, parent
 * hashes and signed leaf node come from path A; the path secrets sent to
 * the receiver are path B's, re-encrypted under path A's group context so
 * the AEAD's associated data still binds the advertised tree hash. Every
 * structural check (leaf signature, key uniqueness, parent hash chain,
 * ciphertext decryption) therefore passes, and the mismatch is visible
 * only to a receiver that compares its derived keys against the
 * advertised ones.
 */
import { test } from '@substrate-system/tapzero'
import { createGroup, joinGroup, makePskIndex, nextEpochContext } from '../../src/client-state.js'
import { initializeEpoch } from '../../src/key-schedule.js'
import { deriveSecret } from '../../src/crypto/kdf.js'
import { createCommit } from '../../src/create-commit.js'
import { createUpdatePath } from '../../src/update-path.js'
import type { UpdatePath } from '../../src/update-path.js'
import { createConfirmationTag, createContentCommitSignature } from '../../src/framed-content.js'
import type { GroupContext } from '../../src/group-context.js'
import { encodeGroupContext } from '../../src/group-context.js'
import { encryptWithLabel } from '../../src/crypto/hpke.js'
import { getHpkePublicKey } from '../../src/ratchet-tree.js'
import { treeHashRoot } from '../../src/tree-hash.js'
import { protectPublicMessage } from '../../src/message-protection-public.js'
import { processMessage } from '../../src/process-messages.js'
import { emptyPskIndex } from '../../src/psk-index.js'
import type { Credential } from '../../src/credential.js'
import type { CiphersuiteName } from '../../src/crypto/ciphersuite.js'
import { getCiphersuiteFromName } from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import { generateKeyPackage } from '../../src/key-package.js'
import type { ProposalAdd } from '../../src/proposal.js'
import { defaultLifetime } from '../../src/lifetime.js'
import { defaultCapabilities } from '../../src/default-capabilities.js'
import { ValidationError } from '../../src/mls-error.js'
import { toLeafIndex } from '../../src/treemath.js'
import { sampleCiphersuites } from '../helpers/suite-filter.js'
import { testClientConfig } from '../helpers/client-config.js'

const MISMATCH = 'Derived public key does not match the public key ' +
    'advertised in the ratchet tree'

for (const cs of sampleCiphersuites()) {
    test('a commit whose UpdatePath keys do not match the encrypted path ' +
        'secret is rejected - ' + cs, async (t) => {
        try {
            await rejectsMismatchedPathKeys(t, cs as CiphersuiteName)
        } catch (error:any) {
            if (skippable(error)) {
                t.comment(`Skipping ${cs}: ${error.message}`)
                return
            }
            throw error
        }
    })

    test('an honest commit and welcome are still accepted - ' + cs, async (t) => {
        try {
            await acceptsHonestCommit(t, cs as CiphersuiteName)
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
    return generateKeyPackage(credential, defaultCapabilities(), defaultLifetime(), [], impl)
}

async function makeGroup (cipherSuite:CiphersuiteName) {
    const impl = await getCipherSuite(getCiphersuiteFromName(cipherSuite))

    const alice = await makeMember('alice', impl)
    const bob = await makeMember('bob', impl)

    const groupId = new TextEncoder().encode('derived-key-match-group')

    const created = await createGroup(groupId, alice.publicPackage, alice.privatePackage, [], impl, testClientConfig)

    const addBob = await createCommit(
        { state: created, cipherSuite: impl },
        {
            extraProposals: [
                { proposalType: 'add', add: { keyPackage: bob.publicPackage } } satisfies ProposalAdd,
            ],
        },
    )

    if (addBob.welcome === undefined) throw new Error('Expected a welcome for bob')

    const aliceGroup = addBob.newState

    const bobGroup = await joinGroup(
        addBob.welcome,
        bob.publicPackage,
        bob.privatePackage,
        emptyPskIndex,
        impl,
        aliceGroup.ratchetTree,
        undefined,
        testClientConfig
    )

    return { impl, aliceGroup, bobGroup }
}

async function rejectsMismatchedPathKeys (t:any, cipherSuite:CiphersuiteName) {
    const { impl, aliceGroup, bobGroup } = await makeGroup(cipherSuite)

    const aliceLeafIndex = toLeafIndex(aliceGroup.privatePath.leafIndex)

    // two honest paths over the same tree, from two independent path secrets
    const [treeA, pathA] = await createUpdatePath(
        aliceGroup.ratchetTree,
        aliceLeafIndex,
        aliceGroup.groupContext,
        aliceGroup.signaturePrivateKey,
        impl,
    )

    const [, , secretsB] = await createUpdatePath(
        aliceGroup.ratchetTree,
        aliceLeafIndex,
        aliceGroup.groupContext,
        aliceGroup.signaturePrivateKey,
        impl,
    )

    t.ok(pathA.nodes.length > 0, 'the committer should have a non-empty filtered direct path')

    // the group context every receiver will reconstruct from path A
    const contextA:GroupContext = {
        ...aliceGroup.groupContext,
        treeHash: await treeHashRoot(treeA, impl.hash),
        epoch: aliceGroup.groupContext.epoch + 1n,
    }

    const spliced:UpdatePath = {
        leafNode: pathA.leafNode,
        nodes: await Promise.all(pathA.nodes.map(async (node, i) => ({
            hpkePublicKey: node.hpkePublicKey,
            encryptedPathSecret: await Promise.all(
                secretsB[i]!.sendTo.map(async (nodeIndex) => {
                    const { ct, enc } = await encryptWithLabel(
                        await impl.hpke.importPublicKey(
                            getHpkePublicKey(aliceGroup.ratchetTree[nodeIndex]!),
                        ),
                        'UpdatePathNode',
                        encodeGroupContext(contextA),
                        secretsB[i]!.secret,
                        impl.hpke,
                    )
                    return { ciphertext: ct, kemOutput: enc }
                }),
            ),
        }))),
    }

    const { framedContent, signature } = await createContentCommitSignature(
        aliceGroup.groupContext,
        'mls_public_message',
        { proposals: [], path: spliced },
        { senderType: 'member', leafIndex: aliceGroup.privatePath.leafIndex },
        new Uint8Array(),
        aliceGroup.signaturePrivateKey,
        impl.signature,
    )

    // the attacker runs its own key schedule off path B, the chain it
    // actually distributed, so the confirmation tag it sends is the one the
    // receiver computes. Nothing downstream of the tree update catches the
    // mismatch: without the derived-key check the epoch is simply accepted.
    const nextContext = await nextEpochContext(
        aliceGroup.groupContext,
        'mls_public_message',
        framedContent,
        signature,
        contextA.treeHash,
        aliceGroup.confirmationTag,
        impl.hash,
    )

    const epochSecrets = await initializeEpoch(
        aliceGroup.keySchedule.initSecret,
        await deriveSecret(secretsB.at(-1)!.secret, 'path', impl.kdf),
        nextContext,
        new Uint8Array(impl.kdf.size),
        impl.kdf,
    )

    const confirmationTag = await createConfirmationTag(
        epochSecrets.keySchedule.confirmationKey,
        nextContext.confirmedTranscriptHash,
        impl.hash,
    )

    const publicMessage = await protectPublicMessage(
        aliceGroup.keySchedule.membershipKey,
        aliceGroup.groupContext,
        {
            wireformat: 'mls_public_message',
            content: framedContent,
            auth: { contentType: 'commit', signature, confirmationTag },
        },
        impl,
    )

    let caught:unknown
    try {
        await processMessage(
            { wireformat: 'mls_public_message', publicMessage },
            bobGroup,
            makePskIndex(bobGroup, {}),
            () => 'accept',
            impl,
        )
    } catch (err) {
        caught = err
    }

    // asserting the specific message, not merely that something threw:
    // before this check existed the poisoned commit was accepted outright,
    // and a weaker assertion would also pass for an unrelated failure
    t.ok(
        caught instanceof ValidationError && caught.message === MISMATCH,
        'should reject an UpdatePath whose advertised key does not match ' +
        'the encrypted path secret',
    )
}

async function acceptsHonestCommit (t:any, cipherSuite:CiphersuiteName) {
    const { impl, aliceGroup, bobGroup } = await makeGroup(cipherSuite)

    const commit = await createCommit({ state: aliceGroup, cipherSuite: impl })

    if (commit.commit.wireformat !== 'mls_private_message') {
        throw new Error('expected a private message commit')
    }

    const result = await processMessage(
        commit.commit,
        bobGroup,
        makePskIndex(bobGroup, {}),
        () => 'accept',
        impl,
    )

    t.equal(result.kind, 'newState', 'bob should accept an honest commit')
    t.equal(
        result.newState.groupContext.epoch,
        aliceGroup.groupContext.epoch + 1n,
        'bob should advance to the next epoch',
    )
}
