import { test } from '@substrate-system/tapzero'
import { skipReason } from '../helpers/skip.js'
import {
    createCommit,
    createGroup,
    joinGroup,
    joinGroupWithGroupInfo,
    type Extension,
} from '../../src/index.js'
import { emptyPskIndex } from '../../src/psk-index.js'
import type { Credential } from '../../src/credential.js'
import type { CiphersuiteName } from '../../src/crypto/ciphersuite.js'
import { getCiphersuiteFromName } from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import { generateKeyPackage } from '../../src/key-package.js'
import { defaultLifetime } from '../../src/lifetime.js'
import { defaultCapabilities } from '../../src/default-capabilities.js'
import { testEveryoneCanMessageEveryone } from './common.js'
import { sampleCiphersuites } from '../helpers/suite-filter.js'
import { testClientConfig } from '../helpers/client-config.js'

for (const cs of sampleCiphersuites()) {
    test('joinGroupWithGroupInfo returns GroupInfo extensions ' + cs,
        async (t) => {
            try {
                await joinWithGroupInfo(t, cs)
            } catch (error:any) {
                if (error?.name === 'NotSupportedError' ||
                    error?.name === 'DependencyError') {
                    t.comment(`Skipping ${cs}: ${skipReason(error)}`)
                    return
                }
                throw error
            }
        })
}

async function joinWithGroupInfo (t:any, cipherSuite:CiphersuiteName) {
    const impl = await getCipherSuite(getCiphersuiteFromName(cipherSuite))
    const credential = (name:string):Credential => ({
        credentialType: 'basic',
        identity: new TextEncoder().encode(name),
    })

    const alice = await generateKeyPackage(credential('alice'),
        defaultCapabilities(), defaultLifetime(), [], impl)
    const bob = await generateKeyPackage(credential('bob'),
        defaultCapabilities(), defaultLifetime(), [], impl)

    const aliceGroup = await createGroup(
        new TextEncoder().encode('group1'),
        alice.publicPackage,
        alice.privatePackage,
        [],
        impl,
        testClientConfig,
    )

    // an application extension type from the private-use range
    const appExtension:Extension = {
        extensionType: 0xff0a,
        extensionData: new TextEncoder().encode('room settings'),
    }

    const addBob = await createCommit(
        { state: aliceGroup, cipherSuite: impl },
        {
            extraProposals: [{
                proposalType: 'add',
                add: { keyPackage: bob.publicPackage },
            }],
            ratchetTreeExtension: true,
            groupInfoExtensions: [appExtension],
        },
    )

    // joinGroup zeroizes the init key it is handed, so each join gets
    // its own copy
    const bobKeys = () => ({
        ...bob.privatePackage,
        initPrivateKey: bob.privatePackage.initPrivateKey.slice(),
    })

    const { state: bobGroup, groupInfo } = await joinGroupWithGroupInfo(
        addBob.welcome!,
        bob.publicPackage,
        bobKeys(),
        emptyPskIndex,
        impl,
        undefined,
        undefined,
        testClientConfig,
    )

    const found = groupInfo.extensions.find(
        (e) => e.extensionType === appExtension.extensionType)
    t.deepEqual(found, appExtension,
        'the GroupInfo carries the application extension')
    t.equal(bobGroup.groupContext.epoch, addBob.newState.groupContext.epoch,
        'bob joins at alice\'s epoch')

    await testEveryoneCanMessageEveryone([addBob.newState, bobGroup], impl, t)

    const plainBob = await joinGroup(
        addBob.welcome!,
        bob.publicPackage,
        bobKeys(),
        emptyPskIndex,
        impl,
        undefined,
        undefined,
        testClientConfig,
    )
    t.deepEqual(plainBob.keySchedule.epochAuthenticator,
        bobGroup.keySchedule.epochAuthenticator,
        'joinGroup joins the same epoch from the same Welcome')
    await testEveryoneCanMessageEveryone([addBob.newState, plainBob], impl, t)
}
