import { test } from '@substrate-system/tapzero'
import { validateRatchetTree } from '../../src/client-state.js'
import { generateKeyPackage } from '../../src/key-package.js'
import type { Credential } from '../../src/credential.js'
import type { Capabilities } from '../../src/capabilities.js'
import type { CiphersuiteName } from '../../src/crypto/ciphersuite.js'
import {
    getCiphersuiteFromName,
    ciphersuites
} from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import { defaultLifetime } from '../../src/lifetime.js'
import { ValidationError } from '../../src/mls-error.js'
import type { RatchetTree } from '../../src/ratchet-tree.js'
import type { GroupContext } from '../../src/group-context.js'
import { defaultLifetimeConfig } from '../../src/lifetime-config.js'
import { defaultAuthenticationService } from '../../src/authentication-service.js'

// Convert test.concurrent.each to individual tests
for (const cs of Object.keys(ciphersuites)) {
    test(`should reject structurally unsound ratchet tree - ${cs}`, async (t) => {
        try {
            const cipherSuite = cs as CiphersuiteName
            const impl = await getCipherSuite(getCiphersuiteFromName(cipherSuite))
            const aliceCredential:Credential = {
                credentialType: 'basic',
                identity: new TextEncoder().encode('alice')
            }
            const aliceCapabilities:Capabilities = {
                extensions: [],
                credentials: ['basic'],
                proposals: [],
                versions: ['mls10'],
                ciphersuites: [cipherSuite],
            }
            const alice = await generateKeyPackage(aliceCredential, aliceCapabilities, defaultLifetime, [], impl)

            const validLeafNode = alice.publicPackage.leafNode
            // Make the first node a parent node, which is invalid for a leaf position
            const invalidTree:RatchetTree = [
                {
                    nodeType: 'parent',
                    parent: {
                        unmergedLeaves: [],
                        parentHash: new Uint8Array(),
                        hpkePublicKey: new Uint8Array(),
                    },
                },
                { nodeType: 'leaf', leaf: validLeafNode },
                { nodeType: 'leaf', leaf: validLeafNode },
            ]

            const groupContext:GroupContext = {
                version: 'mls10',
                cipherSuite,
                epoch: 0n,
                treeHash: new Uint8Array(),
                groupId: new Uint8Array(),
                extensions: [],
                confirmedTranscriptHash: new Uint8Array(),
            }

            const error = await validateRatchetTree(
                invalidTree,
                groupContext,
                defaultLifetimeConfig,
                defaultAuthenticationService,
                new Uint8Array(),
                impl,
            )

            t.ok(error instanceof ValidationError, 'should return a ValidationError')
            t.equal(error?.message, 'Received Ratchet Tree is not structurally sound', 'should have correct error message')
        } catch (error:any) {
            // Skip ciphersuites not supported in the current environment (e.g., X448/Ed448 in browsers)
            if (error?.name === 'NotSupportedError' || error?.name === 'DependencyError' || error?.name === 'CryptoError' || error?.name === 'DeriveKeyPairError' || error?.message?.includes('SubtleCrypto') || error?.message?.includes('Unrecognized name')) {
                t.comment(`Skipping ${cs}: ${error.message}`)
                return
            }
            throw error
        }
    })
}
