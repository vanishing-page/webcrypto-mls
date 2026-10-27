import { test } from '@substrate-system/tapzero'
import { skipReason } from '../helpers/skip.js'
import { createGroup, joinGroup } from '../../src/client-state.js'
import type { ClientState } from '../../src/client-state.js'
import { createCommit } from '../../src/create-commit.js'
import { processMessage } from '../../src/process-messages.js'
import { acceptAll } from '../../src/incoming-message-action.js'
import { emptyPskIndex } from '../../src/psk-index.js'
import type {
    CiphersuiteImpl,
    CiphersuiteName,
} from '../../src/crypto/ciphersuite.js'
import {
    ciphersuites,
    getCiphersuiteFromName,
} from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import { generateKeyPackage, signKeyPackage } from '../../src/key-package.js'
import type {
    KeyPackage,
    PrivateKeyPackage,
} from '../../src/key-package.js'
import type { MLSMessage } from '../../src/message.js'
import { defaultLifetime } from '../../src/lifetime.js'
import { defaultCapabilities } from '../../src/default-capabilities.js'
import { ValidationError } from '../../src/mls-error.js'
import type { ProtocolVersionName } from '../../src/protocol-version.js'
import { protocolVersions } from '../../src/protocol-version.js'
import { forgeAddCommit } from '../helpers/forge-commit.js'
import { testCiphersuites } from '../helpers/suite-filter.js'
import { testClientConfig } from '../helpers/client-config.js'

// Ported from upstream ts-mls: a commit whose Add carries a KeyPackage
// for another ciphersuite or protocol version is refused by the member
// receiving it. createCommit refuses to build one, so the commit is
// forged, and the first test holds the forgery to an honest KeyPackage.

/**
 * A version the library does not ship, registered only while a case
 * runs: the KeyPackage has to stay encodable, since the commit carrying
 * it is signed and MACed over its encoding.
 */
const FUTURE_VERSION = 'mls-future' as ProtocolVersionName

for (const cs of testCiphersuites()) {
    test('a forged commit adding an honest KeyPackage is processed - ' +
        cs, async (t) => {
        const fx = await fixtureOrSkip(t, cs)
        if (fx === undefined) return

        const { commit } = await forgeAddCommit(fx.alice,
            [fx.carol.publicPackage], fx.impl)
        const received = await receive(fx.bob, commit, fx.impl)
        t.equal(received.groupContext.epoch,
            fx.alice.groupContext.epoch + 1n,
            'the receiver processes the forged commit')
    })

    test('a commit whose Add carries a KeyPackage for another ' +
        'ciphersuite is refused by its receiver - ' + cs, async (t) => {
        const fx = await fixtureOrSkip(t, cs)
        if (fx === undefined) return
        const other = (Object.keys(ciphersuites) as CiphersuiteName[])
            .find((name) => name !== cs)!
        const kp = await resign(fx.carol, { cipherSuite: other }, fx.impl)

        const { commit } = await forgeAddCommit(fx.alice, [kp], fx.impl)
        await rejects(t, () => receive(fx.bob, commit, fx.impl),
            'an Add of another ciphersuite')
    })

    test('a commit whose Add carries a KeyPackage for another protocol ' +
        'version is refused by its receiver - ' + cs, async (t) => {
        const fx = await fixtureOrSkip(t, cs)
        if (fx === undefined) return
        const registry = protocolVersions as unknown as
            Record<string, number>
        registry[FUTURE_VERSION] = 0xf00d
        try {
            const kp = await resign(fx.carol, { version: FUTURE_VERSION },
                fx.impl)
            const { commit } = await forgeAddCommit(fx.alice, [kp], fx.impl)
            await rejects(t, () => receive(fx.bob, commit, fx.impl),
                'an Add of another protocol version')
        } finally {
            delete registry[FUTURE_VERSION]
        }
    })
}

interface Member {
    publicPackage:KeyPackage;
    privatePackage:PrivateKeyPackage;
}

interface Fixture {
    impl:CiphersuiteImpl;
    alice:ClientState;
    bob:ClientState;
    carol:Member;
}

/**
 * Alice and bob in one group, and a KeyPackage for carol; or undefined
 * after reporting a skip when the environment lacks one of the
 * ciphersuite's primitives. Only setup runs under the skip.
 */
async function fixtureOrSkip (
    t:any,
    cs:CiphersuiteName,
):Promise<Fixture | undefined> {
    let impl:CiphersuiteImpl
    let a:Member
    try {
        impl = await getCipherSuite(getCiphersuiteFromName(cs))
        a = await member('alice', impl)
    } catch (error:any) {
        if (error?.name === 'NotSupportedError' ||
            error?.name === 'DependencyError') {
            t.comment(`Skipping ${cs}: ${skipReason(error)}`)
            return undefined
        }
        throw error
    }

    const b = await member('bob', impl)
    const solo = await createGroup(new TextEncoder().encode('group'),
        a.publicPackage, a.privatePackage, [], impl, testClientConfig)
    const add = await createCommit(
        { state: solo, cipherSuite: impl },
        {
            extraProposals: [{
                proposalType: 'add',
                add: { keyPackage: b.publicPackage },
            }],
            ratchetTreeExtension: true,
        },
    )
    const bob = await joinGroup(add.welcome!, b.publicPackage,
        b.privatePackage, emptyPskIndex, impl, undefined, undefined,
        testClientConfig)

    return {
        impl,
        alice: add.newState,
        bob,
        carol: await member('carol', impl),
    }
}

async function member (name:string, impl:CiphersuiteImpl):Promise<Member> {
    return generateKeyPackage(
        { credentialType: 'basic', identity: new TextEncoder().encode(name) },
        defaultCapabilities(),
        defaultLifetime(),
        [],
        impl,
    )
}

/** `m`'s KeyPackage with `changes`, re-signed by `m` */
async function resign (
    m:Member,
    changes:Partial<Omit<KeyPackage, 'signature'>>,
    impl:CiphersuiteImpl,
):Promise<KeyPackage> {
    const { signature: _signature, ...tbs } = m.publicPackage
    return signKeyPackage({ ...tbs, ...changes },
        m.privatePackage.signaturePrivateKey, impl.signature)
}

async function receive (
    state:ClientState,
    msg:MLSMessage,
    impl:CiphersuiteImpl,
):Promise<ClientState> {
    if (msg.wireformat !== 'mls_public_message' &&
        msg.wireformat !== 'mls_private_message') {
        throw new Error('expected a framed message')
    }
    const result = await processMessage(msg, state, emptyPskIndex,
        acceptAll, impl)
    return result.newState
}

async function rejects (
    t:any,
    fn:() => Promise<unknown>,
    what:string,
):Promise<void> {
    try {
        await fn()
        t.fail(what + ' should be refused')
    } catch (error:any) {
        t.ok(error instanceof ValidationError,
            `${what} is refused as ValidationError (got ${error?.name})`)
    }
}
