import type { ClientState } from './client-state.js'
import type { GenerationSecret, SecretTree } from './secret-tree.js'

/**
 * The secret buffers `before` references and `after` does not: what an
 * operation that turned `before` into `after` hands back as `consumed`.
 *
 * Computed as a difference rather than recorded where each secret is
 * dropped, so the rule holds exactly whatever path the operation took:
 * a buffer `after` shares with `before` (through `updateArray`, or a
 * secret moved into historical receiver data) is never listed, and a
 * buffer the call allocated is never listed because `before` cannot
 * reference it. Nothing here wipes anything -- the caller still holds
 * `before`, and wipes the list once `after` is persisted.
 */
export function consumedSecrets (
    before:ClientState,
    after:ClientState,
):Uint8Array[] {
    if (before === after) return []
    const kept = stateSecrets(after)
    return [...stateSecrets(before)].filter((b) => !kept.has(b))
}

/**
 * Every secret buffer a state references. A non-extractable `CryptoKey`
 * is not a buffer, and an empty buffer holds no secret.
 */
function stateSecrets (state:ClientState):Set<Uint8Array> {
    const out = new Set<Uint8Array>()
    const add = (b:Uint8Array) => { if (b.length > 0) out.add(b) }

    for (const b of Object.values(state.keySchedule)) add(b)
    addSecretTree(state.secretTree, add)
    for (const b of Object.values(state.privatePath.privateKeys)) add(b)
    for (const pending of Object.values(state.pendingUpdateKeys ?? {})) {
        add(pending.hpkePrivateKey)
        if (pending.signaturePrivateKey instanceof Uint8Array) {
            add(pending.signaturePrivateKey)
        }
    }
    if (state.signaturePrivateKey instanceof Uint8Array) {
        add(state.signaturePrivateKey)
    }
    for (const epoch of state.historicalReceiverData.values()) {
        add(epoch.resumptionPsk)
        add(epoch.senderDataSecret)
        addSecretTree(epoch.secretTree, add)
    }

    return out
}

function addSecretTree (
    tree:SecretTree,
    add:(b:Uint8Array) => void,
):void {
    for (const node of tree) {
        if (node === undefined) continue
        addRatchet(node.application, add)
        addRatchet(node.handshake, add)
    }
}

function addRatchet (
    ratchet:GenerationSecret,
    add:(b:Uint8Array) => void,
):void {
    add(ratchet.secret)
    for (const retained of Object.values(ratchet.unusedGenerations)) {
        add(retained.key)
        add(retained.nonce)
    }
}
