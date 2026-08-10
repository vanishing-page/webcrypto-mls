import { test } from '@substrate-system/tapzero'
import { validateUnmergedLeaves } from '../../src/client-state.js'
import { generateKeyPackage } from '../../src/key-package.js'
import type { Credential } from '../../src/credential.js'
import type { Capabilities } from '../../src/capabilities.js'
import type { CiphersuiteName } from '../../src/crypto/ciphersuite.js'
import {
    getCiphersuiteFromName
} from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import { defaultLifetime } from '../../src/lifetime.js'
import { ValidationError } from '../../src/mls-error.js'
import type { RatchetTree } from '../../src/ratchet-tree.js'
import { testCiphersuites } from '../helpers/suite-filter.js'

function shouldSkip (error:any):boolean {
    return (
        error?.name === 'NotSupportedError' ||
        error?.name === 'DependencyError' ||
        error?.name === 'CryptoError' ||
        error?.name === 'DeriveKeyPairError' ||
        error?.message?.includes('SubtleCrypto') ||
        error?.message?.includes('Unrecognized name')
    )
}

for (const cs of testCiphersuites()) {
    test(`should accept unmerged_leaves lists that differ across ancestors but each contain the leaf - ${cs}`, async (t) => {
        try {
            const cipherSuite = cs as CiphersuiteName
            const impl = await getCipherSuite(getCiphersuiteFromName(cipherSuite))
            const credential:Credential = {
                credentialType: 'basic',
                identity: new TextEncoder().encode('alice'),
            }
            const capabilities:Capabilities = {
                extensions: [],
                credentials: ['basic'],
                proposals: [],
                versions: ['mls10'],
                ciphersuites: [cipherSuite],
            }
            const kp = await generateKeyPackage(credential, capabilities, defaultLifetime(), [], impl)
            const leafNode = kp.publicPackage.leafNode

            // 4-leaf tree. Leaf index 1 (node 2) is unmerged under both its
            // immediate parent (node 1, unmergedLeaves: [1]) and the root
            // (node 3, unmergedLeaves: [1, 3]) -- present in both, but the
            // arrays themselves are not equal. Leaf index 3 (node 6) is
            // similarly unmerged under node 5 and the root.
            const tree:RatchetTree = [
                { nodeType: 'leaf', leaf: leafNode },
                {
                    nodeType: 'parent',
                    parent: { hpkePublicKey: new Uint8Array(), parentHash: new Uint8Array(), unmergedLeaves: [1] },
                },
                { nodeType: 'leaf', leaf: leafNode },
                {
                    nodeType: 'parent',
                    parent: { hpkePublicKey: new Uint8Array(), parentHash: new Uint8Array(), unmergedLeaves: [1, 3] },
                },
                { nodeType: 'leaf', leaf: leafNode },
                {
                    nodeType: 'parent',
                    parent: { hpkePublicKey: new Uint8Array(), parentHash: new Uint8Array(), unmergedLeaves: [3] },
                },
                { nodeType: 'leaf', leaf: leafNode },
            ]

            const error = validateUnmergedLeaves(tree)

            t.equal(error, undefined, 'should not reject a tree where the leaf merely needs to be present (not array-equal) in every node between it and the parent under inspection')
        } catch (error:any) {
            if (shouldSkip(error)) {
                t.comment(`Skipping ${cs}: ${error.message}`)
                return
            }
            throw error
        }
    })

    test(`should accept a tree where an ancestor above the parent under inspection omits the leaf - ${cs}`, async (t) => {
        try {
            const cipherSuite = cs as CiphersuiteName
            const impl = await getCipherSuite(getCiphersuiteFromName(cipherSuite))
            const credential:Credential = {
                credentialType: 'basic',
                identity: new TextEncoder().encode('alice'),
            }
            const capabilities:Capabilities = {
                extensions: [],
                credentials: ['basic'],
                proposals: [],
                versions: ['mls10'],
                ciphersuites: [cipherSuite],
            }
            const kp = await generateKeyPackage(credential, capabilities, defaultLifetime(), [], impl)
            const leafNode = kp.publicPackage.leafNode

            // 4-leaf tree. Leaf index 1 (node 2) is unmerged under its
            // immediate parent (node 1) only. The root (node 3) is non-blank
            // and does NOT list the leaf, which is what an ordinary Add
            // followed by the committer clearing its filtered direct path
            // produces. RFC 9420 7.9 only constrains nodes strictly between
            // the leaf and the parent under inspection, so this is valid.
            const tree:RatchetTree = [
                { nodeType: 'leaf', leaf: leafNode },
                {
                    nodeType: 'parent',
                    parent: { hpkePublicKey: new Uint8Array(), parentHash: new Uint8Array(), unmergedLeaves: [1] },
                },
                { nodeType: 'leaf', leaf: leafNode },
                {
                    nodeType: 'parent',
                    parent: { hpkePublicKey: new Uint8Array(), parentHash: new Uint8Array(), unmergedLeaves: [] },
                },
                { nodeType: 'leaf', leaf: leafNode },
                undefined,
                { nodeType: 'leaf', leaf: leafNode },
            ]

            const error = validateUnmergedLeaves(tree)

            t.equal(error, undefined, 'should not require ancestors above the inspected parent to list the leaf')
        } catch (error:any) {
            if (shouldSkip(error)) {
                t.comment(`Skipping ${cs}: ${error.message}`)
                return
            }
            throw error
        }
    })

    test(`should reject a non-blank node between the leaf and the parent that omits the leaf - ${cs}`, async (t) => {
        try {
            const cipherSuite = cs as CiphersuiteName
            const impl = await getCipherSuite(getCiphersuiteFromName(cipherSuite))
            const credential:Credential = {
                credentialType: 'basic',
                identity: new TextEncoder().encode('alice'),
            }
            const capabilities:Capabilities = {
                extensions: [],
                credentials: ['basic'],
                proposals: [],
                versions: ['mls10'],
                ciphersuites: [cipherSuite],
            }
            const kp = await generateKeyPackage(credential, capabilities, defaultLifetime(), [], impl)
            const leafNode = kp.publicPackage.leafNode

            // 4-leaf tree. The root (node 3) lists leaf index 1 as unmerged,
            // but node 1 -- non-blank and strictly between leaf 1 and the
            // root -- does not. That is the case 7.9 actually forbids.
            const tree:RatchetTree = [
                { nodeType: 'leaf', leaf: leafNode },
                {
                    nodeType: 'parent',
                    parent: { hpkePublicKey: new Uint8Array(), parentHash: new Uint8Array(), unmergedLeaves: [] },
                },
                { nodeType: 'leaf', leaf: leafNode },
                {
                    nodeType: 'parent',
                    parent: { hpkePublicKey: new Uint8Array(), parentHash: new Uint8Array(), unmergedLeaves: [1] },
                },
                { nodeType: 'leaf', leaf: leafNode },
                undefined,
                { nodeType: 'leaf', leaf: leafNode },
            ]

            const error = validateUnmergedLeaves(tree)

            t.ok(error instanceof ValidationError, 'should return a ValidationError')
            t.equal(
                error?.message,
                'non-blank intermediate node must list leaf node in its unmerged_leaves',
                'should have correct error message',
            )
        } catch (error:any) {
            if (shouldSkip(error)) {
                t.comment(`Skipping ${cs}: ${error.message}`)
                return
            }
            throw error
        }
    })

    test(`should reject unmerged_leaves entries pointing at a blank leaf - ${cs}`, async (t) => {
        try {
            const cipherSuite = cs as CiphersuiteName
            const impl = await getCipherSuite(getCiphersuiteFromName(cipherSuite))
            const credential:Credential = {
                credentialType: 'basic',
                identity: new TextEncoder().encode('alice'),
            }
            const capabilities:Capabilities = {
                extensions: [],
                credentials: ['basic'],
                proposals: [],
                versions: ['mls10'],
                ciphersuites: [cipherSuite],
            }
            const kp = await generateKeyPackage(credential, capabilities, defaultLifetime(), [], impl)
            const leafNode = kp.publicPackage.leafNode

            // 2-leaf tree. The root (node 1) claims leaf index 1 (node 2) is
            // unmerged, but node 2 is blank. The leaf is both not a
            // non-blank leaf AND (trivially) still a descendant of the root,
            // so only one of the two required conditions fails -- this must
            // still be rejected (an `&&` between the negated checks would
            // wrongly accept it).
            const tree:RatchetTree = [
                { nodeType: 'leaf', leaf: leafNode },
                {
                    nodeType: 'parent',
                    parent: { hpkePublicKey: new Uint8Array(), parentHash: new Uint8Array(), unmergedLeaves: [1] },
                },
                undefined,
            ]

            const error = validateUnmergedLeaves(tree)

            t.ok(error instanceof ValidationError, 'should return a ValidationError')
            t.equal(
                error?.message,
                'Unmerged leaf did not represent a non-blank descendant leaf node',
                'should have correct error message',
            )
        } catch (error:any) {
            if (shouldSkip(error)) {
                t.comment(`Skipping ${cs}: ${error.message}`)
                return
            }
            throw error
        }
    })
}
