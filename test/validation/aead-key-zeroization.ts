import { test } from '@substrate-system/tapzero'
import { createGroup } from '../../src/client-state.js'
import type { Credential } from '../../src/credential.js'
import type { CiphersuiteImpl, CiphersuiteName } from '../../src/crypto/ciphersuite.js'
import { getCiphersuiteFromName } from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import { generateKeyPackage } from '../../src/key-package.js'
import { defaultLifetime } from '../../src/lifetime.js'
import { defaultCapabilities } from '../../src/default-capabilities.js'
import { protectApplicationData, unprotectPrivateMessage } from '../../src/message-protection.js'
import { testCiphersuites } from '../helpers/suite-filter.js'
import { testClientConfig } from '../helpers/client-config.js'

function skippable (error:any):boolean {
    return error?.name === 'NotSupportedError' || error?.name === 'DependencyError'
}

interface AeadCall {
    key:Uint8Array
    nonce:Uint8Array
}

class AeadFailure extends Error {
    constructor () {
        super('injected AEAD failure')
        this.name = 'AeadFailure'
    }
}

/**
 * Wrap a ciphersuite so every AEAD call records the key and nonce buffer
 * it was handed. `throwOnCall` is a zero-based index into that per-
 * direction call sequence; the matching call rejects instead of running
 * the real primitive.
 */
function spyOnAead (
    impl:CiphersuiteImpl,
    opts:{ throwOnEncrypt?:number; throwOnDecrypt?:number } = {},
):{ impl:CiphersuiteImpl; encrypts:AeadCall[]; decrypts:AeadCall[] } {
    const encrypts:AeadCall[] = []
    const decrypts:AeadCall[] = []

    const wrapped = {
        ...impl,
        hpke: {
            ...impl.hpke,
            encryptAead: async (
                key:Uint8Array,
                nonce:Uint8Array,
                aad:Uint8Array|undefined,
                pt:Uint8Array,
            ) => {
                const index = encrypts.length
                encrypts.push({ key, nonce })
                if (opts.throwOnEncrypt === index) throw new AeadFailure()
                return impl.hpke.encryptAead(key, nonce, aad, pt)
            },
            decryptAead: async (
                key:Uint8Array,
                nonce:Uint8Array,
                aad:Uint8Array|undefined,
                ct:Uint8Array,
            ) => {
                const index = decrypts.length
                decrypts.push({ key, nonce })
                if (opts.throwOnDecrypt === index) throw new AeadFailure()
                return impl.hpke.decryptAead(key, nonce, aad, ct)
            },
        },
    }

    return { impl: wrapped as CiphersuiteImpl, encrypts, decrypts }
}

async function makeSoloGroup (impl:CiphersuiteImpl, groupName:string) {
    const credential:Credential = {
        credentialType: 'basic',
        identity: new TextEncoder().encode('alice'),
    }
    const alice = await generateKeyPackage(
        credential,
        defaultCapabilities(),
        defaultLifetime(),
        [],
        impl,
    )

    return createGroup(
        new TextEncoder().encode(groupName),
        alice.publicPackage,
        alice.privatePackage,
        [],
        impl,
        testClientConfig,
    )
}

function assertZeroed (t:any, call:AeadCall|undefined, label:string) {
    if (call === undefined) throw new Error(`Expected an AEAD call for ${label}`)
    t.ok(call.key.every((b) => b === 0), `${label} key should be zeroized`)
    t.ok(call.nonce.every((b) => b === 0), `${label} nonce should be zeroized`)
}

async function expectAeadFailure (t:any, run:() => Promise<unknown>) {
    try {
        await run()
    } catch (error:any) {
        if (error?.name === 'AeadFailure') return
        throw error
    }
    t.fail('expected the injected AEAD failure to propagate')
}

for (const cs of testCiphersuites()) {
    test('protect zeroizes the content key and nonce when the AEAD throws ' + cs, async (t) => {
        try {
            await protectWipesContentKeyOnError(t, cs as CiphersuiteName)
        } catch (error:any) {
            if (skippable(error)) {
                t.comment(`Skipping ${cs}: ${error.message}`)
                return
            }
            throw error
        }
    })

    test('protect zeroizes the sender-data key and nonce ' + cs, async (t) => {
        try {
            await protectWipesSenderDataKey(t, cs as CiphersuiteName)
        } catch (error:any) {
            if (skippable(error)) {
                t.comment(`Skipping ${cs}: ${error.message}`)
                return
            }
            throw error
        }
    })

    test('protect zeroizes the sender-data key when the AEAD throws ' + cs, async (t) => {
        try {
            await protectWipesSenderDataKeyOnError(t, cs as CiphersuiteName)
        } catch (error:any) {
            if (skippable(error)) {
                t.comment(`Skipping ${cs}: ${error.message}`)
                return
            }
            throw error
        }
    })

    test('unprotect zeroizes the content key and nonce when the AEAD throws ' + cs, async (t) => {
        try {
            await unprotectWipesContentKeyOnError(t, cs as CiphersuiteName)
        } catch (error:any) {
            if (skippable(error)) {
                t.comment(`Skipping ${cs}: ${error.message}`)
                return
            }
            throw error
        }
    })

    test('unprotect zeroizes the sender-data key and nonce ' + cs, async (t) => {
        try {
            await unprotectWipesSenderDataKey(t, cs as CiphersuiteName)
        } catch (error:any) {
            if (skippable(error)) {
                t.comment(`Skipping ${cs}: ${error.message}`)
                return
            }
            throw error
        }
    })

    test('unprotect zeroizes the sender-data key when the AEAD throws ' + cs, async (t) => {
        try {
            await unprotectWipesSenderDataKeyOnError(t, cs as CiphersuiteName)
        } catch (error:any) {
            if (skippable(error)) {
                t.comment(`Skipping ${cs}: ${error.message}`)
                return
            }
            throw error
        }
    })
}

/**
 * `protect` runs two AEAD encryptions: index 0 is the content, encrypted
 * with the ratchet-derived key/nonce, index 1 is the sender data.
 */
const CONTENT_ENCRYPT = 0
const SENDER_DATA_ENCRYPT = 1

/**
 * `unprotect` runs them in the other order: index 0 opens the sender
 * data, index 1 opens the content.
 */
const SENDER_DATA_DECRYPT = 0
const CONTENT_DECRYPT = 1

async function sendOne (
    group:Awaited<ReturnType<typeof makeSoloGroup>>,
    impl:CiphersuiteImpl,
    secretTree = group.secretTree,
) {
    return protectApplicationData(
        group.signaturePrivateKey,
        group.keySchedule.senderDataSecret,
        new TextEncoder().encode('hello'),
        new Uint8Array(),
        group.groupContext,
        secretTree,
        group.privatePath.leafIndex,
        group.clientConfig.paddingConfig,
        impl,
    )
}

async function protectWipesContentKeyOnError (t:any, cipherSuite:CiphersuiteName) {
    const impl = await getCipherSuite(getCiphersuiteFromName(cipherSuite))
    const group = await makeSoloGroup(impl, 'protect-content-error')

    const spy = spyOnAead(impl, { throwOnEncrypt: CONTENT_ENCRYPT })

    await expectAeadFailure(t, () => sendOne(group, spy.impl))

    assertZeroed(t, spy.encrypts[CONTENT_ENCRYPT], 'the failed content encryption\'s')
}

async function protectWipesSenderDataKey (t:any, cipherSuite:CiphersuiteName) {
    const impl = await getCipherSuite(getCiphersuiteFromName(cipherSuite))
    const group = await makeSoloGroup(impl, 'protect-sender-data')

    const spy = spyOnAead(impl)
    await sendOne(group, spy.impl)

    assertZeroed(t, spy.encrypts[SENDER_DATA_ENCRYPT], 'the sender-data encryption\'s')
}

async function protectWipesSenderDataKeyOnError (t:any, cipherSuite:CiphersuiteName) {
    const impl = await getCipherSuite(getCiphersuiteFromName(cipherSuite))
    const group = await makeSoloGroup(impl, 'protect-sender-data-error')

    const spy = spyOnAead(impl, { throwOnEncrypt: SENDER_DATA_ENCRYPT })

    await expectAeadFailure(t, () => sendOne(group, spy.impl))

    assertZeroed(t, spy.encrypts[SENDER_DATA_ENCRYPT], 'the failed sender-data encryption\'s')
}

// a recipient decrypts from its own unconsumed copy of the tree; the
// sender's copy has its generation-0 secret wiped in place by the send.

async function unprotectWipesContentKeyOnError (t:any, cipherSuite:CiphersuiteName) {
    const impl = await getCipherSuite(getCiphersuiteFromName(cipherSuite))
    const group = await makeSoloGroup(impl, 'unprotect-content-error')

    const recipientSecretTree = structuredClone(group.secretTree)
    const sent = await sendOne(group, impl)

    const spy = spyOnAead(impl, { throwOnDecrypt: CONTENT_DECRYPT })

    await expectAeadFailure(t, () => unprotectPrivateMessage(
        group.keySchedule.senderDataSecret,
        sent.privateMessage,
        recipientSecretTree,
        group.ratchetTree,
        group.groupContext,
        group.clientConfig.keyRetentionConfig,
        spy.impl,
    ))

    assertZeroed(t, spy.decrypts[CONTENT_DECRYPT], 'the failed content decryption\'s')
}

async function unprotectWipesSenderDataKey (t:any, cipherSuite:CiphersuiteName) {
    const impl = await getCipherSuite(getCiphersuiteFromName(cipherSuite))
    const group = await makeSoloGroup(impl, 'unprotect-sender-data')

    const recipientSecretTree = structuredClone(group.secretTree)
    const sent = await sendOne(group, impl)

    const spy = spyOnAead(impl)

    await unprotectPrivateMessage(
        group.keySchedule.senderDataSecret,
        sent.privateMessage,
        recipientSecretTree,
        group.ratchetTree,
        group.groupContext,
        group.clientConfig.keyRetentionConfig,
        spy.impl,
    )

    assertZeroed(t, spy.decrypts[SENDER_DATA_DECRYPT], 'the sender-data decryption\'s')
}

async function unprotectWipesSenderDataKeyOnError (t:any, cipherSuite:CiphersuiteName) {
    const impl = await getCipherSuite(getCiphersuiteFromName(cipherSuite))
    const group = await makeSoloGroup(impl, 'unprotect-sender-data-error')

    const recipientSecretTree = structuredClone(group.secretTree)
    const sent = await sendOne(group, impl)

    const spy = spyOnAead(impl, { throwOnDecrypt: SENDER_DATA_DECRYPT })

    await expectAeadFailure(t, () => unprotectPrivateMessage(
        group.keySchedule.senderDataSecret,
        sent.privateMessage,
        recipientSecretTree,
        group.ratchetTree,
        group.groupContext,
        group.clientConfig.keyRetentionConfig,
        spy.impl,
    ))

    assertZeroed(t, spy.decrypts[SENDER_DATA_DECRYPT], 'the failed sender-data decryption\'s')
}
