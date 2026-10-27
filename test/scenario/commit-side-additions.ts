import { test } from '@substrate-system/tapzero'
import { skipReason } from '../helpers/skip.js'
import {
    createGroup,
    joinGroup,
    makePskIndex
} from '../../src/client-state.js'
import type { ClientState } from '../../src/client-state.js'
import { createCommit } from '../../src/create-commit.js'
import { createApplicationMessage } from '../../src/create-message.js'
import { processMessage } from '../../src/process-messages.js'
import type {
    IncomingMessageCallback
} from '../../src/incoming-message-action.js'
import type { AuthenticatedSender } from '../../src/process-messages.js'
import type { MLSMessage } from '../../src/message.js'
import {
    decodeMlsMessage,
    encodeMlsMessage
} from '../../src/message.js'
import { testEveryoneCanMessageEveryone } from './common.js'
import {
    branchGroup,
    joinGroupFromBranch,
    joinGroupFromReinit,
    reinitCreateNewGroup,
    reinitGroup
} from '../../src/resumption.js'
import { UsageError } from '../../src/mls-error.js'
import {
    sameSignerKeyPackage
} from '../helpers/same-signer-key-package.js'
import { emptyPskIndex } from '../../src/psk-index.js'
import type {
    CiphersuiteImpl,
    CiphersuiteName
} from '../../src/crypto/ciphersuite.js'
import { getCiphersuiteFromName } from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import { generateKeyPackage } from '../../src/key-package.js'
import { defaultLifetime } from '../../src/lifetime.js'
import { defaultCapabilities } from '../../src/default-capabilities.js'
import type { Credential } from '../../src/credential.js'
import { sampleCiphersuites } from '../helpers/suite-filter.js'
import { testClientConfig } from '../helpers/client-config.js'

const enc = (s:string) => new TextEncoder().encode(s)

function run (
    name:string,
    body:(impl:CiphersuiteImpl, t:any) => Promise<void>,
) {
    for (const cs of sampleCiphersuites()) {
        test(`${name} ${cs}`, async (t) => {
            let impl:CiphersuiteImpl
            try {
                impl = await getCipherSuite(
                    getCiphersuiteFromName(cs as CiphersuiteName)
                )
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
            await body(impl, t)
        })
    }
}

function credential (name:string):Credential {
    return { credentialType: 'basic', identity: enc(name) }
}

async function member (name:string, impl:CiphersuiteImpl) {
    const cred = credential(name)
    const kp = await generateKeyPackage(
        cred,
        defaultCapabilities(),
        defaultLifetime(),
        [],
        impl,
    )
    return { credential: cred, ...kp }
}

async function aliceAndBob (impl:CiphersuiteImpl) {
    const alice = await member('alice', impl)
    const bob = await member('bob', impl)
    const aliceGroup0 = await createGroup(
        enc('group'),
        alice.publicPackage,
        alice.privatePackage,
        [],
        impl,
        testClientConfig,
    )
    const add = await createCommit(
        { state: aliceGroup0, cipherSuite: impl },
        {
            extraProposals: [{
                proposalType: 'add',
                add: { keyPackage: bob.publicPackage },
            }],
        },
    )
    const bobGroup = await joinGroup(
        add.welcome!,
        bob.publicPackage,
        bob.privatePackage,
        emptyPskIndex,
        impl,
        add.newState.ratchetTree,
        undefined,
        testClientConfig,
    )
    return { alice, bob, aliceGroup: add.newState, bobGroup }
}

async function receive (
    state:ClientState,
    message:MLSMessage,
    impl:CiphersuiteImpl,
    onMessage?:IncomingMessageCallback,
) {
    if (
        message.wireformat !== 'mls_private_message' &&
        message.wireformat !== 'mls_public_message'
    ) throw new Error('expected a framed message')
    return processMessage(
        message,
        state,
        makePskIndex(state, {}),
        onMessage,
        impl,
    )
}

function leafCredential (state:ClientState, leafIndex:number) {
    const node = state.ratchetTree[leafIndex * 2]
    return node?.nodeType === 'leaf' ? node.leaf.credential : undefined
}

run('commit callback receives the committer', async (impl, t) => {
    const { aliceGroup, bobGroup } = await aliceAndBob(impl)
    const commit = await createCommit({ state: aliceGroup, cipherSuite: impl })

    const seen:AuthenticatedSender[] = []
    const result = await receive(bobGroup, commit.commit, impl, (incoming) => {
        if (incoming.kind === 'commit') seen.push(incoming.committer)
        return 'accept'
    })

    t.equal(seen.length, 1, 'the callback saw one commit')
    t.equal(seen[0]?.senderType, 'member', 'the committer is a member')
    t.equal(seen[0]?.leafIndex, 0, "the committer is alice's leaf")
    t.deepEqual(
        leafCredential(bobGroup, seen[0]!.leafIndex!),
        credential('alice'),
        "the committer's leaf carries alice's credential",
    )
    t.equal(
        result.newState.groupContext.epoch,
        bobGroup.groupContext.epoch + 1n,
        'bob accepted the commit',
    )
})

run('rejecting a commit by its committer leaves state unchanged',
    async (impl, t) => {
        const { aliceGroup, bobGroup } = await aliceAndBob(impl)
        const app = await createApplicationMessage(
            aliceGroup,
            enc('before'),
            impl,
        )
        const commit = await createCommit({
            state: app.newState,
            cipherSuite: impl,
        })

        const refuseAlice:IncomingMessageCallback = (incoming) => (
            incoming.kind === 'commit' &&
            incoming.committer.leafIndex === 0
        ) ?
            'reject' :
            'accept'

        const rejected = await receive(
            bobGroup,
            commit.commit,
            impl,
            refuseAlice,
        )
        t.equal(rejected.kind, 'newState', 'the commit was handled')
        if (rejected.kind !== 'newState') return
        t.equal(rejected.actionTaken, 'reject', 'the callback rejected it')
        t.equal(
            rejected.newState.groupContext.epoch,
            bobGroup.groupContext.epoch,
            'bob stays in the old epoch',
        )

        const read = await receive(
            rejected.newState,
            {
                version: 'mls10',
                wireformat: 'mls_private_message',
                privateMessage: app.privateMessage,
            },
            impl,
        )
        t.equal(read.kind, 'applicationMessage', 'bob still decrypts')
        if (read.kind !== 'applicationMessage') return
        t.deepEqual(read.message, enc('before'), 'the old-epoch message')
    })

run('welcomeMessage round-trips and joins', async (impl, t) => {
    const alice = await member('alice', impl)
    const bob = await member('bob', impl)
    const aliceGroup = await createGroup(
        enc('group'),
        alice.publicPackage,
        alice.privatePackage,
        [],
        impl,
        testClientConfig,
    )
    const add = await createCommit(
        { state: aliceGroup, cipherSuite: impl },
        {
            extraProposals: [{
                proposalType: 'add',
                add: { keyPackage: bob.publicPackage },
            }],
        },
    )

    t.ok(add.welcomeMessage, 'a commit with an Add has a welcomeMessage')
    const bytes = encodeMlsMessage(add.welcomeMessage!)
    const decoded = decodeMlsMessage(bytes, 0)?.[0]
    t.equal(decoded?.wireformat, 'mls_welcome', 'it decodes as a Welcome')
    if (decoded?.wireformat !== 'mls_welcome') return

    const bobGroup = await joinGroup(
        decoded.welcome,
        bob.publicPackage,
        bob.privatePackage,
        emptyPskIndex,
        impl,
        add.newState.ratchetTree,
        undefined,
        testClientConfig,
    )
    t.equal(
        bobGroup.groupContext.epoch,
        add.newState.groupContext.epoch,
        'bob joined at alice\'s epoch',
    )
    await testEveryoneCanMessageEveryone([add.newState, bobGroup], impl, t)

    const empty = await createCommit({
        state: add.newState,
        cipherSuite: impl,
    })
    t.equal(empty.welcomeMessage, undefined, 'no Add, no welcomeMessage')
})

function resign (
    m:Awaited<ReturnType<typeof member>>,
    impl:CiphersuiteImpl,
) {
    return sameSignerKeyPackage(
        m.credential,
        m.publicPackage.leafNode.signaturePublicKey,
        m.privatePackage.signaturePrivateKey,
        impl,
    )
}

async function suspendedForReinit (impl:CiphersuiteImpl) {
    const { aliceGroup, bobGroup } = await aliceAndBob(impl)
    const reinit = await reinitGroup(
        aliceGroup,
        enc('reinit'),
        'mls10',
        impl.name,
        [],
        impl,
    )
    const bobResult = await receive(bobGroup, reinit.commit, impl)
    return { aliceGroup: reinit.newState, bobGroup: bobResult.newState }
}

run('branchGroup can send the ratchet tree in its Welcome',
    async (impl, t) => {
        const { alice, bob, aliceGroup, bobGroup } = await aliceAndBob(impl)
        const aliceNew = await resign(alice, impl)
        const bobNew = await resign(bob, impl)
        const branch = await branchGroup(
            aliceGroup,
            aliceNew.publicPackage,
            aliceNew.privatePackage,
            [bobNew.publicPackage],
            enc('branch'),
            impl,
            { ratchetTreeExtension: true, wireAsPublicMessage: true },
        )
        t.equal(
            branch.commit.wireformat,
            'mls_public_message',
            'the branch commit is a public message',
        )

        const bobBranch = await joinGroupFromBranch(
            bobGroup,
            branch.welcome!,
            bobNew.publicPackage,
            bobNew.privatePackage,
            undefined,
            impl,
        )
        await testEveryoneCanMessageEveryone(
            [branch.newState, bobBranch],
            impl,
            t,
        )
    })

run('reinitCreateNewGroup can send the ratchet tree in its Welcome',
    async (impl, t) => {
        const { aliceGroup, bobGroup } = await suspendedForReinit(impl)
        const aliceNew = await member('alice', impl)
        const bobNew = await member('bob', impl)
        const resumed = await reinitCreateNewGroup(
            aliceGroup,
            aliceNew.publicPackage,
            aliceNew.privatePackage,
            [bobNew.publicPackage],
            enc('reinit'),
            impl.name,
            [],
            undefined,
            { ratchetTreeExtension: true, wireAsPublicMessage: true },
        )
        t.equal(
            resumed.commit.wireformat,
            'mls_public_message',
            'the reinit commit is a public message',
        )

        const bobResumed = await joinGroupFromReinit(
            bobGroup,
            resumed.welcome!,
            bobNew.publicPackage,
            bobNew.privatePackage,
            undefined,
        )
        await testEveryoneCanMessageEveryone(
            [resumed.newState, bobResumed],
            impl,
            t,
        )
    })

async function joinWithoutTree (
    t:any,
    join:() => Promise<ClientState>,
    msg:string,
) {
    try {
        await join()
        t.fail(msg)
    } catch (err) {
        t.ok(err instanceof UsageError, msg)
    }
}

run('branch and reinit omit the ratchet tree by default', async (impl, t) => {
    const { alice, bob, aliceGroup, bobGroup } = await aliceAndBob(impl)
    const aliceNew = await resign(alice, impl)
    const bobNew = await resign(bob, impl)
    const branch = await branchGroup(
        aliceGroup,
        aliceNew.publicPackage,
        aliceNew.privatePackage,
        [bobNew.publicPackage],
        enc('branch'),
        impl,
    )
    t.equal(
        branch.commit.wireformat,
        'mls_private_message',
        'the branch commit is a private message by default',
    )
    await joinWithoutTree(t, () => joinGroupFromBranch(
        bobGroup,
        branch.welcome!,
        bobNew.publicPackage,
        bobNew.privatePackage,
        undefined,
        impl,
    ), 'a default branch Welcome carries no ratchet tree')
    const bobBranch = await joinGroupFromBranch(
        bobGroup,
        branch.welcome!,
        bobNew.publicPackage,
        bobNew.privatePackage,
        branch.newState.ratchetTree,
        impl,
    )
    await testEveryoneCanMessageEveryone(
        [branch.newState, bobBranch],
        impl,
        t,
    )

    const suspended = await suspendedForReinit(impl)
    const aliceReinit = await member('alice', impl)
    const bobReinit = await member('bob', impl)
    const resumed = await reinitCreateNewGroup(
        suspended.aliceGroup,
        aliceReinit.publicPackage,
        aliceReinit.privatePackage,
        [bobReinit.publicPackage],
        enc('reinit'),
        impl.name,
        [],
    )
    t.equal(
        resumed.commit.wireformat,
        'mls_private_message',
        'the reinit commit is a private message by default',
    )
    await joinWithoutTree(t, () => joinGroupFromReinit(
        suspended.bobGroup,
        resumed.welcome!,
        bobReinit.publicPackage,
        bobReinit.privatePackage,
        undefined,
    ), 'a default reinit Welcome carries no ratchet tree')
    const bobResumed = await joinGroupFromReinit(
        suspended.bobGroup,
        resumed.welcome!,
        bobReinit.publicPackage,
        bobReinit.privatePackage,
        resumed.newState.ratchetTree,
    )
    await testEveryoneCanMessageEveryone(
        [resumed.newState, bobResumed],
        impl,
        t,
    )
})
