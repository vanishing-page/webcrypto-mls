import { test } from '@substrate-system/tapzero'
import { createGroup } from '../../src/client-state.js'
import { createCommit } from '../../src/create-commit.js'
import type { Credential } from '../../src/credential.js'
import type { CiphersuiteName } from '../../src/crypto/ciphersuite.js'
import { getCiphersuiteFromName } from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import type { CiphersuiteImpl } from '../../src/crypto/ciphersuite.js'
import type { KeyPackage, PrivateKeyPackage } from '../../src/key-package.js'
import { generateKeyPackage, signKeyPackage } from '../../src/key-package.js'
import { signLeafNodeKeyPackage } from '../../src/leaf-node.js'
import type { ProposalAdd } from '../../src/proposal.js'
import { defaultLifetime } from '../../src/lifetime.js'
import { defaultCapabilities } from '../../src/default-capabilities.js'
import { ValidationError } from '../../src/mls-error.js'
import { sampleCiphersuites } from '../helpers/suite-filter.js'
import { testClientConfig } from '../helpers/client-config.js'

// RFC 9420 SS7.8 / SS12.1.1: an added leaf's encryption_key must be distinct
// from every public key already in the ratchet tree. This library's join-time
// check (validateRatchetTree's hasDuplicateUint8Arrays) enforces exactly that
// over *all* nodes, so a commit that adds a colliding key builds a tree the
// library itself later refuses -- every future join fails, permanently.
// Two things have to hold for the commit-time check to be as strict:
// the Adds in one commit must see each other, and a leaf key must be compared
// against parent-node keys too.
for (const cs of sampleCiphersuites()) {
    test('a commit with two Adds sharing an HPKE key is rejected - ' + cs,
        async (t) => {
            try {
                await rejectsDuplicateAddKeys(t, cs as CiphersuiteName)
            } catch (error:any) {
                if (isUnsupported(error)) {
                    t.comment(`Skipping ${cs}: ${error.message}`)
                    return
                }
                throw error
            }
        })

    test('an Add whose key equals a parent node key is rejected - ' + cs,
        async (t) => {
            try {
                await rejectsParentKeyCollision(t, cs as CiphersuiteName)
            } catch (error:any) {
                if (isUnsupported(error)) {
                    t.comment(`Skipping ${cs}: ${error.message}`)
                    return
                }
                throw error
            }
        })
}

function isUnsupported (error:any):boolean {
    return error?.name === 'NotSupportedError' ||
        error?.name === 'DependencyError'
}

async function makeMember (name:string, impl:CiphersuiteImpl) {
    const credential:Credential = {
        credentialType: 'basic',
        identity: new TextEncoder().encode(name),
    }

    return generateKeyPackage(
        credential,
        defaultCapabilities(),
        defaultLifetime(),
        [],
        impl,
    )
}

/**
 * Re-mint a KeyPackage carrying a chosen encryption key, signed by its own
 * owner. Tampering the bytes in place would fail the leaf node signature
 * check first, which would make the test pass for the wrong reason.
 */
async function keyPackageWithHpkeKey (
    base:KeyPackage,
    priv:PrivateKeyPackage,
    hpkePublicKey:Uint8Array,
    impl:CiphersuiteImpl,
):Promise<KeyPackage> {
    const leaf = base.leafNode
    const leafNode = await signLeafNodeKeyPackage(
        {
            leafNodeSource: 'key_package',
            hpkePublicKey,
            signaturePublicKey: leaf.signaturePublicKey,
            info: { leafNodeSource: 'key_package' },
            extensions: leaf.extensions,
            credential: leaf.credential,
            capabilities: leaf.capabilities,
            lifetime: leaf.lifetime,
        },
        priv.signaturePrivateKey,
        impl.signature,
    )

    return signKeyPackage(
        {
            version: base.version,
            cipherSuite: base.cipherSuite,
            initKey: base.initKey,
            leafNode,
            extensions: base.extensions,
        },
        priv.signaturePrivateKey,
        impl.signature,
    )
}

async function aliceAlone (impl:CiphersuiteImpl) {
    const alice = await makeMember('alice', impl)

    return createGroup(
        new TextEncoder().encode('group1'),
        alice.publicPackage,
        alice.privatePackage,
        [],
        impl,
        testClientConfig
    )
}

function addOf (keyPackage:KeyPackage):ProposalAdd {
    return { proposalType: 'add', add: { keyPackage } }
}

async function rejectsDuplicateAddKeys (t:any, cipherSuite:CiphersuiteName) {
    const impl = await getCipherSuite(getCiphersuiteFromName(cipherSuite))
    const aliceGroup = await aliceAlone(impl)

    const bob = await makeMember('bob', impl)
    const eve = await makeMember('eve', impl)

    // eve keeps her own signature key -- the KeyPackage-equality guard and
    // the signature-key half of the uniqueness check both stay quiet, so
    // only the encryption-key comparison can catch this
    const eveCopyingBob = await keyPackageWithHpkeKey(
        eve.publicPackage,
        eve.privatePackage,
        bob.publicPackage.leafNode.hpkePublicKey,
        impl,
    )

    let caught:unknown
    try {
        await createCommit(
            { state: aliceGroup, cipherSuite: impl },
            {
                extraProposals: [
                    addOf(bob.publicPackage),
                    addOf(eveCopyingBob),
                ],
            },
        )
    } catch (err) {
        caught = err
    }

    t.ok(
        caught instanceof ValidationError &&
            caught.message === 'hpke and signature keys not unique',
        'should reject two Adds in one commit sharing an encryption key',
    )
}

async function rejectsParentKeyCollision (t:any, cipherSuite:CiphersuiteName) {
    const impl = await getCipherSuite(getCiphersuiteFromName(cipherSuite))
    let aliceGroup = await aliceAlone(impl)

    const bob = await makeMember('bob', impl)
    const charlie = await makeMember('charlie', impl)
    const dave = await makeMember('dave', impl)

    // four leaves and an UpdatePath, so the tree has populated parent nodes
    const populate = await createCommit(
        { state: aliceGroup, cipherSuite: impl },
        {
            extraProposals: [
                addOf(bob.publicPackage),
                addOf(charlie.publicPackage),
                addOf(dave.publicPackage),
            ],
        },
    )

    // an add-only commit carries no UpdatePath, so a second, empty commit
    // is what actually fills in alice's direct path
    const path = await createCommit(
        { state: populate.newState, cipherSuite: impl },
        {},
    )

    aliceGroup = path.newState

    const parent = aliceGroup.ratchetTree.find((n) => n?.nodeType === 'parent')

    if (parent === undefined || parent.nodeType !== 'parent') {
        throw new Error('expected a populated parent node')
    }

    const eve = await makeMember('eve', impl)
    const eveCopyingParent = await keyPackageWithHpkeKey(
        eve.publicPackage,
        eve.privatePackage,
        parent.parent.hpkePublicKey,
        impl,
    )

    let caught:unknown
    try {
        await createCommit(
            { state: aliceGroup, cipherSuite: impl },
            { extraProposals: [addOf(eveCopyingParent)] },
        )
    } catch (err) {
        caught = err
    }

    t.ok(
        caught instanceof ValidationError &&
            caught.message === 'hpke key matches an existing parent node key',
        'should reject an Add whose encryption key equals a parent node key',
    )
}
