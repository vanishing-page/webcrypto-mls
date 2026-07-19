import { test } from '@substrate-system/tapzero'
import { createGroup, joinGroup } from '../../src/client-state.js'
import { createCommit } from '../../src/create-commit.js'
import { accumulatePskSecret } from '../../src/psk-index.js'
import type { PskIndex } from '../../src/psk-index.js'
import { updatePskSecret } from '../../src/presharedkey.js'
import type { PreSharedKeyID } from '../../src/presharedkey.js'
import { makeResumptionPsk } from '../../src/resumption.js'
import type { Credential } from '../../src/credential.js'
import type { CiphersuiteName } from '../../src/crypto/ciphersuite.js'
import {
    ciphersuites,
    getCiphersuiteFromName
} from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import { generateKeyPackage } from '../../src/key-package.js'
import type { Proposal, ProposalAdd } from '../../src/proposal.js'
import { ValidationError } from '../../src/mls-error.js'
import { defaultLifetime } from '../../src/lifetime.js'
import { defaultCapabilities } from '../../src/default-capabilities.js'

function isSkippableError (error:any):boolean {
    return error?.name === 'NotSupportedError' || error?.name === 'DependencyError'
}

for (const cs of Object.keys(ciphersuites)) {
    test(`joinGroup allows application-usage resumption PSK without prior state ${cs}`, async (t) => {
        try {
            await applicationUsageAllowed(cs as CiphersuiteName, t)
        } catch (error:any) {
            if (isSkippableError(error)) {
                t.comment(`Skipping ${cs}: ${error.message}`)
                return
            }
            throw error
        }
    })

    test(`joinGroup validates every resumption PSK in the list, not just the first ${cs}`, async (t) => {
        try {
            await validatesAllResumptionPsks(cs as CiphersuiteName, t)
        } catch (error:any) {
            if (isSkippableError(error)) {
                t.comment(`Skipping ${cs}: ${error.message}`)
                return
            }
            throw error
        }
    })

    test(`accumulatePskSecret rejects a pskNonce with the wrong length ${cs}`, async (t) => {
        try {
            await rejectsBadNonceLength(cs as CiphersuiteName, t)
        } catch (error:any) {
            if (isSkippableError(error)) {
                t.comment(`Skipping ${cs}: ${error.message}`)
                return
            }
            throw error
        }
    })

    test(`updatePskSecret bounds-checks index/count before uint16 encoding ${cs}`, async (t) => {
        try {
            await rejectsOutOfRangeIndexAndCount(cs as CiphersuiteName, t)
        } catch (error:any) {
            if (isSkippableError(error)) {
                t.comment(`Skipping ${cs}: ${error.message}`)
                return
            }
            throw error
        }
    })
}

async function makeMember (name:string, impl:Awaited<ReturnType<typeof getCipherSuite>>) {
    const credential:Credential = {
        credentialType: 'basic',
        identity: new TextEncoder().encode(name),
    }
    return generateKeyPackage(credential, defaultCapabilities(), defaultLifetime, [], impl)
}

async function applicationUsageAllowed (cipherSuite:CiphersuiteName, t:any) {
    const impl = await getCipherSuite(getCiphersuiteFromName(cipherSuite))

    const alice = await makeMember('alice', impl)
    const bob = await makeMember('bob', impl)

    const groupId = new TextEncoder().encode('app-psk-group')
    const newGroup = await createGroup(groupId, alice.publicPackage, alice.privatePackage, [], impl)

    const pskNonce = impl.rng.randomBytes(impl.kdf.size)
    const pskSecret = impl.rng.randomBytes(impl.kdf.size)

    const applicationPskId:PreSharedKeyID = {
        psktype: 'resumption',
        usage: 'application',
        pskGroupId: new TextEncoder().encode('unrelated-group'),
        pskEpoch: 999n,
        pskNonce,
    }

    const pskSearch:PskIndex = {
        findPsk (id) {
            if (id.psktype === 'resumption' && id.usage === 'application') return pskSecret
            return undefined
        },
    }

    const addBobProposal:ProposalAdd = {
        proposalType: 'add',
        add: { keyPackage: bob.publicPackage },
    }

    const pskProposal:Proposal = {
        proposalType: 'psk',
        psk: { preSharedKeyId: applicationPskId },
    }

    const commitResult = await createCommit(
        { state: newGroup, pskIndex: pskSearch, cipherSuite: impl },
        { extraProposals: [addBobProposal, pskProposal] },
    )

    // No resumingFromState is passed -- an application-usage resumption PSK
    // must be accepted exactly like an external PSK.
    const bobGroup = await joinGroup(
        commitResult.welcome!,
        bob.publicPackage,
        bob.privatePackage,
        pskSearch,
        impl,
        commitResult.newState.ratchetTree,
        undefined,
    )

    t.equal(bobGroup.groupContext.epoch, 1n, 'bob should have joined at epoch 1')
}

async function validatesAllResumptionPsks (cipherSuite:CiphersuiteName, t:any) {
    const impl = await getCipherSuite(getCiphersuiteFromName(cipherSuite))

    const alice = await makeMember('alice', impl)
    const groupId = new TextEncoder().encode('branch-source-group')
    const aliceGroup = await createGroup(groupId, alice.publicPackage, alice.privatePackage, [], impl)

    const aliceNew = await makeMember('alice', impl)
    const bobNew = await makeMember('bob', impl)

    const newGroupId = new TextEncoder().encode('branch-target-group')
    const newGroup = await createGroup(newGroupId, aliceNew.publicPackage, aliceNew.privatePackage, [], impl)

    const goodPsk = makeResumptionPsk(aliceGroup, 'branch', impl)
    const goodPskEpoch = aliceGroup.groupContext.epoch

    const badPskId:PreSharedKeyID = {
        psktype: 'resumption',
        usage: 'branch',
        pskGroupId: aliceGroup.groupContext.groupId,
        pskEpoch: aliceGroup.groupContext.epoch + 100n,
        pskNonce: impl.rng.randomBytes(impl.kdf.size),
    }
    const badPskSecret = impl.rng.randomBytes(impl.kdf.size)

    const pskSearch:PskIndex = {
        findPsk (id) {
            if (id.psktype === 'resumption' && id.usage === 'branch') {
                if (id.pskEpoch === goodPskEpoch) return goodPsk.secret
                return badPskSecret
            }
            return undefined
        },
    }

    const addBobProposal:ProposalAdd = {
        proposalType: 'add',
        add: { keyPackage: bobNew.publicPackage },
    }

    // Good psk is listed first, bad (wrong epoch) psk second -- a joinGroup
    // that only inspects the first resumption PSK in the list would miss it.
    const goodPskProposal:Proposal = { proposalType: 'psk', psk: { preSharedKeyId: goodPsk.id } }
    const badPskProposal:Proposal = { proposalType: 'psk', psk: { preSharedKeyId: badPskId } }

    const commitResult = await createCommit(
        { state: newGroup, pskIndex: pskSearch, cipherSuite: impl },
        { extraProposals: [addBobProposal, goodPskProposal, badPskProposal] },
    )

    try {
        await joinGroup(
            commitResult.welcome!,
            bobNew.publicPackage,
            bobNew.privatePackage,
            pskSearch,
            impl,
            commitResult.newState.ratchetTree,
            aliceGroup,
        )
        t.fail('should have thrown ValidationError for the second (bad) resumption PSK')
    } catch (error) {
        t.ok(error instanceof ValidationError, 'should throw ValidationError for a resumption PSK epoch mismatch')
    }
}

async function rejectsBadNonceLength (cipherSuite:CiphersuiteName, t:any) {
    const impl = await getCipherSuite(getCiphersuiteFromName(cipherSuite))

    const badId:PreSharedKeyID = {
        psktype: 'external',
        pskId: new TextEncoder().encode('some-external-psk'),
        pskNonce: new Uint8Array(1),
    }

    const pskSearch:PskIndex = {
        findPsk: () => new Uint8Array(impl.kdf.size),
    }

    try {
        await accumulatePskSecret([badId], pskSearch, impl, new Uint8Array(impl.kdf.size))
        t.fail('should have thrown ValidationError for a wrong-length pskNonce')
    } catch (error) {
        t.ok(error instanceof ValidationError, 'should throw ValidationError for a wrong-length pskNonce')
    }

    // sanity check: correct-length nonce still works via emptyPskIndex's sibling path
    const goodId:PreSharedKeyID = {
        psktype: 'external',
        pskId: new TextEncoder().encode('some-external-psk'),
        pskNonce: new Uint8Array(impl.kdf.size),
    }
    const [, ids] = await accumulatePskSecret([goodId], pskSearch, impl, new Uint8Array(impl.kdf.size))
    t.equal(ids.length, 1, 'correct-length pskNonce should be accepted')
}

async function rejectsOutOfRangeIndexAndCount (cipherSuite:CiphersuiteName, t:any) {
    const impl = await getCipherSuite(getCiphersuiteFromName(cipherSuite))

    const pskId:PreSharedKeyID = {
        psktype: 'external',
        pskId: new TextEncoder().encode('some-external-psk'),
        pskNonce: impl.rng.randomBytes(impl.kdf.size),
    }
    const psk = impl.rng.randomBytes(impl.kdf.size)
    const secret = new Uint8Array(impl.kdf.size)

    try {
        await updatePskSecret(secret, pskId, psk, 0x10000, 1, impl)
        t.fail('should have thrown ValidationError for an out-of-range index')
    } catch (error) {
        t.ok(error instanceof ValidationError, 'should throw ValidationError for an out-of-range index')
    }

    try {
        await updatePskSecret(secret, pskId, psk, 0, 0x10000, impl)
        t.fail('should have thrown ValidationError for an out-of-range count')
    } catch (error) {
        t.ok(error instanceof ValidationError, 'should throw ValidationError for an out-of-range count')
    }

    // in-range values should still succeed
    const result = await updatePskSecret(secret, pskId, psk, 0xffff, 0xffff, impl)
    t.equal(result.length, impl.kdf.size, 'in-range index/count should still succeed')
}
