import { test } from '@substrate-system/tapzero'
import { skipReason } from '../helpers/skip.js'
import {
    createGroup,
    joinGroup,
    makePskIndex,
} from '../../src/client-state.js'
import type { ClientState } from '../../src/client-state.js'
import { createCommit } from '../../src/create-commit.js'
import type { CreateCommitOptions } from '../../src/create-commit.js'
import { createApplicationMessage } from '../../src/create-message.js'
import { processMessage } from '../../src/process-messages.js'
import { acceptAll } from '../../src/incoming-message-action.js'
import { emptyPskIndex } from '../../src/psk-index.js'
import type { ClientConfig } from '../../src/client-config.js'
import type { Credential } from '../../src/credential.js'
import type {
    CiphersuiteName,
    CiphersuiteImpl,
} from '../../src/crypto/ciphersuite.js'
import {
    getCiphersuiteFromName
} from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import { generateKeyPackage } from '../../src/key-package.js'
import { defaultLifetime } from '../../src/lifetime.js'
import { defaultCapabilities } from '../../src/default-capabilities.js'
import type { LeafNode } from '../../src/leaf-node.js'
import {
    sampleCiphersuites,
    testCiphersuites,
} from '../helpers/suite-filter.js'
import { testClientConfig } from '../helpers/client-config.js'
import { testEveryoneCanMessageEveryone } from './common.js'
import type { Capabilities } from '../../src/capabilities.js'
import type { Proposal } from '../../src/proposal.js'
import {
    encodeRequiredCapabilities
} from '../../src/required-capabilities.js'
import { ValidationError } from '../../src/mls-error.js'
import type { LeafNodePatch } from '../../src/index.js'

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

async function rejectsWith (
    cls:abstract new (...args:any[]) => Error,
    fn:() => Promise<unknown>,
):Promise<boolean> {
    try {
        await fn()
        return false
    } catch (err) {
        if (isUnsupported(err)) throw err
        return err instanceof cls
    }
}

function sameCredential (a:Credential, b:Credential):boolean {
    return a.credentialType === 'basic' && b.credentialType === 'basic' &&
        new TextDecoder().decode(a.identity) ===
            new TextDecoder().decode(b.identity)
}

function leafAt (state:ClientState, leafIndex:number):LeafNode {
    const node = state.ratchetTree[leafIndex * 2]
    if (node?.nodeType !== 'leaf') throw new Error('expected a leaf')
    return node.leaf
}

async function aliceAndBob (
    impl:CiphersuiteImpl,
    bobConfig:ClientConfig = testClientConfig,
    aliceConfig:ClientConfig = testClientConfig,
):Promise<{ alice:ClientState, bob:ClientState }> {
    const a = await generateKeyPackage(basic('alice'), defaultCapabilities(),
        defaultLifetime(), [], impl)
    const b = await generateKeyPackage(basic('bob'), defaultCapabilities(),
        defaultLifetime(), [], impl)

    const alice0 = await createGroup(enc.encode('patch-group'),
        a.publicPackage, a.privatePackage, [], impl, aliceConfig)

    const add = await createCommit({ state: alice0, cipherSuite: impl }, {
        extraProposals: [{
            proposalType: 'add',
            add: { keyPackage: b.publicPackage },
        }],
    })

    const bob = await joinGroup(add.welcome!, b.publicPackage,
        b.privatePackage, emptyPskIndex, impl, add.newState.ratchetTree,
        undefined, bobConfig)

    return { alice: add.newState, bob }
}

/** Commits from `committer` and has `receiver` process it. */
async function commitAndProcess (
    committer:ClientState,
    receiver:ClientState,
    impl:CiphersuiteImpl,
    options?:CreateCommitOptions,
):Promise<[ClientState, ClientState]> {
    const res = await createCommit({ state: committer, cipherSuite: impl },
        options)
    const commit = res.commit
    if (commit.wireformat !== 'mls_private_message' &&
        commit.wireformat !== 'mls_public_message') {
        throw new Error('expected a framed commit')
    }
    const processed = await processMessage(commit, receiver,
        makePskIndex(receiver, {}), acceptAll, impl)
    return [res.newState, processed.newState]
}

/** A message from `sender` that `receiver` decrypts and verifies. */
async function delivers (
    sender:ClientState,
    receiver:ClientState,
    impl:CiphersuiteImpl,
):Promise<boolean> {
    const payload = enc.encode('after the patch')
    const sent = await createApplicationMessage(sender, payload, impl)
    const got = await processMessage(
        {
            wireformat: 'mls_private_message',
            privateMessage: sent.privateMessage,
        },
        receiver, makePskIndex(receiver, {}), acceptAll, impl)
    return got.kind === 'applicationMessage' &&
        new TextDecoder().decode(got.message) === 'after the patch'
}

run('a commit patch rotates the committer\'s signature key',
    testCiphersuites(), async (t, impl) => {
        const { alice, bob } = await aliceAndBob(impl)
        const keys = await impl.signature.keygen()

        const [alice1, bob1] = await commitAndProcess(alice, bob, impl, {
            leafNodePatch: { signatureKeyPair: keys },
        })

        t.deepEqual(leafAt(bob1, 0).signaturePublicKey, keys.publicKey,
            'bob holds alice\'s new signature key')
        t.ok(await delivers(alice1, bob1, impl),
            'a message alice signs afterwards verifies at bob')
    })

run('a commit patch rotates the committer\'s credential, shown to peers ' +
    'with the old one as priorCredential', sampleCiphersuites(),
async (t, impl) => {
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
    const { alice, bob } = await aliceAndBob(impl, recording)
    const renamed = basic('alice, renamed')

    seen.length = 0
    const [, bob1] = await commitAndProcess(alice, bob, impl, {
        leafNodePatch: { credential: renamed },
    })

    t.ok(seen.some(([credential, prior]) =>
        sameCredential(credential, renamed) &&
        prior !== undefined && sameCredential(prior, basic('alice'))),
    'bob\'s service saw the new credential with the old as prior')
    t.ok(sameCredential(leafAt(bob1, 0).credential, renamed),
        'bob\'s tree holds the new credential in alice\'s leaf')
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

function withX (leaf:LeafNode):Capabilities {
    return {
        ...leaf.capabilities,
        extensions: [...leaf.capabilities.extensions, EXTENSION_X],
    }
}

run('once every member\'s commit patch adds extension X to its ' +
    'capabilities, the group can require X', sampleCiphersuites(),
async (t, impl) => {
    let { alice, bob } = await aliceAndBob(impl)

    // control: before the patches nobody supports X
    t.ok(await rejectsWith(ValidationError, () => createCommit(
        { state: alice, cipherSuite: impl },
        { extraProposals: [requireX()] })),
    'requiring X is refused while no member has it')

    ;[alice, bob] = await commitAndProcess(alice, bob, impl, {
        leafNodePatch: { capabilities: withX(leafAt(alice, 0)) },
    })
    ;[bob, alice] = await commitAndProcess(bob, alice, impl, {
        leafNodePatch: { capabilities: withX(leafAt(bob, 1)) },
    })
    ;[alice, bob] = await commitAndProcess(alice, bob, impl, {
        extraProposals: [requireX()],
    })

    t.equal(alice.groupContext.epoch, bob.groupContext.epoch,
        'both members reached the same epoch')
    t.ok(bob.groupContext.extensions.some((e) =>
        e.extensionType === 'required_capabilities'),
    'bob\'s group context requires X')
    await testEveryoneCanMessageEveryone([alice, bob], impl, t)
})

run('a patch on an Add-only commit forces an UpdatePath carrying the ' +
    'patched leaf', sampleCiphersuites(), async (t, impl) => {
    const { alice, bob } = await aliceAndBob(impl)
    const c = await generateKeyPackage(basic('charlie'),
        defaultCapabilities(), defaultLifetime(), [], impl)
    const keys = await impl.signature.keygen()
    const renamed = basic('alice, renamed')
    const patch:LeafNodePatch = { credential: renamed, signatureKeyPair: keys }

    const res = await createCommit({ state: alice, cipherSuite: impl }, {
        extraProposals: [{
            proposalType: 'add',
            add: { keyPackage: c.publicPackage },
        }],
        leafNodePatch: patch,
    })
    if (res.commit.wireformat !== 'mls_private_message') {
        throw new Error('expected a private message')
    }
    const bob1 = (await processMessage(res.commit, bob,
        makePskIndex(bob, {}), acceptAll, impl)).newState

    t.ok(sameCredential(leafAt(bob1, 0).credential, renamed),
        'bob holds alice\'s patched credential')
    t.deepEqual(leafAt(bob1, 0).signaturePublicKey, keys.publicKey,
        'bob holds alice\'s patched signature key')
    t.equal(leafAt(bob1, 0).leafNodeSource, 'commit',
        'alice\'s leaf came from an UpdatePath')

    // the Welcome's GroupInfo is verified against alice's new key
    const charlie = await joinGroup(res.welcome!, c.publicPackage,
        c.privatePackage, emptyPskIndex, impl, res.newState.ratchetTree,
        undefined, testClientConfig)
    await testEveryoneCanMessageEveryone([res.newState, bob1, charlie],
        impl, t)
})

run('a patch whose credential the committer\'s own service refuses ' +
    'makes createCommit reject and leaves the state usable',
sampleCiphersuites(), async (t, impl) => {
    const refusesMallory:ClientConfig = {
        ...testClientConfig,
        authService: {
            async validateCredential (credential) {
                return !sameCredential(credential, basic('mallory'))
            },
        },
    }
    const { alice, bob } = await aliceAndBob(impl, testClientConfig,
        refusesMallory)
    // clientConfig holds functions, which structuredClone refuses
    const withoutConfig = ({ clientConfig: _, ...rest }:ClientState) => rest
    const before = structuredClone(withoutConfig(alice))

    t.ok(await rejectsWith(ValidationError, () => createCommit(
        { state: alice, cipherSuite: impl },
        { leafNodePatch: { credential: basic('mallory') } })),
    'createCommit rejects the refused credential')

    t.deepEqual(withoutConfig(alice), before,
        'the state passed in is unchanged')

    const [alice1, bob1] = await commitAndProcess(alice, bob, impl)
    t.equal(bob1.groupContext.epoch, alice.groupContext.epoch + 1n,
        'the same state still commits')
    await testEveryoneCanMessageEveryone([alice1, bob1], impl, t)
})
