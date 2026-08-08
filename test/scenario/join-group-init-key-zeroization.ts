import { test } from '@substrate-system/tapzero'
import { createGroup, joinGroup } from '../../src/client-state.js'
import { createCommit } from '../../src/create-commit.js'
import { emptyPskIndex } from '../../src/psk-index.js'
import type { Credential } from '../../src/credential.js'
import type { CiphersuiteName } from '../../src/crypto/ciphersuite.js'
import {
    getCiphersuiteFromName
} from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import { generateKeyPackage } from '../../src/key-package.js'
import type { ProposalAdd } from '../../src/proposal.js'
import { defaultLifetime } from '../../src/lifetime.js'
import { defaultCapabilities } from '../../src/default-capabilities.js'
import { testCiphersuites } from '../helpers/suite-filter.js'

for (const cs of testCiphersuites()) {
    test(`joinGroup zeroizes init private key ${cs}`, async (t) => {
        try {
            await joinGroupZeroizesInitKey(cs as CiphersuiteName, t)
        } catch (error:any) {
            // Skip ciphersuites not supported in the current environment (e.g., X448/Ed448 in browsers)
            if (error?.name === 'NotSupportedError' || error?.name === 'DependencyError') {
                t.comment(`Skipping ${cs}: ${error.message}`)
                return
            }
            throw error
        }
    })
}

async function joinGroupZeroizesInitKey (cipherSuite:CiphersuiteName, t:any) {
    const impl = await getCipherSuite(getCiphersuiteFromName(cipherSuite))

    const aliceCredential:Credential = {
        credentialType: 'basic',
        identity: new TextEncoder().encode('alice')
    }
    const alice = await generateKeyPackage(
        aliceCredential,
        defaultCapabilities(),
        defaultLifetime(),
        [],
        impl
    )

    const groupId = new TextEncoder().encode('group1')

    let aliceGroup = await createGroup(
        groupId,
        alice.publicPackage,
        alice.privatePackage,
        [],
        impl
    )

    const bobCredential:Credential = {
        credentialType: 'basic',
        identity: new TextEncoder().encode('bob')
    }
    const bob = await generateKeyPackage(
        bobCredential,
        defaultCapabilities(),
        defaultLifetime(),
        [],
        impl
    )

    const addBobProposal:ProposalAdd = {
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
        {
            extraProposals: [addBobProposal],
        },
    )

    aliceGroup = commitResult.newState

    const bobInitPrivateKeyBefore = bob.privatePackage.initPrivateKey.slice()

    await joinGroup(
        commitResult.welcome!,
        bob.publicPackage,
        bob.privatePackage,
        emptyPskIndex,
        impl,
        aliceGroup.ratchetTree,
    )

    t.ok(
        bobInitPrivateKeyBefore.some((byte) => byte !== 0),
        'sanity check: init private key was non-zero before joinGroup',
    )
    t.ok(
        bob.privatePackage.initPrivateKey.every((byte) => byte === 0),
        'init private key is zeroized after a successful joinGroup',
    )

    // Charlie never joined the group, so his initPrivateKey does not match
    // any recipient in the welcome -- decryptGroupSecrets fails and
    // joinGroup should throw before zeroizing anything.
    const charlieCredential:Credential = {
        credentialType: 'basic',
        identity: new TextEncoder().encode('charlie'),
    }
    const charlie = await generateKeyPackage(
        charlieCredential,
        defaultCapabilities(),
        defaultLifetime(),
        [],
        impl,
    )

    const charlieInitPrivateKeyBefore = charlie.privatePackage.initPrivateKey.slice()

    let threw = false
    try {
        await joinGroup(
            commitResult.welcome!,
            charlie.publicPackage,
            charlie.privatePackage,
            emptyPskIndex,
            impl,
            aliceGroup.ratchetTree,
        )
    } catch {
        threw = true
    }

    t.ok(threw, 'joinGroup with a non-matching key package throws')
    t.deepEqual(
        Array.from(charlie.privatePackage.initPrivateKey),
        Array.from(charlieInitPrivateKeyBefore),
        'init private key is untouched after a failed joinGroup',
    )
}
