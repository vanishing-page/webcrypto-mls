import type { ContentTypeName } from './content-type.js'
import type { CiphersuiteImpl } from './crypto/ciphersuite.js'
import type { Kdf } from './crypto/kdf.js'
import { expandWithLabel, deriveTreeSecret } from './crypto/kdf.js'
import type { KeyRetentionConfig } from './key-retention-config.js'
import { InternalError, ValidationError } from './mls-error.js'
import type { ReuseGuard, SenderData } from './sender.js'
import type { NodeIndex } from './treemath.js'
import { nodeWidth, root, right, isLeaf, left, leafToNodeIndex, toLeafIndex, toNodeIndex } from './treemath.js'
import { updateArray } from './util/array.js'
import { repeatAsync } from './util/repeat.js'

export interface GenerationSecret {
    secret:Uint8Array
    generation:number
    unusedGenerations:Record<number, Uint8Array>
}

export interface SecretTreeNode {
    handshake:GenerationSecret
    application:GenerationSecret
}

export type SecretTree = (SecretTreeNode | undefined)[]

export interface ConsumeRatchetResult {
    nonce:Uint8Array
    reuseGuard:ReuseGuard
    key:Uint8Array
    generation:number
    newTree:SecretTree
}

function scaffoldSecretTree (leafWidth:number, encryptionSecret:Uint8Array, kdf:Kdf):Promise<Uint8Array[]> {
    const tree = new Array<Uint8Array>(nodeWidth(leafWidth))
    const rootIndex = root(leafWidth)

    const parentInhabited = updateArray(tree, rootIndex, encryptionSecret)
    return deriveChildren(parentInhabited, rootIndex, kdf)
}

export async function createSecretTree (leafWidth:number, encryptionSecret:Uint8Array, kdf:Kdf):Promise<SecretTree> {
    const tree = await scaffoldSecretTree(leafWidth, encryptionSecret, kdf)

    // Internal (non-leaf) node indices in `tree` only ever hold an
    // intermediate secret used to derive their children (see
    // deriveChildren); nothing in this codebase ever ratchets a message
    // using a non-leaf index (see message-protection.ts, which always
    // indexes via leafToNodeIndex). Deriving and retaining ratchet roots
    // for those indices would be unused key material, so they're left
    // undefined rather than wastefully retained.
    return await Promise.all(
        tree.map(async (secret, index) => {
            if (!isLeaf(toNodeIndex(index))) return undefined

            const application = await createRatchetRoot(secret, 'application', kdf)
            const handshake = await createRatchetRoot(secret, 'handshake', kdf)

            return { handshake, application }
        }),
    )
}

/**
 * Returns a copy of `tree` with every leaf's handshake ratchet secret
 * replaced with an empty placeholder. Used when snapshotting a superseded
 * epoch's SecretTree for historical receiver data: a commit/proposal from
 * a former epoch is always rejected regardless of whether it can be
 * decrypted (see processPrivateMessage), so retaining a usable handshake
 * ratchet for old epochs would be retained key material with no
 * forward-secrecy benefit.
 *
 * This does NOT mutate the input tree or its buffers -- `ClientState` is
 * functional and node objects are shared across state versions (see
 * `updateArray`), so the caller may still hold a live reference to the
 * `ClientState` this tree came from. Zeroizing in place here would corrupt
 * that still-live state's handshake ratchets out from under it. Callers
 * that can prove the source tree is being discarded (no other reference
 * remains) should call `zeroHandshakeRatchets` on it explicitly to reclaim
 * the forward-secrecy benefit.
 */
export function stripHandshakeRatchets (tree:SecretTree):SecretTree {
    return tree.map((node) => {
        if (node === undefined) return undefined

        return {
            application: node.application,
            handshake: { secret: new Uint8Array(0), generation: node.handshake.generation, unusedGenerations: {} },
        }
    })
}

/**
 * Zeroizes every leaf's handshake ratchet secret (current and unused
 * generations) in place. Only call this on a tree that is provably no
 * longer referenced by any live `ClientState` -- see `stripHandshakeRatchets`.
 */
export function zeroHandshakeRatchets (tree:SecretTree):void {
    for (const node of tree) {
        if (node === undefined) continue

        node.handshake.secret.fill(0)
        for (const secret of Object.values(node.handshake.unusedGenerations)) secret.fill(0)
    }
}

async function deriveChildren (tree:Uint8Array[], nodeIndex:NodeIndex, kdf:Kdf):Promise<Uint8Array[]> {
    if (isLeaf(nodeIndex)) return tree
    const l = left(nodeIndex)

    const r = right(nodeIndex)

    const parentSecret = tree[nodeIndex]
    if (parentSecret === undefined) throw new InternalError('Bad node index for secret tree')
    const leftSecret = await expandWithLabel(parentSecret, 'tree', new TextEncoder().encode('left'), kdf.size, kdf)

    const rightSecret = await expandWithLabel(parentSecret, 'tree', new TextEncoder().encode('right'), kdf.size, kdf)

    const currentTree = updateArray(updateArray(tree, l, leftSecret), r, rightSecret)

    return deriveChildren(await deriveChildren(currentTree, l, kdf), r, kdf)
}

export async function deriveNonce (secret:Uint8Array, generation:number, cs:CiphersuiteImpl):Promise<Uint8Array> {
    return await deriveTreeSecret(secret, 'nonce', generation, cs.hpke.nonceLength, cs.kdf)
}

export async function deriveKey (secret:Uint8Array, generation:number, cs:CiphersuiteImpl):Promise<Uint8Array> {
    return await deriveTreeSecret(secret, 'key', generation, cs.hpke.keyLength, cs.kdf)
}

export async function ratchetUntil (
    current:GenerationSecret,
    desiredGen:number,
    config:KeyRetentionConfig,
    kdf:Kdf,
):Promise<GenerationSecret> {
    const generationDifference = desiredGen - current.generation

    if (generationDifference > config.maximumForwardRatchetSteps) {
        throw new ValidationError('Desired generation too far in the future')
    }

    return await repeatAsync(
        async (s) => {
            const nextSecret = await deriveTreeSecret(s.secret, 'secret', s.generation, kdf.size, kdf)
            return {
                secret: nextSecret,
                generation: s.generation + 1,
                unusedGenerations: updateUnusedGenerations(s, config.retainKeysForGenerations),
            }
        },
        current,
        generationDifference,
    )
}

function updateUnusedGenerations (s:GenerationSecret, retainGenerationsMax:number):Record<number, Uint8Array> {
    const withNew = { ...s.unusedGenerations, [s.generation]: s.secret }

    const generations = Object.keys(withNew)

    const result =
        generations.length >= retainGenerationsMax ? removeOldGenerations(withNew, retainGenerationsMax) : withNew

    return result
}

/**
 * Returns the most recent `max` generations of `historicalReceiverData`,
 * dropping the rest.
 *
 * Dropped secrets are released to the garbage collector rather than
 * zeroized: every buffer in this record was ratcheted out of a secret a
 * prior `GenerationSecret` still holds, and `ClientState` is functional,
 * so the caller may still be using the state those buffers came from.
 * Wiping them here corrupted that live state (see security-audit.md C1).
 *
 * A `max` of 0 or less means "retain nothing". It needs its own branch:
 * `slice(-0)` is `slice(0)`, which returns the whole array, so without
 * the guard the setting retained every generation forever (see
 * security-audit.md H1). `removeOldHistoricalReceiverData` in
 * `client-state.ts` has the same guard.
 */
function removeOldGenerations (
    historicalReceiverData:Record<number, Uint8Array>,
    max:number,
):Record<number, Uint8Array> {
    if (max <= 0) return {}

    const sortedGenerations = Object.keys(historicalReceiverData)
        .map(Number)
        .sort((a, b) => (a < b ? -1 : 1))

    const kept = sortedGenerations.slice(-max)

    return Object.fromEntries(
        kept.map((generation) => [generation, historicalReceiverData[generation]!]),
    )
}

export async function derivePrivateMessageNonce (
    secret:Uint8Array,
    generation:number,
    reuseGuard:Uint8Array,
    cs:CiphersuiteImpl,
):Promise<Uint8Array> {
    const nonce = await deriveNonce(secret, generation, cs)

    if (nonce.length >= 4 && reuseGuard.length >= 4) {
        for (let i = 0; i < 4; i++) {
            nonce[i]! ^= reuseGuard[i]!
        }
    } else throw new ValidationError('Reuse guard or nonce incorrect length')

    return nonce
}

export async function ratchetToGeneration (
    tree:SecretTree,
    senderData:SenderData,
    contentType:ContentTypeName,
    config:KeyRetentionConfig,
    cs:CiphersuiteImpl,
):Promise<ConsumeRatchetResult> {
    const index = leafToNodeIndex(toLeafIndex(senderData.leafIndex))
    const node = tree[index]
    if (node === undefined) {
        throw new InternalError('Bad node index for secret tree')
    }

    const ratchet = ratchetForContentType(node, contentType)

    if (ratchet.generation > senderData.generation) {
        const desired = ratchet.unusedGenerations[senderData.generation]

        if (desired !== undefined) {
            const { [senderData.generation]: _, ...removedDesiredGen } = ratchet.unusedGenerations
            const ratchetState = { ...ratchet, unusedGenerations: removedDesiredGen }

            return await createRatchetResultWithSecret(
                node,
                index,
                desired,
                senderData.generation,
                senderData.reuseGuard,
                tree,
                contentType,
                cs,
                ratchetState,
                // `desired` belongs to the input tree's unusedGenerations
                false,
            )
        }

        throw new ValidationError('Desired gen in the past')
    }

    const currentSecret = await ratchetUntil(
        ratchetForContentType(node, contentType),
        senderData.generation,
        config,
        cs.kdf,
    )

    // ratchetUntil returns its input unchanged when there is nothing to
    // ratchet past, so only a forward step produces a secret this call
    // allocated and therefore owns
    const ownsSecret = senderData.generation > ratchet.generation

    return createRatchetResult(
        node,
        index,
        currentSecret,
        senderData.reuseGuard,
        tree,
        contentType,
        cs,
        ownsSecret,
    )
}

export async function consumeRatchet (
    tree:SecretTree,
    index:number,
    contentType:ContentTypeName,
    cs:CiphersuiteImpl,
):Promise<ConsumeRatchetResult> {
    const node = tree[index]
    if (node === undefined) throw new InternalError('Bad node index for secret tree')

    const currentSecret = ratchetForContentType(node, contentType)
    const reuseGuard = cs.rng.randomBytes(4) as ReuseGuard

    // the secret being consumed here is the input tree's live node secret,
    // which the caller's ClientState still references
    return createRatchetResult(node, index, currentSecret, reuseGuard, tree, contentType, cs, false)
}

/**
 * `ownsSecret` says whether `currentSecret.secret` was allocated by this
 * call chain. Only then may it be zeroized -- see
 * `createRatchetResultWithSecret`.
 */
async function createRatchetResult (
    node:SecretTreeNode,
    index:number,
    currentSecret:GenerationSecret,
    reuseGuard:ReuseGuard,
    tree:SecretTree,
    contentType:ContentTypeName,
    cs:CiphersuiteImpl,
    ownsSecret:boolean,
):Promise<ConsumeRatchetResult> {
    const nextSecret = await deriveTreeSecret(
        currentSecret.secret,
        'secret',
        currentSecret.generation,
        cs.kdf.size,
        cs.kdf,
    )

    const ratchetState = { ...currentSecret, secret: nextSecret, generation: currentSecret.generation + 1 }

    return await createRatchetResultWithSecret(
        node,
        index,
        currentSecret.secret,
        currentSecret.generation,
        reuseGuard,
        tree,
        contentType,
        cs,
        ratchetState,
        ownsSecret,
    )
}

/**
 * `ownsSecret` says whether `secret` was allocated by this call chain.
 *
 * A ratchet secret that came in with `tree` -- the node's live current
 * secret, or one of its retained out-of-order generations -- is still
 * referenced by the caller's `ClientState`, because `ClientState` is
 * functional and every operation returns a new state beside the old one.
 * Zeroizing such a buffer left that live state ratcheting from an
 * all-zero secret with its generation counter unchanged, so a send from
 * it derived its AEAD key from a constant (security-audit.md C1). Only a
 * secret this call derived itself is safe to wipe.
 */
async function createRatchetResultWithSecret (
    node:SecretTreeNode,
    index:number,
    secret:Uint8Array,
    generation:number,
    reuseGuard:ReuseGuard,
    tree:SecretTree,
    contentType:ContentTypeName,
    cs:CiphersuiteImpl,
    ratchetState:GenerationSecret,
    ownsSecret:boolean,
):Promise<ConsumeRatchetResult> {
    const { nonce, key } = await createKeyAndNonce(secret, generation, reuseGuard, cs)

    if (ownsSecret) secret.fill(0)

    const newNode =
        contentType === 'application' ? { ...node, application: ratchetState } : { ...node, handshake: ratchetState }

    const newTree = updateArray(tree, index, newNode)

    return {
        generation,
        reuseGuard,
        nonce,
        key,
        newTree,
    }
}

async function createKeyAndNonce (secret:Uint8Array, generation:number, reuseGuard:ReuseGuard, cs:CiphersuiteImpl) {
    const key = await deriveKey(secret, generation, cs)
    const nonce = await derivePrivateMessageNonce(secret, generation, reuseGuard, cs)
    return { nonce, key }
}

function ratchetForContentType (node:SecretTreeNode, contentType:ContentTypeName):GenerationSecret {
    switch (contentType) {
        case 'application':
            return node.application
        case 'proposal':
            return node.handshake
        case 'commit':
            return node.handshake
    }
}

async function createRatchetRoot (node:Uint8Array, label:string, kdf:Kdf) {
    const secret = await expandWithLabel(node, label, new Uint8Array(), kdf.size, kdf)
    return { secret, generation: 0, unusedGenerations: {} }
}
