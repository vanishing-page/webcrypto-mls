import { test } from '@substrate-system/tapzero'
import { createGroup, joinGroup, makePskIndex } from '../../src/client-state.js'
import { createCommit } from '../../src/create-commit.js'
import { createApplicationMessage } from '../../src/create-message.js'
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
import { decodeMlsMessage, encodeMlsMessage } from '../../src/message.js'
import type { ProposalAdd, ProposalRemove } from '../../src/proposal.js'
import { defaultLifetime } from '../../src/lifetime.js'
import { defaultCapabilities } from '../../src/default-capabilities.js'
import { createSecretTree, stripHandshakeRatchets } from '../../src/secret-tree.js'
import { createUpdatePath, firstCommonAncestor, zeroPathSecretsArray } from '../../src/update-path.js'
import { pathToPathSecrets, zeroPathSecrets } from '../../src/path-secrets.js'
import { toPrivateKeyPath } from '../../src/private-key-path.js'
import { leafToNodeIndex, toLeafIndex } from '../../src/treemath.js'
import { decryptWithLabel, encryptWithLabel } from '../../src/crypto/hpke.js'
import { getHpkePublicKey } from '../../src/ratchet-tree.js'

function skippable (error:any):boolean {
    return error?.name === 'NotSupportedError' || error?.name === 'DependencyError'
}

for (const cs of Object.keys(ciphersuites)) {
    test('createSecretTree does not retain ratchets for internal nodes ' + cs, async (t) => {
        try {
            await internalNodesNotRetained(t, cs as CiphersuiteName)
        } catch (error:any) {
            if (skippable(error)) {
                t.comment(`Skipping ${cs}: ${error.message}`)
                return
            }
            throw error
        }
    })

    test('historical receiver data strips handshake ratchets but keeps application usable ' + cs, async (t) => {
        try {
            await historicalDataStripsHandshake(t, cs as CiphersuiteName)
        } catch (error:any) {
            if (skippable(error)) {
                t.comment(`Skipping ${cs}: ${error.message}`)
                return
            }
            throw error
        }
    })

    test('path secrets can be zeroized without corrupting derived private keys ' + cs, async (t) => {
        try {
            await pathSecretsZeroizable(t, cs as CiphersuiteName)
        } catch (error:any) {
            if (skippable(error)) {
                t.comment(`Skipping ${cs}: ${error.message}`)
                return
            }
            throw error
        }
    })

    test('Welcome carries the real (non-zeroized) path secret to a new member ' + cs, async (t) => {
        try {
            await welcomeCarriesRealPathSecret(t, cs as CiphersuiteName)
        } catch (error:any) {
            if (skippable(error)) {
                t.comment(`Skipping ${cs}: ${error.message}`)
                return
            }
            throw error
        }
    })
}

async function internalNodesNotRetained (t:any, cipherSuite:CiphersuiteName) {
    const impl = await getCipherSuite(getCiphersuiteFromName(cipherSuite))

    const encryptionSecret = impl.rng.randomBytes(impl.kdf.size)
    const tree = await createSecretTree(4, encryptionSecret, impl.kdf)

    for (let nodeIndex = 0; nodeIndex < tree.length; nodeIndex++) {
        const isLeafIndex = nodeIndex % 2 === 0
        if (isLeafIndex) {
            t.ok(tree[nodeIndex] !== undefined, `leaf node ${nodeIndex} should have a ratchet root`)
        } else {
            t.equal(tree[nodeIndex], undefined, `internal node ${nodeIndex} should not retain a ratchet root`)
        }
    }
}

async function historicalDataStripsHandshake (t:any, cipherSuite:CiphersuiteName) {
    const impl = await getCipherSuite(getCiphersuiteFromName(cipherSuite))

    const encryptionSecret = impl.rng.randomBytes(impl.kdf.size)
    const tree = await createSecretTree(1, encryptionSecret, impl.kdf)

    const stripped = stripHandshakeRatchets(tree)

    const leafNodeIndex = leafToNodeIndex(toLeafIndex(0))
    const originalNode = tree[leafNodeIndex]!
    const strippedNode = stripped[leafNodeIndex]!

    t.ok(originalNode.handshake.secret.length > 0, 'sanity: original handshake secret is non-empty')
    t.equal(strippedNode.handshake.secret.length, 0, 'stripped handshake secret should be empty')
    t.deepEqual(strippedNode.application, originalNode.application, 'application ratchet should be preserved untouched')

    // original handshake secret bytes should have been zeroized in place
    t.ok(originalNode.handshake.secret.every((b) => b === 0), 'original handshake secret bytes should be zeroized')
}

async function pathSecretsZeroizable (t:any, cipherSuite:CiphersuiteName) {
    const impl = await getCipherSuite(getCiphersuiteFromName(cipherSuite))

    const aliceCredential:Credential = {
        credentialType: 'basic',
        identity: new TextEncoder().encode('alice')
    }
    const alice = await generateKeyPackage(aliceCredential, defaultCapabilities(), defaultLifetime, [], impl)

    const groupId = new TextEncoder().encode('key-material-retention-group')

    let aliceGroup = await createGroup(groupId, alice.publicPackage, alice.privatePackage, [], impl)

    const bobCredential:Credential = {
        credentialType: 'basic',
        identity: new TextEncoder().encode('bob')
    }
    const bob = await generateKeyPackage(bobCredential, defaultCapabilities(), defaultLifetime, [], impl)

    const addBobProposal:ProposalAdd = {
        proposalType: 'add',
        add: { keyPackage: bob.publicPackage },
    }

    const commitResult = await createCommit(
        { state: aliceGroup, cipherSuite: impl },
        { extraProposals: [addBobProposal] },
    )

    aliceGroup = commitResult.newState

    const decodedWelcome = decodeMlsMessage(
        encodeMlsMessage({ welcome: commitResult.welcome!, wireformat: 'mls_welcome', version: 'mls10' }),
        0,
    )![0]

    if (decodedWelcome.wireformat !== 'mls_welcome') throw new Error('Expected welcome')

    const bobGroup = await joinGroup(
        decodedWelcome.welcome,
        bob.publicPackage,
        bob.privatePackage,
        emptyPskIndex,
        impl,
        aliceGroup.ratchetTree,
    )

    // bob commits an update, producing an UpdatePath with real PathSecrets
    const updateCommitResult = await createCommit({ state: bobGroup, cipherSuite: impl }, {})
    const newBobGroup = updateCommitResult.newState

    // derive an independent set of path secrets the same way createCommit
    // does internally, so we can verify toPrivateKeyPath does not mutate
    // its input (the caller still needs the raw secrets to derive the
    // commit secret) before it is explicitly zeroized
    const [, , pathSecrets] = await createUpdatePath(
        bobGroup.ratchetTree,
        toLeafIndex(bobGroup.privatePath.leafIndex),
        bobGroup.groupContext,
        bobGroup.signaturePrivateKey,
        impl,
    )

    const asRecord = pathToPathSecrets(pathSecrets)
    const secretsBeforeCopy = Object.values(asRecord).map((s) => s.slice())

    await toPrivateKeyPath(asRecord, bobGroup.privatePath.leafIndex, impl)

    const secretsAfterCall = Object.values(asRecord)
    for (const [i, secret] of secretsAfterCall.entries()) {
        t.deepEqual(secret, secretsBeforeCopy[i], 'toPrivateKeyPath should not mutate its input before caller is done with it')
    }

    zeroPathSecretsArray(pathSecrets)
    for (const p of pathSecrets) {
        t.ok(p.secret.every((b) => b === 0), 'zeroPathSecretsArray should zero every path secret')
    }

    zeroPathSecrets(asRecord)
    for (const secret of Object.values(asRecord)) {
        t.ok(secret.every((b) => b === 0), 'zeroPathSecrets should zero every path secret in a record')
    }

    // sanity: the actual commit flow (which now zeroizes internally) still
    // produces a working group -- alice can process bob's commit, and bob
    // and alice still share message keys afterward
    if (updateCommitResult.commit.wireformat !== 'mls_private_message') throw new Error('Expected private message')

    const aliceProcessCommitResult = await processPrivateMessage(
        aliceGroup,
        updateCommitResult.commit.privateMessage,
        makePskIndex(aliceGroup, {}),
        impl,
    )

    if (aliceProcessCommitResult.kind !== 'newState') throw new Error('Expected new state from commit')

    aliceGroup = aliceProcessCommitResult.newState

    const messageToAlice = new TextEncoder().encode('still works after zeroizing path secrets')
    const bobMessageResult = await createApplicationMessage(newBobGroup, messageToAlice, impl)

    const aliceProcessResult = await processPrivateMessage(
        aliceGroup,
        bobMessageResult.privateMessage,
        makePskIndex(aliceGroup, {}),
        impl,
    )

    if (aliceProcessResult.kind === 'newState') throw new Error('Expected application message')

    t.deepEqual(aliceProcessResult.message, messageToAlice, 'alice should still receive correct message after bob commits')
}

async function welcomeCarriesRealPathSecret (t:any, cipherSuite:CiphersuiteName) {
    const impl = await getCipherSuite(getCiphersuiteFromName(cipherSuite))

    const makeMember = async (name:string) => {
        const credential:Credential = { credentialType: 'basic', identity: new TextEncoder().encode(name) }
        return generateKeyPackage(credential, defaultCapabilities(), defaultLifetime, [], impl)
    }

    const alice = await makeMember('alice')
    const bob = await makeMember('bob')
    const charlie = await makeMember('charlie')

    const groupId = new TextEncoder().encode('welcome-path-secret-group')

    let aliceGroup = await createGroup(groupId, alice.publicPackage, alice.privatePackage, [], impl)

    // add bob only, no UpdatePath needed
    const addBobResult = await createCommit(
        { state: aliceGroup, cipherSuite: impl },
        { extraProposals: [{ proposalType: 'add', add: { keyPackage: bob.publicPackage } } satisfies ProposalAdd] },
    )
    aliceGroup = addBobResult.newState

    // add charlie AND remove bob in the SAME commit -- remove forces an
    // UpdatePath (US-001), so this commit's Welcome to charlie carries a
    // pathSecret for the node shared with alice (the committer). Before the
    // fix, createCommit zeroized `pathSecrets` in place before createWelcome
    // read from that same array, so the new member received an all-zero
    // secret instead of the real one.
    const addCharlieRemoveBobResult = await createCommit(
        { state: aliceGroup, cipherSuite: impl },
        {
            extraProposals: [
                { proposalType: 'add', add: { keyPackage: charlie.publicPackage } } satisfies ProposalAdd,
                { proposalType: 'remove', remove: { removed: 1 } } satisfies ProposalRemove,
            ],
        },
    )
    aliceGroup = addCharlieRemoveBobResult.newState

    if (addCharlieRemoveBobResult.welcome === undefined) throw new Error('Expected a welcome for charlie')

    const charlieGroup = await joinGroup(
        addCharlieRemoveBobResult.welcome,
        charlie.publicPackage,
        charlie.privatePackage,
        emptyPskIndex,
        impl,
        aliceGroup.ratchetTree,
    )

    const ancestorNodeIndex = firstCommonAncestor(
        aliceGroup.ratchetTree,
        toLeafIndex(charlieGroup.privatePath.leafIndex),
        toLeafIndex(aliceGroup.privatePath.leafIndex),
    )

    const derivedPrivateKeyBytes = charlieGroup.privatePath.privateKeys[ancestorNodeIndex]
    t.ok(
        derivedPrivateKeyBytes !== undefined,
        'charlie should have derived a private key for the ancestor shared with alice',
    )

    const ancestorNode = aliceGroup.ratchetTree[ancestorNodeIndex]
    if (ancestorNode === undefined) throw new Error('Expected non-blank ancestor node')
    const ancestorPublicKeyBytes = getHpkePublicKey(ancestorNode)

    // round-trip an HPKE-sealed probe through the tree's real ancestor
    // public key and charlie's derived private key: if the Welcome had
    // carried a zeroized pathSecret, charlie's derived private key would not
    // correspond to this public key and decryption would fail.
    const probePlaintext = new TextEncoder().encode('welcome path secret probe')
    const sealed = await encryptWithLabel(
        await impl.hpke.importPublicKey(ancestorPublicKeyBytes),
        'probe',
        new Uint8Array(),
        probePlaintext,
        impl.hpke,
    )

    const opened = await decryptWithLabel(
        await impl.hpke.importPrivateKey(derivedPrivateKeyBytes!),
        'probe',
        new Uint8Array(),
        sealed.enc,
        sealed.ct,
        impl.hpke,
    )

    t.deepEqual(
        opened,
        probePlaintext,
        'charlie\'s derived ancestor private key (from the Welcome pathSecret) should match the tree\'s real public key',
    )
}
