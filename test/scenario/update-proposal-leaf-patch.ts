/**
 * An Update proposal that carries a `LeafNodePatch`: bob rotates his
 * credential, signature key or capabilities through an Update another
 * member commits, without leaving the group.
 */
import { test } from '@substrate-system/tapzero'
import { skipReason } from '../helpers/skip.js'
import type { ClientState } from '../../src/client-state.js'
import {
    createGroup,
    joinGroup,
    makePskIndex,
} from '../../src/client-state.js'
import { createCommit } from '../../src/create-commit.js'
import type { CreateCommitOptions } from '../../src/create-commit.js'
import {
    createApplicationMessage,
    createProposal,
} from '../../src/create-message.js'
import { createUpdateProposal } from '../../src/index.js'
import type { LeafNodePatch } from '../../src/index.js'
import { processMessage } from '../../src/process-messages.js'
import { acceptAll } from '../../src/incoming-message-action.js'
import { emptyPskIndex } from '../../src/psk-index.js'
import type { ClientConfig } from '../../src/client-config.js'
import type { Credential } from '../../src/credential.js'
import type {
    CiphersuiteImpl,
    CiphersuiteName,
} from '../../src/crypto/ciphersuite.js'
import { getCiphersuiteFromName } from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import { generateKeyPackage } from '../../src/key-package.js'
import type { MLSMessage } from '../../src/message.js'
import type { LeafNode } from '../../src/leaf-node.js'
import { defaultLifetime } from '../../src/lifetime.js'
import { defaultCapabilities } from '../../src/default-capabilities.js'
import { leafToNodeIndex, toLeafIndex } from '../../src/treemath.js'
import {
    sampleCiphersuites,
    testCiphersuites,
} from '../helpers/suite-filter.js'
import {
    discardPendingProposal,
    listPendingProposals,
} from '../../src/unapplied-proposals.js'
import { ValidationError } from '../../src/mls-error.js'
import type { Proposal } from '../../src/proposal.js'
import {
    encodeRequiredCapabilities,
} from '../../src/required-capabilities.js'
import { testClientConfig } from '../helpers/client-config.js'
import { testEveryoneCanMessageEveryone } from './common.js'

const enc = new TextEncoder()

function isUnsupported (error:any):boolean {
    return error?.name === 'NotSupportedError' ||
        error?.name === 'DependencyError'
}

function run (
    name:string,
    suites:string[],
    body:(t:any, cs:CiphersuiteImpl) => Promise<void>,
):void {
    for (const cs of suites) {
        test(name + ' - ' + cs, async (t) => {
            try {
                const impl = await getCipherSuite(
                    getCiphersuiteFromName(cs as CiphersuiteName))
                await body(t, impl)
            } catch (error:any) {
                if (isUnsupported(error)) {
                    t.comment(`Skipping ${cs}: ${skipReason(error)}`)
                    return
                }
                throw error
            }
        })
    }
}

function basic (name:string):Credential {
    return { credentialType: 'basic', identity: enc.encode(name) }
}

function sameCredential (a:Credential, b:Credential):boolean {
    return a.credentialType === 'basic' && b.credentialType === 'basic' &&
        new TextDecoder().decode(a.identity) ===
            new TextDecoder().decode(b.identity)
}

function leafAt (state:ClientState, leafIndex:number):LeafNode {
    const node = state.ratchetTree[leafToNodeIndex(toLeafIndex(leafIndex))]
    if (node?.nodeType !== 'leaf') throw new Error('expected a leaf')
    return node.leaf
}

function framed (message:MLSMessage) {
    if (
        message.wireformat !== 'mls_private_message' &&
        message.wireformat !== 'mls_public_message'
    ) throw new Error('Expected a framed message')
    return message
}

async function receive (
    state:ClientState,
    message:MLSMessage,
    cs:CiphersuiteImpl,
):Promise<ClientState> {
    return (await processMessage(
        framed(message), state, makePskIndex(state, {}), acceptAll, cs,
    )).newState
}

/**
 * Alice at leaf 0, bob at 1 and charlie at 2. `configs` overrides a
 * member's `ClientConfig`, and `extensions` adds extension types to a
 * member's capabilities.
 */
async function threeMembers (
    cs:CiphersuiteImpl,
    configs:{ alice?:ClientConfig; bob?:ClientConfig } = {},
    extensions:{ alice?:number[]; bob?:number[]; charlie?:number[] } = {},
) {
    const pkg = (name:'alice'|'bob'|'charlie') => {
        const caps = defaultCapabilities()
        const withExtensions = {
            ...caps,
            extensions: [...caps.extensions, ...(extensions[name] ?? [])],
        }
        return generateKeyPackage(basic(name), withExtensions,
            defaultLifetime(), [], cs)
    }
    const a = await pkg('alice')
    const b = await pkg('bob')
    const c = await pkg('charlie')

    const created = await createGroup(enc.encode('group'),
        a.publicPackage, a.privatePackage, [], cs,
        configs.alice ?? testClientConfig)
    const added = await createCommit({ state: created, cipherSuite: cs }, {
        extraProposals: [b, c].map((m) => ({
            proposalType: 'add' as const,
            add: { keyPackage: m.publicPackage },
        })),
    })
    const join = (m:typeof b, config:ClientConfig) => joinGroup(
        added.welcome!, m.publicPackage, m.privatePackage, emptyPskIndex,
        cs, added.newState.ratchetTree, undefined, config)

    return {
        alice: added.newState,
        bob: await join(b, configs.bob ?? testClientConfig),
        charlie: await join(c, testClientConfig),
    }
}

/** A message from `sender` that `receiver` decrypts and verifies. */
async function delivers (
    sender:ClientState,
    receiver:ClientState,
    cs:CiphersuiteImpl,
):Promise<boolean> {
    const sent = await createApplicationMessage(sender, enc.encode('hi'), cs)
    const got = await processMessage(
        {
            wireformat: 'mls_private_message',
            privateMessage: sent.privateMessage,
        },
        receiver, makePskIndex(receiver, {}), acceptAll, cs)
    return got.kind === 'applicationMessage' &&
        new TextDecoder().decode(got.message) === 'hi'
}

/**
 * Bob proposes an Update with `patch`, alice and charlie store it, and
 * alice commits it.
 */
async function bobProposesAliceCommits (
    group:{ alice:ClientState; bob:ClientState; charlie:ClientState },
    cs:CiphersuiteImpl,
    patch:LeafNodePatch,
    commitOptions?:CreateCommitOptions,
) {
    const proposed = await createUpdateProposal(group.bob, false, cs,
        { leafNodePatch: patch })
    const alice = await receive(group.alice, proposed.message, cs)
    const charlie = await receive(group.charlie, proposed.message, cs)
    const commit = await createCommit({ state: alice, cipherSuite: cs },
        commitOptions)
    return { proposed, alice, charlie, commit }
}

run('an Update proposal rotates bob\'s signature key and credential',
    testCiphersuites(), async (t, cs) => {
        const group = await threeMembers(cs)
        const keys = await cs.signature.keygen()
        const renamed = basic('bob, renamed')

        const { proposed, charlie, commit } = await bobProposesAliceCommits(
            group, cs, { signatureKeyPair: keys, credential: renamed })
        const bob = await receive(proposed.newState, commit.commit, cs)
        const charlie1 = await receive(charlie, commit.commit, cs)
        const alice1 = commit.newState

        for (const [who, state] of [
            ['alice', alice1], ['bob', bob], ['charlie', charlie1],
        ] as const) {
            t.deepEqual(leafAt(state, 1).signaturePublicKey, keys.publicKey,
                `${who} holds bob's new signature key`)
            t.ok(sameCredential(leafAt(state, 1).credential, renamed),
                `${who} holds bob's new credential`)
        }
        t.ok(await delivers(bob, alice1, cs),
            'a message bob signs afterwards verifies at alice')
        t.ok(await delivers(bob, charlie1, cs),
            'a message bob signs afterwards verifies at charlie')
        await testEveryoneCanMessageEveryone([alice1, bob, charlie1], cs, t)
    })

run('alice\'s service sees bob\'s new credential with his old one as ' +
    'priorCredential', sampleCiphersuites(), async (t, cs) => {
    const seen:[Credential, Credential | undefined][] = []
    const recording:ClientConfig = {
        ...testClientConfig,
        authService: {
            async validateCredential (credential, _key, prior) {
                seen.push([credential, prior])
                return true
            },
        },
    }
    const group = await threeMembers(cs, { alice: recording })
    const renamed = basic('bob, renamed')

    seen.length = 0
    await bobProposesAliceCommits(group, cs, { credential: renamed })

    t.ok(seen.some(([credential, prior]) =>
        sameCredential(credential, renamed) &&
        prior !== undefined && sameCredential(prior, basic('bob'))),
    'alice\'s service saw the new credential with the old as prior')
})

run('bob keeps signing with his old key until the Update is committed',
    sampleCiphersuites(), async (t, cs) => {
        const group = await threeMembers(cs)
        const keys = await cs.signature.keygen()

        const proposed = await createUpdateProposal(group.bob, false, cs,
            { leafNodePatch: { signatureKeyPair: keys } })
        let alice = await receive(group.alice, proposed.message, cs)

        // an application message is refused while a proposal is pending,
        // so bob's next message is a second proposal, signed like any
        // other handshake message
        const dave = await generateKeyPackage(basic('dave'),
            defaultCapabilities(), defaultLifetime(), [], cs)
        const addDave = await createProposal(proposed.newState, false, {
            proposalType: 'add',
            add: { keyPackage: dave.publicPackage },
        }, cs)
        alice = await receive(alice, addDave.message, cs)
        t.equal(listPendingProposals(alice).length, 2,
            'alice verified and stored bob\'s message sent before the commit')

        const commit = await createCommit({ state: alice, cipherSuite: cs })
        const bob = await receive(addDave.newState, commit.commit, cs)
        t.deepEqual(leafAt(bob, 1).signaturePublicKey, keys.publicKey,
            'the commit applied bob\'s Update')
        t.ok(await delivers(bob, commit.newState, cs),
            'bob signs with the new key once the Update is committed')
    })

run('a commit without bob\'s patched Update leaves him on his old key',
    testCiphersuites(), async (t, cs) => {
        const group = await threeMembers(cs)
        const oldKey = leafAt(group.bob, 1).signaturePublicKey
        const keys = await cs.signature.keygen()

        const proposed = await createUpdateProposal(group.bob, false, cs,
            { leafNodePatch: { signatureKeyPair: keys } })
        let alice = await receive(group.alice, proposed.message, cs)
        const charlie = await receive(group.charlie, proposed.message, cs)

        // alice drops bob's Update and commits without it
        const [pending] = listPendingProposals(alice)
        alice = discardPendingProposal(alice, pending!.ref)
        const commit = await createCommit({ state: alice, cipherSuite: cs })

        const processed = await processMessage(framed(commit.commit),
            proposed.newState, makePskIndex(proposed.newState, {}),
            acceptAll, cs)
        const charlie1 = await receive(charlie, commit.commit, cs)

        if (keys.signKey instanceof Uint8Array) {
            t.ok(processed.consumed.includes(keys.signKey),
                'the pending signature key is in consumed')
        } else {
            t.comment('the signature key is a CryptoKey, not bytes')
        }
        for (const b of processed.consumed) b.fill(0)
        const bob = processed.newState

        t.deepEqual(leafAt(commit.newState, 1).signaturePublicKey, oldKey,
            'alice still holds bob\'s old signature key')
        t.ok(await delivers(bob, commit.newState, cs),
            'a message bob signs afterwards verifies at alice')
        t.ok(await delivers(bob, charlie1, cs),
            'a message bob signs afterwards verifies at charlie')
    })

run('a patch bob\'s own service refuses makes createUpdateProposal ' +
    'reject and leaves the state unchanged', sampleCiphersuites(),
async (t, cs) => {
    const refusesMallory:ClientConfig = {
        ...testClientConfig,
        authService: {
            async validateCredential (credential) {
                return !sameCredential(credential, basic('mallory'))
            },
        },
    }
    const group = await threeMembers(cs, { bob: refusesMallory })
    // clientConfig holds functions, which structuredClone refuses
    const withoutConfig = ({ clientConfig: _, ...rest }:ClientState) => rest
    const before = structuredClone(withoutConfig(group.bob))

    let refusal:unknown
    try {
        await createUpdateProposal(group.bob, false, cs,
            { leafNodePatch: { credential: basic('mallory') } })
    } catch (error) {
        if (isUnsupported(error)) throw error
        refusal = error
    }
    t.ok(refusal instanceof ValidationError,
        'createUpdateProposal rejects the refused credential')
    t.deepEqual(withoutConfig(group.bob), before,
        'the state passed in is unchanged')

    const commit = await createCommit({ state: group.bob, cipherSuite: cs })
    const alice = await receive(group.alice, commit.commit, cs)
    const charlie = await receive(group.charlie, commit.commit, cs)
    await testEveryoneCanMessageEveryone(
        [alice, commit.newState, charlie], cs, t)
})

const EXTENSION_X = 0xf0a0

function requireX ():Proposal {
    return {
        proposalType: 'group_context_extensions',
        groupContextExtensions: {
            extensions: [{
                extensionType: 'required_capabilities',
                extensionData: encodeRequiredCapabilities({
                    extensionTypes: [EXTENSION_X],
                    proposalTypes: [],
                    credentialTypes: [],
                }),
            }],
        },
    }
}

run('once bob\'s Update adds extension X to his capabilities, the ' +
    'group can require X', sampleCiphersuites(), async (t, cs) => {
    const group = await threeMembers(cs, {},
        { alice: [EXTENSION_X], charlie: [EXTENSION_X] })

    // control: bob joined without X
    let refused = false
    try {
        await createCommit({ state: group.alice, cipherSuite: cs },
            { extraProposals: [requireX()] })
    } catch (error) {
        if (isUnsupported(error)) throw error
        refused = error instanceof ValidationError
    }
    t.ok(refused, 'requiring X is refused while bob lacks it')

    const caps = leafAt(group.bob, 1).capabilities
    const updated = await bobProposesAliceCommits(group, cs, {
        capabilities: {
            ...caps,
            extensions: [...caps.extensions, EXTENSION_X],
        },
    })
    let bob = await receive(updated.proposed.newState,
        updated.commit.commit, cs)
    let charlie = await receive(updated.charlie, updated.commit.commit, cs)

    const required = await createCommit(
        { state: updated.commit.newState, cipherSuite: cs },
        { extraProposals: [requireX()] })
    bob = await receive(bob, required.commit, cs)
    charlie = await receive(charlie, required.commit, cs)
    const alice = required.newState

    t.ok(bob.groupContext.extensions.some((e) =>
        e.extensionType === 'required_capabilities'),
    'bob\'s group context requires X')
    t.equal(charlie.groupContext.epoch, alice.groupContext.epoch,
        'charlie reached alice\'s epoch')
    t.equal(bob.groupContext.epoch, alice.groupContext.epoch,
        'bob reached alice\'s epoch')
    await testEveryoneCanMessageEveryone([alice, bob, charlie], cs, t)
})
