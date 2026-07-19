import { test } from '@substrate-system/tapzero'
import { createGroup } from '../../src/client-state.js'
import { createGroupInfoWithExternalPub } from '../../src/create-commit.js'
import type { Credential } from '../../src/credential.js'
import type { CiphersuiteName } from '../../src/crypto/ciphersuite.js'
import {
    getCiphersuiteFromName,
    ciphersuites
} from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import { generateKeyPackage } from '../../src/key-package.js'
import { defaultLifetime } from '../../src/lifetime.js'
import type { Capabilities } from '../../src/capabilities.js'
import type { Extension, ExtensionType } from '../../src/extension.js'

for (const cs of Object.keys(ciphersuites)) {
    test('GroupInfo Custom Extensions ' + cs, async (t) => {
        try {
            await customExtensionTest(t, cs as CiphersuiteName)
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

async function customExtensionTest (t:any, cipherSuite:CiphersuiteName) {
    const impl = await getCipherSuite(getCiphersuiteFromName(cipherSuite))

    const customExtensionType:ExtensionType = 7

    const capabilities:Capabilities = {
        extensions: [customExtensionType],
        credentials: ['basic'],
        proposals: [],
        versions: ['mls10'],
        ciphersuites: [cipherSuite],
    }

    const aliceCredential:Credential = {
        credentialType: 'basic',
        identity: new TextEncoder().encode('alice')
    }
    const alice = await generateKeyPackage(aliceCredential, capabilities, defaultLifetime, [], impl)

    const groupId = new TextEncoder().encode('group1')

    const aliceGroup = await createGroup(
        groupId,
        alice.publicPackage,
        alice.privatePackage,
        [],
        impl
    )

    const extensionData = new TextEncoder().encode('custom extension data')

    const customExtension:Extension = {
        extensionType: customExtensionType,
        extensionData,
    }

    const gi = await createGroupInfoWithExternalPub(aliceGroup, [customExtension], impl)

    const foundExtension = gi.extensions.find((e) => e.extensionType === customExtensionType)
    t.deepEqual(foundExtension, customExtension, 'should find custom extension in GroupInfo')
}
