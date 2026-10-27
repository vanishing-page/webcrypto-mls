import type { ProposalOrRef } from './proposal-or-ref-type.js'
import type { SignatureSecretKey } from './crypto/signature.js'
import { bytesToBase64 } from './util/byte-array.js'

/**
 * The private keys behind this member's own pending Update proposals,
 * keyed by the base64 of each proposal's reference. A commit that
 * applies one of them installs its key; any commit drops the rest, since
 * a proposal reference names a proposal of one epoch only.
 *
 * Like `UnappliedProposals`, the record is keyed by a string a peer can
 * see, so it is read only through `Object.hasOwn` and keeps an ordinary
 * prototype.
 */
export type PendingUpdateKeys = Record<string, PendingUpdateKey>

export interface PendingUpdateKey {
    hpkePrivateKey:Uint8Array
    /**
     * Present when the Update's `LeafNodePatch` rotates the signature
     * key. The member keeps signing with its current key until a commit
     * applies the Update, since the tree holds the old leaf until then.
     */
    signaturePrivateKey?:SignatureSecretKey
}

export function addPendingUpdateKey (
    ref:Uint8Array,
    keys:PendingUpdateKeys | undefined,
    key:PendingUpdateKey,
):PendingUpdateKeys {
    return { ...keys, [bytesToBase64(ref)]: key }
}

/**
 * The pending key of the one Update, among a commit's proposals, that
 * this member proposed. A commit holds at most one Update per leaf, so
 * at most one reference can match.
 */
export function appliedPendingUpdateKey (
    keys:PendingUpdateKeys | undefined,
    proposals:ProposalOrRef[],
):PendingUpdateKey | undefined {
    if (keys === undefined) return undefined

    for (const p of proposals) {
        if (p.proposalOrRefType !== 'reference') continue
        const r = bytesToBase64(p.reference)
        if (Object.hasOwn(keys, r)) return keys[r]
    }

    return undefined
}

/**
 * The state with no pending Update keys, for every transition that
 * leaves the epoch. The dropped keys are not wiped: the caller still
 * holds the input state. They are reported through `consumed`.
 */
export function withoutPendingUpdateKeys<
    S extends { pendingUpdateKeys?:PendingUpdateKeys }
> (state:S):Omit<S, 'pendingUpdateKeys'> {
    const { pendingUpdateKeys: _dropped, ...rest } = state
    return rest
}
