import {
    getCipherSuite,
    generateKeyPackage,
    createGroup,
    createCommit,
    createApplicationMessage,
    joinGroup,
    makePskIndex,
    processMessage,
    acceptAll,
    encodeMlsMessage,
    decodeMlsMessage,
    bytesToBase64,
    bytesToBase64url,
    defaultCapabilities,
    defaultLifetime,
    type CiphersuiteImpl,
    type ClientState,
    type KeyPackage,
    type ProcessMessageResult
} from '../../src/index.js'
import { base64ToBytes } from '../../src/util/byte-array.js'
import type { DemoUser } from '../../example-shared/demo-user.js'

/**
 * Every MLS operation the client performs. Nothing here reimplements
 * what the library already provides -- in particular the base64
 * helpers.
 */

export async function initCiphersuite ():Promise<CiphersuiteImpl> {
    return getCipherSuite()
}

/**
 * Exactly one key package and exactly one signature keypair, generated
 * non-extractable so its private bits can never leave the browser. The
 * `false` is ADR-001 in one argument.
 */
export async function createUser (
    name:string,
    cs:CiphersuiteImpl
):Promise<DemoUser> {
    const signatureKeyPair = await globalThis.crypto.subtle.generateKey(
        { name: 'Ed25519' },
        false,
        ['sign', 'verify']
    )

    const { publicPackage, privatePackage } = await generateKeyPackage(
        {
            credentialType: 'basic',
            identity: new TextEncoder().encode(name)
        },
        defaultCapabilities(),
        defaultLifetime(),
        [],
        cs,
        { signatureKeyPair: signatureKeyPair as CryptoKeyPair }
    )

    return {
        name,
        keyPackage: publicPackage,
        privateKeys: privatePackage
    }
}

/**
 * Identity on the wire is the signature public key, never the display
 * name. The name is not secret from the server, though: it is a basic
 * credential inside the key package, so it crosses the socket in the
 * clear on a `join-request` and again in the public Add that admits the
 * requester. Only the creator's name stays out of the server's reach,
 * since the creator's key package is never sent and the tree carrying
 * the name reaches joiners inside an encrypted Welcome.
 */
export function identityOf (keyPackage:KeyPackage):string {
    return bytesToBase64url(keyPackage.leafNode.signaturePublicKey)
}

/**
 * The group id is random and has nothing to do with the room id. The
 * room id is a URL people paste to each other; the group id is MLS
 * state. Deriving one from the other would tie a protocol identifier to
 * a routing one for no benefit.
 */
export async function createOwnGroup (
    user:DemoUser,
    cs:CiphersuiteImpl
):Promise<ClientState> {
    if (!user.keyPackage || !user.privateKeys) {
        throw new Error('user has no key package')
    }

    const groupId = cs.rng.randomBytes(32)

    return createGroup(
        groupId,
        user.keyPackage,
        user.privateKeys,
        [],
        cs
    )
}

export async function encryptMessage (
    state:ClientState,
    text:string,
    cs:CiphersuiteImpl
):Promise<{ newState:ClientState; payload:string }> {
    const result = await createApplicationMessage(
        state,
        new TextEncoder().encode(text),
        cs,
        new Uint8Array(0)
    )

    const bytes = encodeMlsMessage({
        wireformat: 'mls_private_message',
        version: 'mls10',
        privateMessage: result.privateMessage
    })

    return {
        newState: result.newState,
        payload: bytesToBase64(bytes)
    }
}

/**
 * A key package on the wire. Uses the same MLSMessage encoding as every
 * other payload rather than a bespoke format -- `mls_key_package` is a
 * wireformat the library already round-trips.
 */
export function encodeKeyPackageB64 (keyPackage:KeyPackage):string {
    return bytesToBase64(encodeMlsMessage({
        wireformat: 'mls_key_package',
        version: 'mls10',
        keyPackage
    }))
}

/**
 * Null rather than a throw, for both an undecodable payload and a
 * decodable one carrying something else: a join request arrives off a
 * socket, so it is untrusted, and the creator's pending list has to be
 * able to show that one entry is unreadable without failing the render.
 */
export function decodeKeyPackageB64 (payload:string):KeyPackage|null {
    const decoded = decodeMlsMessage(base64ToBytes(payload), 0)
    if (!decoded) return null
    const msg = decoded[0]
    return msg.wireformat === 'mls_key_package' ? msg.keyPackage : null
}

/**
 * Does this key package actually belong to the identity that sent it?
 *
 * A `join-request` carries an identity and a key package as two
 * separate fields, and the room stores whatever the socket puts in
 * both: it holds key packages as opaque strings and could not check
 * them if it wanted to. The creator is the only party that can, because
 * the creator is the only one that decodes them at all.
 *
 * Committing a request whose halves disagree adds a leaf that whoever
 * asked cannot open, addresses the Welcome to somebody who cannot read
 * it, and has the room record the claimant as admitted -- which is what
 * `mayWriteLog` reads to let an identity write to the log. The name
 * beside that dead leaf would be the key package owner's, who never
 * asked for anything.
 */
export function keyPackageBelongsTo (
    keyPackage:KeyPackage,
    identity:string
):boolean {
    return identityOf(keyPackage) === identity
}

/**
 * Join from a Welcome. The ratchet tree rides inside the Welcome
 * because the committer set `ratchetTreeExtension`, so it is not passed
 * separately here.
 */
export async function joinFromWelcome (
    payload:string,
    user:DemoUser,
    cs:CiphersuiteImpl
):Promise<ClientState> {
    if (!user.keyPackage || !user.privateKeys) {
        throw new Error('user has no key package')
    }

    const decoded = decodeMlsMessage(base64ToBytes(payload), 0)
    if (!decoded || decoded[0].wireformat !== 'mls_welcome') {
        throw new Error('not a welcome')
    }

    return joinGroup(
        decoded[0].welcome,
        user.keyPackage,
        user.privateKeys,
        makePskIndex(undefined, {}),
        cs
    )
}

/**
 * Commit an Add. Returns the new state plus the two payloads the room
 * needs, already encoded -- the caller sends them in a fixed order and
 * must not reorder them; see `approvals.ts`.
 *
 * `ratchetTreeExtension` is what puts the tree inside the Welcome, so
 * the joiner needs nothing else to build its own view of the group.
 */
export async function commitAdd (
    state:ClientState,
    keyPackage:KeyPackage,
    cs:CiphersuiteImpl
):Promise<{
    newState:ClientState
    commit:string
    welcome:string
}> {
    const result = await createCommit(
        { state, cipherSuite: cs },
        {
            extraProposals: [
                { proposalType: 'add', add: { keyPackage } }
            ],
            wireAsPublicMessage: true,
            ratchetTreeExtension: true
        }
    )

    // An Add always produces one. Its absence would mean the proposal
    // never made it into the commit, and sending the commit without a
    // Welcome would advance everyone past a joiner who can never catch
    // up.
    if (!result.welcome) {
        throw new Error('add commit produced no welcome')
    }

    return {
        newState: result.newState,
        commit: bytesToBase64(encodeMlsMessage(result.commit)),
        welcome: bytesToBase64(encodeMlsMessage({
            wireformat: 'mls_welcome',
            version: 'mls10',
            welcome: result.welcome
        }))
    }
}

/**
 * Commit a Remove. The target is a leaf index, not an identity: the
 * proposal names a position in the tree, so the caller resolves the
 * identity it holds through `leafIndexOf` first, against the tree it is
 * committing from rather than the one it last rendered.
 */
export async function commitRemove (
    state:ClientState,
    leafIndex:number,
    cs:CiphersuiteImpl
):Promise<{ newState:ClientState; commit:string }> {
    const result = await createCommit(
        { state, cipherSuite: cs },
        {
            extraProposals: [
                { proposalType: 'remove', remove: { removed: leafIndex } }
            ],
            wireAsPublicMessage: true,
            ratchetTreeExtension: true
        }
    )

    return {
        newState: result.newState,
        commit: bytesToBase64(encodeMlsMessage(result.commit))
    }
}

/**
 * Apply one log entry's payload to the group.
 *
 * A throw here is a real failure and the queue treats it as one, so the
 * two payloads that are not messages at all -- undecodable bytes, and a
 * key package that decodes into the wrong shape -- are refused rather
 * than returned as some empty result. Being removed is not one of
 * these: that commit processes correctly and the caller reads the
 * outcome off `newState.groupActiveState`.
 */
export async function processEntry (
    state:ClientState,
    payload:string,
    cs:CiphersuiteImpl
):Promise<ProcessMessageResult> {
    const decoded = decodeMlsMessage(base64ToBytes(payload), 0)
    if (!decoded) throw new Error('that entry does not decode')

    const msg = decoded[0]

    if (
        msg.wireformat !== 'mls_public_message' &&
        msg.wireformat !== 'mls_private_message'
    ) {
        throw new Error(`entry carries a ${msg.wireformat}`)
    }

    return processMessage(
        msg,
        state,
        makePskIndex(state, {}),
        acceptAll,
        cs
    )
}
