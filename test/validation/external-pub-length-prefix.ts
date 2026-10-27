/**
 * RFC 9420 12.4.3.2 defines the `external_pub` extension's data as
 *
 *     struct { HPKEPublicKey external_pub; } ExternalPub;
 *
 * and `HPKEPublicKey` is `opaque<V>`, so the key travels behind a
 * variable-length prefix. These tests pin those bytes, join against a
 * GroupInfo whose extension is built by hand to the RFC, and refuse
 * each malformed shape as a `ValidationError`, since the GroupInfo is
 * peer input.
 *
 * The malformed GroupInfos are re-signed by the group's own signer, so
 * a refusal is the extension's doing and not the signature's. The
 * first case is the re-signing helper's honest control.
 */
import { test } from '@substrate-system/tapzero'
import { skipReason } from '../helpers/skip.js'
import { createGroup, makePskIndex } from '../../src/client-state.js'
import type { ClientState } from '../../src/client-state.js'
import {
    createGroupInfoWithExternalPub,
    createGroupInfoWithExternalPubAndRatchetTree,
    joinGroupExternal,
} from '../../src/create-commit.js'
import { processPublicMessage } from '../../src/process-messages.js'
import type { Credential } from '../../src/credential.js'
import type {
    CiphersuiteImpl,
    CiphersuiteName,
} from '../../src/crypto/ciphersuite.js'
import { getCiphersuiteFromName } from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import type { GroupInfo } from '../../src/group-info.js'
import { signGroupInfo } from '../../src/group-info.js'
import { generateKeyPackage } from '../../src/key-package.js'
import { defaultLifetime } from '../../src/lifetime.js'
import { defaultCapabilities } from '../../src/default-capabilities.js'
import { ValidationError } from '../../src/mls-error.js'
import { testCiphersuites } from '../helpers/suite-filter.js'
import { testClientConfig } from '../helpers/client-config.js'

for (const cs of testCiphersuites()) {
    test(`external_pub is a length-prefixed key ${cs}`, async (t) => {
        try {
            await externalPubTests(cs, t)
        } catch (error:any) {
            if (
                error?.name === 'NotSupportedError' ||
                error?.name === 'DependencyError'
            ) {
                t.comment(`Skipping ${cs}: ${skipReason(error)}`)
                return
            }
            throw error
        }
    })
}

/**
 * The RFC 9000 variable-length prefix, written out independently of
 * the codec under test. HPKE public keys stay under 16384 bytes.
 */
function rfcPrefix (len:number):Uint8Array {
    if (len < 64) return new Uint8Array([len])
    return new Uint8Array([0x40 | (len >> 8), len & 0xff])
}

function concat (...parts:Uint8Array[]):Uint8Array {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
    let offset = 0
    for (const p of parts) {
        out.set(p, offset)
        offset += p.length
    }
    return out
}

function member (name:string, impl:CiphersuiteImpl) {
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
 * Re-sign `gi` as its signer with the `external_pub` data replaced.
 */
function withExternalPub (
    gi:GroupInfo,
    data:Uint8Array,
    signer:ClientState,
    impl:CiphersuiteImpl,
):Promise<GroupInfo> {
    const extensions = gi.extensions.map((ex) => {
        return ex.extensionType === 'external_pub' ?
            { ...ex, extensionData: data } :
            ex
    })
    return signGroupInfo(
        {
            groupContext: gi.groupContext,
            extensions,
            confirmationTag: gi.confirmationTag,
            signer: gi.signer,
        },
        signer.signaturePrivateKey,
        impl.signature,
    )
}

function externalPubData (gi:GroupInfo):Uint8Array {
    const ext = gi.extensions.find((ex) => {
        return ex.extensionType === 'external_pub'
    })
    if (ext === undefined) throw new Error('no external_pub extension')
    return ext.extensionData
}

async function externalPubTests (cipherSuite:CiphersuiteName, t:any) {
    const impl = await getCipherSuite(getCiphersuiteFromName(cipherSuite))

    const alice = await member('alice', impl)
    const aliceGroup = await createGroup(
        new TextEncoder().encode('group1'),
        alice.publicPackage,
        alice.privatePackage,
        [],
        impl,
        testClientConfig,
    )

    const keyPair = await impl.hpke.deriveKeyPair(
        aliceGroup.keySchedule.externalSecret,
    )
    const key = await impl.hpke.exportPublicKey(keyPair.publicKey)
    const rfcData = concat(rfcPrefix(key.length), key)

    for (const gi of [
        await createGroupInfoWithExternalPub(aliceGroup, [], impl),
        await createGroupInfoWithExternalPubAndRatchetTree(
            aliceGroup, [], impl,
        ),
    ]) {
        t.deepEqual(externalPubData(gi), rfcData,
            'external_pub data is the prefixed HPKE public key')
    }

    const gi = await createGroupInfoWithExternalPubAndRatchetTree(
        aliceGroup, [], impl,
    )

    async function join (groupInfo:GroupInfo) {
        const charlie = await member('charlie', impl)
        return joinGroupExternal(
            groupInfo,
            charlie.publicPackage,
            charlie.privatePackage,
            false,
            impl,
            undefined,
            testClientConfig,
        )
    }

    // Honest control: re-signing unchanged bytes still joins.
    const control = await withExternalPub(
        gi, externalPubData(gi), aliceGroup, impl,
    )
    const controlJoin = await join(control)
    t.equal(controlJoin.newState.groupContext.epoch, 1n,
        're-signed GroupInfo with unchanged bytes still joins')

    // A GroupInfo built byte for byte to RFC 9420 joins, and the
    // existing member processes the external commit.
    const rfcJoin = await join(
        await withExternalPub(gi, rfcData, aliceGroup, impl),
    )
    const processed = await processPublicMessage(
        aliceGroup,
        rfcJoin.publicMessage,
        makePskIndex(aliceGroup, {}),
        impl,
    )
    t.deepEqual(
        processed.newState.keySchedule.epochAuthenticator,
        rfcJoin.newState.keySchedule.epochAuthenticator,
        'alice processes the external commit made against RFC bytes',
    )

    const prefix = rfcPrefix(key.length)
    const malformed:[string, Uint8Array][] = [
        ['an empty extension', new Uint8Array()],
        ['the bare key', key],
        ['a truncated key', rfcData.subarray(0, rfcData.length - 1)],
        ['a truncated length field', new Uint8Array([0x40])],
        [
            'a prefix longer than the data',
            concat(rfcPrefix(key.length + 1), key),
        ],
        [
            'a non-minimal prefix',
            concat(
                new Uint8Array([0x80, 0, key.length >> 8, key.length & 0xff]),
                key,
            ),
        ],
        ['trailing bytes', concat(prefix, key, new Uint8Array([0]))],
    ]

    for (const [label, data] of malformed) {
        const forged = await withExternalPub(gi, data, aliceGroup, impl)
        try {
            await join(forged)
            t.ok(false, `${label} should be refused`)
        } catch (err) {
            t.ok(err instanceof ValidationError,
                `${label} is refused with ValidationError, got ` +
                `${(err as any)?.constructor?.name}`)
        }
    }
}
