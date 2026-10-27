import type { ClientState } from './client-state.js'
import { makePskIndex, createGroup, joinGroup } from './client-state.js'
import type {
    CreateCommitOptions,
    CreateCommitResult
} from './create-commit.js'
import { createCommit } from './create-commit.js'
import type { CiphersuiteName, CiphersuiteImpl } from './crypto/ciphersuite.js'
import { getCiphersuiteFromName } from './crypto/ciphersuite.js'
import { getCipherSuite } from './crypto/get-ciphersuite-impl.js'
import { defaultCryptoProvider } from './crypto/implementation/default/provider.js'
import type { CryptoProvider } from './crypto/provider.js'
import type { Extension } from './extension.js'
import type { KeyPackage, PrivateKeyPackage } from './key-package.js'
import { UsageError } from './mls-error.js'
import type { ResumptionPSKUsageName, PreSharedKeyID } from './presharedkey.js'
import type { Proposal, ProposalAdd, ProposalPSK } from './proposal.js'
import type { ProtocolVersionName } from './protocol-version.js'
import type { RatchetTree } from './ratchet-tree.js'
import type { Welcome } from './welcome.js'

/**
 * The `createCommit` options a resumption commit passes through, with
 * the same defaults: no ratchet tree in the Welcome, so the joiner
 * needs the tree out of band, and a commit framed as a private message.
 */
export type ResumptionOptions = Pick<
    CreateCommitOptions,
    'ratchetTreeExtension' | 'wireAsPublicMessage'
>

export async function reinitGroup (
    state:ClientState,
    groupId:Uint8Array,
    version:ProtocolVersionName,
    cipherSuite:CiphersuiteName,
    extensions:Extension[],
    cs:CiphersuiteImpl,
):Promise<CreateCommitResult> {
    const reinitProposal:Proposal = {
        proposalType: 'reinit',
        reinit: {
            groupId,
            version,
            cipherSuite,
            extensions,
        },
    }

    return createCommit(
        {
            state,
            pskIndex: makePskIndex(state, {}),
            cipherSuite: cs,
        },
        {
            extraProposals: [reinitProposal],
        },
    )
}

/**
 * Starts the group a ReInit resumes into. `consumed` is always empty:
 * the suspended `state` is not superseded by the new group's state --
 * it still decrypts application messages from its earlier epochs -- so
 * none of its secrets are the caller's to wipe yet.
 */
export async function reinitCreateNewGroup (
    state:ClientState,
    keyPackage:KeyPackage,
    privateKeyPackage:PrivateKeyPackage,
    memberKeyPackages:KeyPackage[],
    groupId:Uint8Array,
    cipherSuite:CiphersuiteName,
    extensions:Extension[],
    provider:CryptoProvider = defaultCryptoProvider,
    options:ResumptionOptions = {},
):Promise<CreateCommitResult> {
    const cs = await getCipherSuite(getCiphersuiteFromName(cipherSuite), provider)
    // the resumed group inherits the old group's configuration -- including
    // its AuthenticationService, which has no default worth guessing at
    const newGroup = await createGroup(
        groupId,
        keyPackage,
        privateKeyPackage,
        extensions,
        cs,
        state.clientConfig,
    )

    const addProposals:Proposal[] = memberKeyPackages.map((kp) => ({
        proposalType: 'add',
        add: { keyPackage: kp },
    }))

    const psk = makeResumptionPsk(state, 'reinit', cs)

    const resumptionPsk:Proposal = {
        proposalType: 'psk',
        psk: {
            preSharedKeyId: psk.id,
        },
    }

    const result = await createCommit(
        {
            state: newGroup,
            pskIndex: makePskIndex(state, {}),
            cipherSuite: cs,
        },
        {
            ratchetTreeExtension: options.ratchetTreeExtension,
            wireAsPublicMessage: options.wireAsPublicMessage,
            extraProposals: [...addProposals, resumptionPsk],
        },
    )

    return { ...result, consumed: [] }
}

export function makeResumptionPsk (
    state:ClientState,
    usage:ResumptionPSKUsageName,
    cs:CiphersuiteImpl,
):{ id:PreSharedKeyID; secret:Uint8Array } {
    const secret = state.keySchedule.resumptionPsk

    const pskNonce = cs.rng.randomBytes(cs.kdf.size)

    const psk = {
        pskEpoch: state.groupContext.epoch,
        pskGroupId: state.groupContext.groupId,
        psktype: 'resumption',
        pskNonce,
        usage,
    } as const

    return { id: psk, secret }
}

/**
 * Starts a subgroup of `state`'s group. `consumed` is always empty: the
 * group being branched from carries on, and `state` stays its live
 * state.
 */
export async function branchGroup (
    state:ClientState,
    keyPackage:KeyPackage,
    privateKeyPackage:PrivateKeyPackage,
    memberKeyPackages:KeyPackage[],
    newGroupId:Uint8Array,
    cs:CiphersuiteImpl,
    options:ResumptionOptions = {},
):Promise<CreateCommitResult> {
    const resumptionPsk = makeResumptionPsk(state, 'branch', cs)

    const pskSearch = makePskIndex(state, {})

    const newGroup = await createGroup(
        newGroupId,
        keyPackage,
        privateKeyPackage,
        state.groupContext.extensions,
        cs,
        state.clientConfig,
    )

    const addMemberProposals:ProposalAdd[] = memberKeyPackages.map((kp) => ({
        proposalType: 'add',
        add: {
            keyPackage: kp,
        },
    }))

    const branchPskProposal:ProposalPSK = {
        proposalType: 'psk',
        psk: {
            preSharedKeyId: resumptionPsk.id,
        },
    }

    const result = await createCommit(
        {
            state: newGroup,
            pskIndex: pskSearch,
            cipherSuite: cs,
        },
        {
            ratchetTreeExtension: options.ratchetTreeExtension,
            wireAsPublicMessage: options.wireAsPublicMessage,
            extraProposals: [...addMemberProposals, branchPskProposal],
        },
    )

    return { ...result, consumed: [] }
}

export async function joinGroupFromBranch (
    oldState:ClientState,
    welcome:Welcome,
    keyPackage:KeyPackage,
    privateKeyPackage:PrivateKeyPackage,
    ratchetTree:RatchetTree | undefined,
    cs:CiphersuiteImpl,
):Promise<ClientState> {
    const pskSearch = makePskIndex(oldState, {})

    return await joinGroup(
        welcome,
        keyPackage,
        privateKeyPackage,
        pskSearch,
        cs,
        ratchetTree,
        oldState,
        oldState.clientConfig,
        'branch',
    )
}

export async function joinGroupFromReinit (
    suspendedState:ClientState,
    welcome:Welcome,
    keyPackage:KeyPackage,
    privateKeyPackage:PrivateKeyPackage,
    ratchetTree:RatchetTree | undefined,
    provider:CryptoProvider = defaultCryptoProvider,
):Promise<ClientState> {
    const pskSearch = makePskIndex(suspendedState, {})
    if (suspendedState.groupActiveState.kind !== 'suspendedPendingReinit') { throw new UsageError('Cannot reinit because no init proposal found in last commit') }

    const cs = await getCipherSuite(
        getCiphersuiteFromName(suspendedState.groupActiveState.reinit.cipherSuite),
        provider,
    )

    return await joinGroup(
        welcome,
        keyPackage,
        privateKeyPackage,
        pskSearch,
        cs,
        ratchetTree,
        suspendedState,
        suspendedState.clientConfig,
        'reinit',
    )
}
