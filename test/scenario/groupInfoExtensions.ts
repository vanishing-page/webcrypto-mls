import { test } from '@substrate-system/tapzero'
import { createGroup } from '../../src/clientState.js'
import { createGroupInfoWithExternalPub } from '../../src/createCommit.js'
import type { Credential } from '../../src/credential.js'
import type { CiphersuiteName } from '../../src/crypto/ciphersuite.js'
import { getCiphersuiteFromName, ciphersuites } from '../../src/crypto/ciphersuite.js'
import { getCiphersuiteImpl } from '../../src/crypto/getCiphersuiteImpl.js'
import { generateKeyPackage } from '../../src/keyPackage.js'
import { defaultLifetime } from '../../src/lifetime.js'
import type { Capabilities } from '../../src/capabilities.js'
import type { Extension, ExtensionType } from '../../src/extension.js'

for (const cs of Object.keys(ciphersuites)) {
    test('GroupInfo Custom Extensions ' + cs, async (t) => {
        await customExtensionTest(t, cs as CiphersuiteName)
    })
}

async function customExtensionTest (t: any, cipherSuite: CiphersuiteName) {
    const impl = await getCiphersuiteImpl(getCiphersuiteFromName(cipherSuite))

    const customExtensionType: ExtensionType = 7

    const capabilities: Capabilities = {
        extensions: [customExtensionType],
        credentials: ['basic'],
        proposals: [],
        versions: ['mls10'],
        ciphersuites: [cipherSuite],
    }

    const aliceCredential: Credential = { credentialType: 'basic', identity: new TextEncoder().encode('alice') }
    const alice = await generateKeyPackage(aliceCredential, capabilities, defaultLifetime, [], impl)

    const groupId = new TextEncoder().encode('group1')

    const aliceGroup = await createGroup(groupId, alice.publicPackage, alice.privatePackage, [], impl)

    const extensionData = new TextEncoder().encode('custom extension data')

    const customExtension: Extension = {
        extensionType: customExtensionType,
        extensionData,
    }

    const gi = await createGroupInfoWithExternalPub(aliceGroup, [customExtension], impl)

    const foundExtension = gi.extensions.find((e) => e.extensionType === customExtensionType)
    t.deepEqual(foundExtension, customExtension, 'should find custom extension in GroupInfo')
}
