/**
 * Audit 2026-09 L2. A joiner whose lowest common ancestor with the
 * committer is non-blank, and does not list the joiner as unmerged, must
 * find a `path_secret` in its GroupSecrets: without one it joins holding
 * only its leaf key and cannot follow the next path commit. `joinGroup`
 * rejects such a Welcome up front, and a receiver whose private path does
 * not overlap an UpdatePath gets a `ValidationError`, not an
 * `InternalError`.
 */
import { test } from '@substrate-system/tapzero'
import { skipReason } from '../helpers/skip.js'
import { createGroup, joinGroup, makePskIndex } from '../../src/client-state.js'
import type { ClientState } from '../../src/client-state.js'
import { createCommit } from '../../src/create-commit.js'
import type { CreateCommitResult } from '../../src/create-commit.js'
import { processPrivateMessage } from '../../src/process-messages.js'
import { emptyPskIndex } from '../../src/psk-index.js'
import type { Credential } from '../../src/credential.js'
import type { CiphersuiteName } from '../../src/crypto/ciphersuite.js'
import { getCiphersuiteFromName } from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import type { CiphersuiteImpl } from '../../src/crypto/ciphersuite.js'
import { generateKeyPackage, makeKeyPackageRef } from '../../src/key-package.js'
import { defaultLifetime } from '../../src/lifetime.js'
import { defaultCapabilities } from '../../src/default-capabilities.js'
import { ValidationError } from '../../src/mls-error.js'
import {
    decryptGroupSecrets,
    encryptGroupSecrets,
} from '../../src/welcome.js'
import type { Welcome } from '../../src/welcome.js'
import { leafToNodeIndex, toLeafIndex } from '../../src/treemath.js'
import { sampleCiphersuites } from '../helpers/suite-filter.js'
import { testClientConfig } from '../helpers/client-config.js'

type Member = Awaited<ReturnType<typeof generateKeyPackage>>

for (const cs of sampleCiphersuites()) {
    guarded('a path-commit Welcome without the joiner\'s path_secret ' +
        'is rejected', cs, strippedPathSecretRejected)
    guarded('an Add-only Welcome joins without a path_secret and ' +
        'follows the next path commit', cs, addOnlyJoins)
    guarded('an honest path-commit Welcome joins and follows the next ' +
        'path commit', cs, honestPathJoins)
    guarded('a receiver with no key in the UpdatePath resolution gets ' +
        'a ValidationError', cs, noOverlapIsValidationError)
}

function guarded (
    name:string,
    cs:string,
    body:(t:any, impl:CiphersuiteImpl) => Promise<void>,
) {
    test(`${name} - ${cs}`, async (t) => {
        let impl:CiphersuiteImpl
        try {
            impl = await getCipherSuite(
                getCiphersuiteFromName(cs as CiphersuiteName))
        } catch (error:any) {
            t.comment(`Skipping ${cs}: ${skipReason(error)}`)
            return
        }
        await body(t, impl)
    })
}

async function makeMember (name:string, impl:CiphersuiteImpl) {
    const credential:Credential = {
        credentialType: 'basic',
        identity: new TextEncoder().encode(name),
    }
    return generateKeyPackage(credential, defaultCapabilities(),
        defaultLifetime(), [], impl)
}

function addProposal (member:Member) {
    return {
        proposalType: 'add' as const,
        add: { keyPackage: member.publicPackage },
    }
}

async function process (
    state:ClientState,
    commit:CreateCommitResult,
    impl:CiphersuiteImpl,
):Promise<ClientState> {
    if (commit.commit.wireformat !== 'mls_private_message') {
        throw new Error('expected a private message commit')
    }
    const result = await processPrivateMessage(state,
        commit.commit.privateMessage, makePskIndex(state, {}), impl)
    if (result.kind !== 'newState') throw new Error('expected a commit')
    return result.newState
}

function join (
    welcome:Welcome,
    member:Member,
    committer:ClientState,
    impl:CiphersuiteImpl,
) {
    return joinGroup(welcome, member.publicPackage,
        {
            ...member.privatePackage,
            initPrivateKey: member.privatePackage.initPrivateKey.slice()
        },
        emptyPskIndex, impl, committer.ratchetTree, undefined,
        testClientConfig)
}

/**
 * alice and bob, then an empty commit from alice so the root is
 * populated with no unmerged leaves.
 */
async function twoMemberGroup (impl:CiphersuiteImpl) {
    const alice = await makeMember('alice', impl)
    const bob = await makeMember('bob', impl)
    const groupId = new TextEncoder().encode('welcome-path-secret')
    const aliceState = await createGroup(groupId, alice.publicPackage,
        alice.privatePackage, [], impl, testClientConfig)

    const addBob = await createCommit({ state: aliceState, cipherSuite: impl },
        { extraProposals: [addProposal(bob)] })
    if (addBob.welcome === undefined) throw new Error('expected a welcome')
    let bobState = await join(addBob.welcome, bob, addBob.newState, impl)

    const empty = await createCommit({
        state: addBob.newState,
        cipherSuite: impl,
    })
    bobState = await process(bobState, empty, impl)

    return { alice: empty.newState, bob: bobState }
}

/**
 * A three member group plus a commit from alice that removes bob and adds
 * carol in his place. The Remove forces an UpdatePath, so the root is
 * rotated with no unmerged leaves and carol needs a path secret.
 */
async function pathCommitWelcome (impl:CiphersuiteImpl) {
    const { alice, bob } = await twoMemberGroup(impl)
    const carol = await makeMember('carol', impl)
    const commit = await createCommit({ state: alice, cipherSuite: impl }, {
        extraProposals: [
            {
                proposalType: 'remove',
                remove: { removed: bob.privatePath.leafIndex },
            },
            addProposal(carol),
        ],
    })
    if (commit.welcome === undefined) throw new Error('expected a welcome')
    return { commit, carol }
}

async function strippedPathSecretRejected (t:any, impl:CiphersuiteImpl) {
    const { commit, carol } = await pathCommitWelcome(impl)
    const welcome = commit.welcome!

    const ref = await makeKeyPackageRef(carol.publicPackage, impl.hash)
    const secrets = await decryptGroupSecrets(
        await impl.hpke.importPrivateKey(
            carol.privatePackage.initPrivateKey.slice()),
        ref, welcome, impl.hpke)
    if (secrets === undefined) throw new Error('expected group secrets')
    t.ok(secrets.pathSecret !== undefined,
        'the honest Welcome should carry a path_secret')

    const egs = await encryptGroupSecrets(
        await impl.hpke.importPublicKey(carol.publicPackage.initKey),
        welcome.encryptedGroupInfo,
        { ...secrets, pathSecret: undefined },
        impl.hpke,
    )
    const stripped:Welcome = {
        ...welcome,
        secrets: [{
            newMember: ref,
            encryptedGroupSecrets: { kemOutput: egs.enc, ciphertext: egs.ct },
        }],
    }

    try {
        await join(stripped, carol, commit.newState, impl)
        t.fail('joinGroup should reject a Welcome missing a needed ' +
            'path_secret')
    } catch (error) {
        t.ok(error instanceof ValidationError,
            'the rejection should be a ValidationError')
    }
}

async function addOnlyJoins (t:any, impl:CiphersuiteImpl) {
    const { alice, bob } = await twoMemberGroup(impl)
    const carol = await makeMember('carol', impl)
    const addCarol = await createCommit({ state: alice, cipherSuite: impl },
        { extraProposals: [addProposal(carol)] })
    if (addCarol.welcome === undefined) throw new Error('expected a welcome')

    const carolState = await join(addCarol.welcome, carol,
        addCarol.newState, impl)
    const bobState = await process(bob, addCarol, impl)

    const next = await createCommit({ state: bobState, cipherSuite: impl })
    const followed = await process(carolState, next, impl)
    t.equal(followed.groupContext.epoch, next.newState.groupContext.epoch,
        'the joiner should follow the next path commit')
}

async function honestPathJoins (t:any, impl:CiphersuiteImpl) {
    const { commit, carol } = await pathCommitWelcome(impl)
    const carolState = await join(commit.welcome!, carol,
        commit.newState, impl)

    const next = await createCommit({
        state: commit.newState,
        cipherSuite: impl,
    })
    const followed = await process(carolState, next, impl)
    t.equal(followed.groupContext.epoch, next.newState.groupContext.epoch,
        'the joiner should follow the next path commit')
}

/**
 * The receiver state a Welcome without a path_secret used to produce: bob
 * holds his leaf key but not the key of the parent his leaf sits under,
 * and that parent is the whole copath resolution carol encrypts to.
 */
async function noOverlapIsValidationError (t:any, impl:CiphersuiteImpl) {
    const { alice, bob } = await twoMemberGroup(impl)
    const carol = await makeMember('carol', impl)
    const dave = await makeMember('dave', impl)

    const addTwo = await createCommit({ state: alice, cipherSuite: impl },
        { extraProposals: [addProposal(carol), addProposal(dave)] })
    let bobState = await process(bob, addTwo, impl)
    const carolState = await join(addTwo.welcome!, carol,
        addTwo.newState, impl)

    // bob populates node 1 (his parent) and the root
    const bobCommit = await createCommit({ state: bobState, cipherSuite: impl })
    bobState = bobCommit.newState
    const carolNext = await process(carolState, bobCommit, impl)

    const carolCommit = await createCommit({
        state: carolNext,
        cipherSuite: impl,
    })

    const leafNode = leafToNodeIndex(
        toLeafIndex(bobState.privatePath.leafIndex))
    const leafOnly:ClientState = {
        ...bobState,
        privatePath: {
            ...bobState.privatePath,
            privateKeys: {
                [leafNode]: bobState.privatePath.privateKeys[leafNode]!,
            },
        },
    }

    try {
        await process(leafOnly, carolCommit, impl)
        t.fail('the commit should be rejected')
    } catch (error) {
        t.ok(error instanceof ValidationError,
            'the rejection should be a ValidationError')
    }
}
