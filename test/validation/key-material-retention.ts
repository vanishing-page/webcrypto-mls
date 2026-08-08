import { test } from '@substrate-system/tapzero'
import { addHistoricalReceiverData, createGroup, joinGroup, makePskIndex } from '../../src/client-state.js'
import { createCommit } from '../../src/create-commit.js'
import { createApplicationMessage } from '../../src/create-message.js'
import { processPrivateMessage } from '../../src/process-messages.js'
import { emptyPskIndex } from '../../src/psk-index.js'
import type { Credential } from '../../src/credential.js'
import type { CiphersuiteImpl, CiphersuiteName } from '../../src/crypto/ciphersuite.js'
import {
    getCiphersuiteFromName
} from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import { generateKeyPackage } from '../../src/key-package.js'
import { decodeMlsMessage, encodeMlsMessage } from '../../src/message.js'
import type { ProposalAdd, ProposalRemove } from '../../src/proposal.js'
import { defaultLifetime } from '../../src/lifetime.js'
import { defaultCapabilities } from '../../src/default-capabilities.js'
import { consumeRatchet, createSecretTree, ratchetToGeneration, ratchetUntil, stripHandshakeRatchets } from '../../src/secret-tree.js'
import { createUpdatePath, firstCommonAncestor, zeroPathSecretsArray } from '../../src/update-path.js'
import { pathToPathSecrets, zeroPathSecrets } from '../../src/path-secrets.js'
import { toPrivateKeyPath } from '../../src/private-key-path.js'
import { leafToNodeIndex, toLeafIndex } from '../../src/treemath.js'
import { decryptWithLabel, encryptWithLabel } from '../../src/crypto/hpke.js'
import { getHpkePublicKey } from '../../src/ratchet-tree.js'
import { defaultClientConfig } from '../../src/client-config.js'
import { defaultKeyRetentionConfig } from '../../src/key-retention-config.js'
import { updateArray } from '../../src/util/array.js'
import { protectApplicationData, unprotectPrivateMessage } from '../../src/message-protection.js'
import { testCiphersuites } from '../helpers/suite-filter.js'

function skippable (error:any):boolean {
    return error?.name === 'NotSupportedError' || error?.name === 'DependencyError'
}

for (const cs of testCiphersuites()) {
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

    test('addHistoricalReceiverData does not corrupt the previous ClientState secretTree ' + cs, async (t) => {
        try {
            await addHistoricalReceiverDataDoesNotMutatePreviousState(t, cs as CiphersuiteName)
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

    test('retainKeysForEpochs 0 retains no historical epoch data ' + cs, async (t) => {
        try {
            await retainKeysForEpochsZeroRetainsNothing(t, cs as CiphersuiteName)
        } catch (error:any) {
            if (skippable(error)) {
                t.comment(`Skipping ${cs}: ${error.message}`)
                return
            }
            throw error
        }
    })

    test('retainKeysForEpochs 2 retains only the 2 most recent epochs ' + cs, async (t) => {
        try {
            await retainKeysForEpochsRetainsOnlyTheMostRecent(t, cs as CiphersuiteName)
        } catch (error:any) {
            if (skippable(error)) {
                t.comment(`Skipping ${cs}: ${error.message}`)
                return
            }
            throw error
        }
    })

    test('consumeRatchet zeroizes the superseded secret without corrupting the new tree ' + cs, async (t) => {
        try {
            await consumeRatchetZeroizesSupersededSecret(t, cs as CiphersuiteName)
        } catch (error:any) {
            if (skippable(error)) {
                t.comment(`Skipping ${cs}: ${error.message}`)
                return
            }
            throw error
        }
    })

    test('ratchetToGeneration zeroizes a consumed out-of-order generation secret ' + cs, async (t) => {
        try {
            await ratchetToGenerationZeroizesOutOfOrderSecret(t, cs as CiphersuiteName)
        } catch (error:any) {
            if (skippable(error)) {
                t.comment(`Skipping ${cs}: ${error.message}`)
                return
            }
            throw error
        }
    })

    test('evicted generation secrets are zeroized before being dropped ' + cs, async (t) => {
        try {
            await evictedGenerationSecretsAreZeroized(t, cs as CiphersuiteName)
        } catch (error:any) {
            if (skippable(error)) {
                t.comment(`Skipping ${cs}: ${error.message}`)
                return
            }
            throw error
        }
    })

    test('protectApplicationData zeroizes the derived key and nonce after use ' + cs, async (t) => {
        try {
            await protectZeroizesKeyAndNonce(t, cs as CiphersuiteName)
        } catch (error:any) {
            if (skippable(error)) {
                t.comment(`Skipping ${cs}: ${error.message}`)
                return
            }
            throw error
        }
    })

    test('unprotectPrivateMessage zeroizes the derived key and nonce after use ' + cs, async (t) => {
        try {
            await unprotectZeroizesKeyAndNonce(t, cs as CiphersuiteName)
        } catch (error:any) {
            if (skippable(error)) {
                t.comment(`Skipping ${cs}: ${error.message}`)
                return
            }
            throw error
        }
    })

    test('a commit that blanks a node drops and zeroizes the superseded private key ' + cs, async (t) => {
        try {
            await blankedNodePrivateKeyIsDroppedAndZeroized(t, cs as CiphersuiteName)
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

    const leafNodeIndex = leafToNodeIndex(toLeafIndex(0))
    const originalNode = tree[leafNodeIndex]!
    const originalHandshakeSecretBeforeStrip = originalNode.handshake.secret.slice()

    const stripped = stripHandshakeRatchets(tree)

    const strippedNode = stripped[leafNodeIndex]!

    t.ok(originalNode.handshake.secret.length > 0, 'sanity: original handshake secret is non-empty')
    t.equal(strippedNode.handshake.secret.length, 0, 'stripped handshake secret should be empty')
    t.deepEqual(strippedNode.application, originalNode.application, 'application ratchet should be preserved untouched')

    // stripHandshakeRatchets must not mutate its input -- the original tree
    // may still be referenced by a live ClientState (see doc comment)
    t.deepEqual(
        originalNode.handshake.secret,
        originalHandshakeSecretBeforeStrip,
        'original handshake secret bytes should be left untouched',
    )
}

async function addHistoricalReceiverDataDoesNotMutatePreviousState (t:any, cipherSuite:CiphersuiteName) {
    const impl = await getCipherSuite(getCiphersuiteFromName(cipherSuite))

    const aliceCredential:Credential = {
        credentialType: 'basic',
        identity: new TextEncoder().encode('alice'),
    }
    const alice = await generateKeyPackage(aliceCredential, defaultCapabilities(), defaultLifetime(), [], impl)

    const groupId = new TextEncoder().encode('add-historical-receiver-data-group')

    const aliceGroup = await createGroup(groupId, alice.publicPackage, alice.privatePackage, [], impl)

    const bobCredential:Credential = {
        credentialType: 'basic',
        identity: new TextEncoder().encode('bob'),
    }
    const bob = await generateKeyPackage(bobCredential, defaultCapabilities(), defaultLifetime(), [], impl)

    // snapshot alice's pre-commit secretTree handshake secrets so we can
    // prove they are unchanged after the commit builds historical receiver
    // data from this same (still-referenced) ClientState
    const leafNodeIndex = leafToNodeIndex(toLeafIndex(0))
    const preCommitNode = aliceGroup.secretTree[leafNodeIndex]!
    const preCommitHandshakeSecret = preCommitNode.handshake.secret.slice()
    t.ok(preCommitHandshakeSecret.length > 0, 'sanity: pre-commit handshake secret is non-empty')

    const addBobProposal:ProposalAdd = {
        proposalType: 'add',
        add: { keyPackage: bob.publicPackage },
    }

    await createCommit(
        { state: aliceGroup, cipherSuite: impl },
        { extraProposals: [addBobProposal] },
    )

    // createCommit encrypts the commit as a PrivateMessage by default,
    // consuming alice's own current handshake ratchet generation on the
    // (still-referenced) pre-commit ClientState -- per US-012, that
    // superseded secret is now zeroized in place rather than left for GC,
    // even though this same object remains reachable via `aliceGroup`.
    const postCommitNode = aliceGroup.secretTree[leafNodeIndex]!
    t.ok(
        postCommitNode.handshake.secret.every((b) => b === 0),
        'the committer\'s own consumed handshake ratchet secret should be zeroized after createCommit',
    )
    t.notDeepEqual(
        postCommitNode.handshake.secret,
        preCommitHandshakeSecret,
        'sanity: the zeroized secret differs from the original pre-commit secret',
    )

    // exercise addHistoricalReceiverData directly too, since createCommit is
    // only one of its two call sites -- verify it introduces no *further*
    // mutation beyond what createCommit already did above
    const postCommitHandshakeSecret = postCommitNode.handshake.secret.slice()
    addHistoricalReceiverData(aliceGroup)
    t.deepEqual(
        aliceGroup.secretTree[leafNodeIndex]!.handshake.secret,
        postCommitHandshakeSecret,
        'addHistoricalReceiverData should not mutate the state it is given',
    )
}

async function pathSecretsZeroizable (t:any, cipherSuite:CiphersuiteName) {
    const impl = await getCipherSuite(getCiphersuiteFromName(cipherSuite))

    const aliceCredential:Credential = {
        credentialType: 'basic',
        identity: new TextEncoder().encode('alice')
    }
    const alice = await generateKeyPackage(aliceCredential, defaultCapabilities(), defaultLifetime(), [], impl)

    const groupId = new TextEncoder().encode('key-material-retention-group')

    let aliceGroup = await createGroup(groupId, alice.publicPackage, alice.privatePackage, [], impl)

    const bobCredential:Credential = {
        credentialType: 'basic',
        identity: new TextEncoder().encode('bob')
    }
    const bob = await generateKeyPackage(bobCredential, defaultCapabilities(), defaultLifetime(), [], impl)

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
        return generateKeyPackage(credential, defaultCapabilities(), defaultLifetime(), [], impl)
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

async function makeGroupWithRetentionConfig (
    cipherSuite:CiphersuiteName,
    retainKeysForEpochs:number,
) {
    const impl = await getCipherSuite(getCiphersuiteFromName(cipherSuite))

    const aliceCredential:Credential = {
        credentialType: 'basic',
        identity: new TextEncoder().encode('alice'),
    }
    const alice = await generateKeyPackage(aliceCredential, defaultCapabilities(), defaultLifetime(), [], impl)

    const groupId = new TextEncoder().encode('retain-keys-for-epochs-group-' + retainKeysForEpochs)

    const clientConfig = {
        ...defaultClientConfig,
        keyRetentionConfig: { ...defaultKeyRetentionConfig, retainKeysForEpochs },
    }

    const aliceGroup = await createGroup(groupId, alice.publicPackage, alice.privatePackage, [], impl, clientConfig)

    return { impl, aliceGroup }
}

async function commitSelfUpdate (state:any, impl:any) {
    const commitResult = await createCommit({ state, cipherSuite: impl }, {})
    return commitResult.newState
}

async function retainKeysForEpochsZeroRetainsNothing (t:any, cipherSuite:CiphersuiteName) {
    const { impl, aliceGroup: initial } = await makeGroupWithRetentionConfig(cipherSuite, 0)
    let aliceGroup = initial

    for (let i = 0; i < 3; i++) {
        aliceGroup = await commitSelfUpdate(aliceGroup, impl)
    }

    t.equal(
        aliceGroup.historicalReceiverData.size,
        0,
        'retainKeysForEpochs 0 should leave historicalReceiverData empty after multiple commits',
    )
}

async function retainKeysForEpochsRetainsOnlyTheMostRecent (t:any, cipherSuite:CiphersuiteName) {
    const { impl, aliceGroup: initial } = await makeGroupWithRetentionConfig(cipherSuite, 2)
    let aliceGroup = initial

    for (let i = 0; i < 4; i++) {
        aliceGroup = await commitSelfUpdate(aliceGroup, impl)
    }

    t.equal(
        aliceGroup.historicalReceiverData.size,
        2,
        'retainKeysForEpochs 2 should retain exactly 2 epochs',
    )

    const retainedEpochs = [...aliceGroup.historicalReceiverData.keys()].sort((a, b) => (a < b ? -1 : 1))
    const currentEpoch = aliceGroup.groupContext.epoch

    // addHistoricalReceiverData records the epoch *before* the commit that
    // produces this state, so the most recent recorded epoch is
    // currentEpoch - 1
    t.deepEqual(
        retainedEpochs,
        [currentEpoch - 2n, currentEpoch - 1n],
        'retainKeysForEpochs 2 should retain only the 2 most recent epochs',
    )
}

async function consumeRatchetZeroizesSupersededSecret (t:any, cipherSuite:CiphersuiteName) {
    const impl = await getCipherSuite(getCiphersuiteFromName(cipherSuite))

    const encryptionSecret = impl.rng.randomBytes(impl.kdf.size)
    const tree = await createSecretTree(1, encryptionSecret, impl.kdf)

    const leafNodeIndex = leafToNodeIndex(toLeafIndex(0))
    const originalSecret = tree[leafNodeIndex]!.application.secret

    t.ok(originalSecret.some((b) => b !== 0), 'sanity: original application secret is non-zero')

    const result = await consumeRatchet(tree, leafNodeIndex, 'application', impl)

    t.ok(
        originalSecret.every((b) => b === 0),
        'the superseded secret should be zeroized in place after being consumed',
    )

    const newSecret = result.newTree[leafNodeIndex]!.application.secret
    t.ok(newSecret.some((b) => b !== 0), 'the new tree\'s ratcheted-forward secret should be untouched (non-zero)')
}

async function ratchetToGenerationZeroizesOutOfOrderSecret (t:any, cipherSuite:CiphersuiteName) {
    const impl = await getCipherSuite(getCiphersuiteFromName(cipherSuite))

    const encryptionSecret = impl.rng.randomBytes(impl.kdf.size)
    const tree = await createSecretTree(1, encryptionSecret, impl.kdf)

    const leafNodeIndex = leafToNodeIndex(toLeafIndex(0))
    const node = tree[leafNodeIndex]!

    // fast-forward the handshake ratchet to generation 2, retaining
    // generations 0 and 1 in unusedGenerations for out-of-order delivery
    const ratcheted = await ratchetUntil(node.handshake, 2, defaultKeyRetentionConfig, impl.kdf)
    const treeWithRatchetedNode = updateArray(tree, leafNodeIndex, { ...node, handshake: ratcheted })

    const desiredGenerationSecret = ratcheted.unusedGenerations[0]
    if (desiredGenerationSecret === undefined) throw new Error('Expected generation 0 to be retained')
    t.ok(desiredGenerationSecret.some((b) => b !== 0), 'sanity: retained out-of-order secret is non-zero')

    const result = await ratchetToGeneration(
        treeWithRatchetedNode,
        { leafIndex: 0, generation: 0, reuseGuard: impl.rng.randomBytes(4) as any },
        'commit',
        defaultKeyRetentionConfig,
        impl,
    )

    t.ok(
        desiredGenerationSecret.every((b) => b === 0),
        'the consumed out-of-order generation secret should be zeroized after use',
    )
    t.equal(
        result.newTree[leafNodeIndex]!.handshake.unusedGenerations[0],
        undefined,
        'the consumed out-of-order generation should be removed from unusedGenerations',
    )
}

async function evictedGenerationSecretsAreZeroized (t:any, cipherSuite:CiphersuiteName) {
    const impl = await getCipherSuite(getCiphersuiteFromName(cipherSuite))

    const encryptionSecret = impl.rng.randomBytes(impl.kdf.size)
    const tree = await createSecretTree(1, encryptionSecret, impl.kdf)

    const leafNodeIndex = leafToNodeIndex(toLeafIndex(0))
    const node = tree[leafNodeIndex]!

    const retainConfig = { ...defaultKeyRetentionConfig, retainKeysForGenerations: 2 }

    const ratchet1 = await ratchetUntil(node.handshake, 1, retainConfig, impl.kdf)
    const ratchet2 = await ratchetUntil(ratchet1, 2, retainConfig, impl.kdf)

    const evictedSecret = ratchet2.unusedGenerations[0]
    if (evictedSecret === undefined) throw new Error('Expected generation 0 to still be retained after step 2')
    t.ok(evictedSecret.some((b) => b !== 0), 'sanity: generation 0 secret is non-zero before eviction')

    const ratchet3 = await ratchetUntil(ratchet2, 3, retainConfig, impl.kdf)

    t.equal(ratchet3.unusedGenerations[0], undefined, 'generation 0 should be evicted once retention limit is exceeded')
    t.ok(
        evictedSecret.every((b) => b === 0),
        'the evicted generation secret should be zeroized before being dropped',
    )
}

async function protectZeroizesKeyAndNonce (t:any, cipherSuite:CiphersuiteName) {
    const impl = await getCipherSuite(getCiphersuiteFromName(cipherSuite))

    const aliceCredential:Credential = {
        credentialType: 'basic',
        identity: new TextEncoder().encode('alice'),
    }
    const alice = await generateKeyPackage(aliceCredential, defaultCapabilities(), defaultLifetime(), [], impl)

    const groupId = new TextEncoder().encode('protect-zeroization-group')
    const aliceGroup = await createGroup(groupId, alice.publicPackage, alice.privatePackage, [], impl)

    // protectApplicationData calls encryptAead twice: first with the
    // ratchet-derived content key/nonce (message-protection.ts, in scope
    // for this zeroization fix), then again with the sender-data key/nonce
    // (private-message.ts, a separate module not covered by this fix) --
    // capture the first call only.
    const calls:{ key:Uint8Array; nonce:Uint8Array }[] = []

    const wrappedImpl = {
        ...impl,
        hpke: {
            ...impl.hpke,
            encryptAead: async (key:Uint8Array, nonce:Uint8Array, aad:Uint8Array, pt:Uint8Array) => {
                calls.push({ key, nonce })
                return impl.hpke.encryptAead(key, nonce, aad, pt)
            },
        },
    }

    await protectApplicationData(
        aliceGroup.signaturePrivateKey,
        aliceGroup.keySchedule.senderDataSecret,
        new TextEncoder().encode('hello'),
        new Uint8Array(),
        aliceGroup.groupContext,
        aliceGroup.secretTree,
        aliceGroup.privatePath.leafIndex,
        aliceGroup.clientConfig.paddingConfig,
        wrappedImpl as CiphersuiteImpl,
    )

    const contentCall = calls[0]
    if (contentCall === undefined) throw new Error('Expected encryptAead to be called')

    t.ok(contentCall.key.every((b) => b === 0), 'the derived key should be zeroized after the AEAD call')
    t.ok(contentCall.nonce.every((b) => b === 0), 'the derived nonce should be zeroized after the AEAD call')
}

async function blankedNodePrivateKeyIsDroppedAndZeroized (t:any, cipherSuite:CiphersuiteName) {
    const impl = await getCipherSuite(getCiphersuiteFromName(cipherSuite))

    async function makeMember (name:string) {
        const credential:Credential = { credentialType: 'basic', identity: new TextEncoder().encode(name) }
        return generateKeyPackage(credential, defaultCapabilities(), defaultLifetime(), [], impl)
    }

    const alice = await makeMember('alice')
    const bob = await makeMember('bob')
    const charlie = await makeMember('charlie')
    const dave = await makeMember('dave')

    const groupId = new TextEncoder().encode('blanked-node-key-zeroization-group')

    let aliceGroup = await createGroup(groupId, alice.publicPackage, alice.privatePackage, [], impl)

    const addAllCommit = await createCommit(
        { state: aliceGroup, cipherSuite: impl },
        {
            extraProposals: [
                { proposalType: 'add', add: { keyPackage: bob.publicPackage } } as ProposalAdd,
                { proposalType: 'add', add: { keyPackage: charlie.publicPackage } } as ProposalAdd,
                { proposalType: 'add', add: { keyPackage: dave.publicPackage } } as ProposalAdd,
            ],
        },
    )
    aliceGroup = addAllCommit.newState

    let charlieGroup = await joinGroup(
        addAllCommit.welcome!,
        charlie.publicPackage,
        charlie.privatePackage,
        emptyPskIndex,
        impl,
        aliceGroup.ratchetTree,
    )

    // charlie self-updates: her own createUpdatePath freshly populates her
    // privatePath with a key for every node on her own direct path,
    // including the ancestor she shares with dave (her sibling) but not
    // with alice -- that ancestor is a copath node for alice's own commits,
    // so alice's later commits never refresh it.
    const charlieSelfUpdateCommit = await createCommit({ state: charlieGroup, cipherSuite: impl })
    charlieGroup = charlieSelfUpdateCommit.newState

    if (charlieSelfUpdateCommit.commit.wireformat !== 'mls_private_message') throw new Error('Expected private message')
    const aliceProcessSelfUpdate = await processPrivateMessage(
        aliceGroup,
        charlieSelfUpdateCommit.commit.privateMessage,
        makePskIndex(aliceGroup, {}),
        impl,
    )
    aliceGroup = aliceProcessSelfUpdate.newState

    // snapshot the private key buffers charlie holds before dave is removed
    const preRemovalKeys = { ...charlieGroup.privatePath.privateKeys }
    t.ok(Object.keys(preRemovalKeys).length > 0, 'sanity: charlie holds at least one node private key')

    // find dave's actual node index from alice's tree rather than assuming it
    const daveNodeIndex = aliceGroup.ratchetTree.findIndex(
        (n) => n !== undefined && n.nodeType === 'leaf' && n.leaf.signaturePublicKey.every(
            (b, i) => b === dave.publicPackage.leafNode.signaturePublicKey[i],
        ),
    )
    if (daveNodeIndex < 0) throw new Error('Could not find dave leaf index')

    const removeDaveProposal:ProposalRemove = {
        proposalType: 'remove',
        remove: { removed: toLeafIndex(daveNodeIndex / 2) },
    }

    const removeCommit = await createCommit(
        { state: aliceGroup, cipherSuite: impl },
        { extraProposals: [removeDaveProposal] },
    )
    aliceGroup = removeCommit.newState

    if (removeCommit.commit.wireformat !== 'mls_private_message') throw new Error('Expected private message')

    const charlieProcessRemove = await processPrivateMessage(
        charlieGroup,
        removeCommit.commit.privateMessage,
        makePskIndex(charlieGroup, {}),
        impl,
    )
    charlieGroup = charlieProcessRemove.newState

    let checked = 0
    for (const [key, oldValue] of Object.entries(preRemovalKeys)) {
        const nodeIndex = Number(key)
        if (charlieGroup.ratchetTree[nodeIndex] !== undefined) continue // still live, not blanked by this commit

        checked++
        t.equal(
            charlieGroup.privatePath.privateKeys[nodeIndex],
            undefined,
            `blanked node ${nodeIndex}'s private key entry should be dropped`,
        )
        t.ok(
            oldValue.every((b) => b === 0),
            `blanked node ${nodeIndex}'s superseded private key buffer should be zeroized`,
        )
    }

    t.ok(checked > 0, 'sanity: at least one of charlie\'s private keys was for a node this commit blanked')
}

async function unprotectZeroizesKeyAndNonce (t:any, cipherSuite:CiphersuiteName) {
    const impl = await getCipherSuite(getCiphersuiteFromName(cipherSuite))

    const aliceCredential:Credential = {
        credentialType: 'basic',
        identity: new TextEncoder().encode('alice'),
    }
    const alice = await generateKeyPackage(aliceCredential, defaultCapabilities(), defaultLifetime(), [], impl)

    const groupId = new TextEncoder().encode('unprotect-zeroization-group')
    const aliceGroup = await createGroup(groupId, alice.publicPackage, alice.privatePackage, [], impl)

    // snapshot an independent copy of the pre-send tree to decrypt with,
    // simulating a separate recipient's own unconsumed copy -- alice's own
    // secretTree gets its generation-0 secret zeroized in place by
    // protectApplicationData below (US-012), so it cannot be reused here
    const recipientSecretTree = structuredClone(aliceGroup.secretTree)

    const protectResult = await protectApplicationData(
        aliceGroup.signaturePrivateKey,
        aliceGroup.keySchedule.senderDataSecret,
        new TextEncoder().encode('hello'),
        new Uint8Array(),
        aliceGroup.groupContext,
        aliceGroup.secretTree,
        aliceGroup.privatePath.leafIndex,
        aliceGroup.clientConfig.paddingConfig,
        impl,
    )

    // unprotectPrivateMessage calls decryptAead twice: first to open the
    // sender data (private-message.ts, out of scope), then again with the
    // ratchet-derived content key/nonce (message-protection.ts, in scope
    // for this zeroization fix) -- capture the last call only.
    const calls:{ key:Uint8Array; nonce:Uint8Array }[] = []

    const wrappedImpl = {
        ...impl,
        hpke: {
            ...impl.hpke,
            decryptAead: async (key:Uint8Array, nonce:Uint8Array, aad:Uint8Array, ct:Uint8Array) => {
                calls.push({ key, nonce })
                return impl.hpke.decryptAead(key, nonce, aad, ct)
            },
        },
    }

    await unprotectPrivateMessage(
        aliceGroup.keySchedule.senderDataSecret,
        protectResult.privateMessage,
        recipientSecretTree,
        aliceGroup.ratchetTree,
        aliceGroup.groupContext,
        aliceGroup.clientConfig.keyRetentionConfig,
        wrappedImpl as CiphersuiteImpl,
    )

    const contentCall = calls.at(-1)
    if (contentCall === undefined) throw new Error('Expected decryptAead to be called')

    t.ok(contentCall.key.every((b) => b === 0), 'the derived key should be zeroized after the AEAD call')
    t.ok(contentCall.nonce.every((b) => b === 0), 'the derived nonce should be zeroized after the AEAD call')
}
