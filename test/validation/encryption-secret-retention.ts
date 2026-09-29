/**
 * Simulates a compromise of a `ClientState` taken right after each way
 * of entering an epoch, and checks that no secret reachable from it
 * regenerates the epoch's secret tree. Whoever holds the epoch's
 * `encryption_secret` can rebuild every leaf ratchet at generation 0,
 * so every message of the epoch -- consumed or not -- would be
 * readable. See security-audit-2026-09.md H2.
 *
 * The check is observable rather than a field read: every buffer of
 * KDF size in the state is fed to `createSecretTree` as a candidate
 * root, and the candidate "wins" if it reproduces the state's own
 * generation-0 application ratchet for leaf 0.
 */
import { skipReason } from '../helpers/skip.js'
import { test } from '@substrate-system/tapzero'
import type { ClientState } from '../../src/client-state.js'
import {
    createGroup,
    joinGroup,
    makePskIndex,
} from '../../src/client-state.js'
import {
    createCommit,
    createGroupInfoWithExternalPubAndRatchetTree,
    joinGroupExternal,
} from '../../src/create-commit.js'
import { processPublicMessage } from '../../src/process-messages.js'
import { emptyPskIndex } from '../../src/psk-index.js'
import type {
    CiphersuiteImpl,
    CiphersuiteName,
} from '../../src/crypto/ciphersuite.js'
import { getCiphersuiteFromName } from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import { generateKeyPackage } from '../../src/key-package.js'
import { createSecretTree } from '../../src/secret-tree.js'
import { defaultLifetime } from '../../src/lifetime.js'
import { defaultCapabilities } from '../../src/default-capabilities.js'
import { leafWidth } from '../../src/treemath.js'
import { sampleCiphersuites } from '../helpers/suite-filter.js'
import { testClientConfig } from '../helpers/client-config.js'
import { testEveryoneCanMessageEveryone } from '../scenario/common.js'

function collectBuffers (
    value:unknown,
    size:number,
    out:Uint8Array[] = [],
    seen = new Set<unknown>()
):Uint8Array[] {
    if (value === null || typeof value !== 'object') return out
    if (seen.has(value)) return out
    seen.add(value)
    if (value instanceof Uint8Array) {
        if (value.length === size) out.push(value)
        return out
    }
    const children = value instanceof Map ?
        [...value.keys(), ...value.values()] :
        Object.values(value)
    for (const child of children) collectBuffers(child, size, out, seen)
    return out
}

function equalBytes (a:Uint8Array, b:Uint8Array):boolean {
    return a.length === b.length && a.every((x, i) => x === b[i])
}

async function regeneratesSecretTree (
    state:ClientState,
    cs:CiphersuiteImpl
):Promise<boolean> {
    const target = state.secretTree[0]!.application.secret
    const width = leafWidth(state.ratchetTree.length)
    for (const candidate of collectBuffers(state, cs.kdf.size)) {
        const tree = await createSecretTree(width, candidate.slice(), cs.kdf)
        if (equalBytes(tree[0]!.application.secret, target)) return true
    }
    return false
}

async function member (name:string, impl:CiphersuiteImpl) {
    return generateKeyPackage(
        {
            credentialType: 'basic',
            identity: new TextEncoder().encode(name),
        },
        defaultCapabilities(),
        defaultLifetime(),
        [],
        impl
    )
}

async function scenario (t:any, cipherSuite:CiphersuiteName) {
    const impl = await getCipherSuite(getCiphersuiteFromName(cipherSuite))
    const alice = await member('alice', impl)
    const bob = await member('bob', impl)
    const charlie = await member('charlie', impl)

    const created = await createGroup(
        new TextEncoder().encode('group'),
        alice.publicPackage,
        alice.privatePackage,
        [],
        impl,
        testClientConfig
    )
    t.ok(!(await regeneratesSecretTree(created, impl)),
        'createGroup state does not regenerate the secret tree')

    const addBob = await createCommit(
        { state: created, cipherSuite: impl },
        {
            extraProposals: [{
                proposalType: 'add',
                add: { keyPackage: bob.publicPackage },
            }],
        }
    )
    let aliceGroup = addBob.newState
    t.ok(!(await regeneratesSecretTree(aliceGroup, impl)),
        'createCommit state does not regenerate the secret tree')

    let bobGroup = await joinGroup(
        addBob.welcome!,
        bob.publicPackage,
        bob.privatePackage,
        emptyPskIndex,
        impl,
        aliceGroup.ratchetTree,
        undefined,
        testClientConfig
    )
    t.ok(!(await regeneratesSecretTree(bobGroup, impl)),
        'joinGroup state does not regenerate the secret tree')

    const groupInfo = await createGroupInfoWithExternalPubAndRatchetTree(
        aliceGroup, [], impl)
    const external = await joinGroupExternal(
        groupInfo,
        charlie.publicPackage,
        charlie.privatePackage,
        false,
        impl,
        undefined,
        testClientConfig
    )
    const charlieGroup = external.newState
    t.ok(!(await regeneratesSecretTree(charlieGroup, impl)),
        'joinGroupExternal state does not regenerate the secret tree')

    aliceGroup = (await processPublicMessage(
        aliceGroup,
        external.publicMessage,
        makePskIndex(aliceGroup, {}),
        impl
    )).newState
    bobGroup = (await processPublicMessage(
        bobGroup,
        external.publicMessage,
        makePskIndex(bobGroup, {}),
        impl
    )).newState
    t.ok(!(await regeneratesSecretTree(aliceGroup, impl)),
        'processed-commit state does not regenerate the secret tree')

    await testEveryoneCanMessageEveryone(
        [aliceGroup, bobGroup, charlieGroup], impl, t)
}

for (const cs of sampleCiphersuites()) {
    test('no state secret regenerates the secret tree ' + cs, async (t) => {
        try {
            await scenario(t, cs as CiphersuiteName)
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
