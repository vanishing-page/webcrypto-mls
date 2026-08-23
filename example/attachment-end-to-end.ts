/**
 * An encrypted attachment, end to end, against a real MLS group.
 *
 * The flow is the one an application implements: seal a file to the
 * group's current epoch, upload the ciphertext to an object store that
 * never sees a key, put the small `AttachmentRef` in the authenticated
 * data of an application message, and let the receiver read the object
 * back -- either the whole thing, or one byte range out of the middle.
 *
 * Two things this file is deliberate about. Imports use the published
 * subpath form, so the code here is exactly what a consumer writes;
 * nothing under `attachment/` is re-exported from the package root.
 * And every key comes from `state.keySchedule`, so a `ClientState` is
 * the only secret an application holds -- the `...ForGroup` wrappers
 * derive the per-object CEK and wipe it themselves.
 *
 * A reference is only readable in the epoch that produced it. Commit,
 * and the same object stops decrypting for everyone, the sender
 * included.
 */
import {
    createApplicationMessage,
    decodeMlsMessage,
    encodeMlsMessage,
    makePskIndex,
    processPrivateMessage
} from '@vanishing.page/webcrypto-mls'
import {
    type CiphersuiteImpl,
    type ClientConfig,
    type ClientState,
    type Credential,
    type PrivateMessage,
    type Proposal,
    createCommit,
    createGroup,
    defaultCapabilities,
    defaultClientConfig,
    defaultLifetime,
    emptyPskIndex,
    generateKeyPackage,
    joinGroup,
    unsafeAcceptAllAuthenticationService
} from '@vanishing.page/webcrypto-mls'
import {
    encryptAttachmentForGroup
} from '@vanishing.page/webcrypto-mls/attachment/writer'
import {
    decryptAttachmentStreamForGroup
} from '@vanishing.page/webcrypto-mls/attachment/reader'
import {
    openAttachmentRangeForGroup
} from '@vanishing.page/webcrypto-mls/attachment/range'
import {
    type AttachmentRef,
    refFromAuthData,
    refToAuthData
} from '@vanishing.page/webcrypto-mls/attachment/reference'

/**
 * The blob store the ciphertext is uploaded to. It holds opaque bytes
 * and answers HTTP Range requests over them; it is given no key and
 * learns nothing from what it stores.
 *
 * `getRange` takes the header value itself -- `bytes=START-END`,
 * inclusive at both ends, as RFC 9110 defines it -- because that is
 * what the range path's output turns into on the wire.
 */
export interface ObjectStore {
    put:(
        objectId:Uint8Array,
        body:ReadableStream<Uint8Array>
    ) => Promise<void>
    get:(objectId:Uint8Array) => ReadableStream<Uint8Array>
    getRange:(
        objectId:Uint8Array,
        rangeHeader:string
    ) => ReadableStream<Uint8Array>
    /** What a HEAD request would report. */
    size:(objectId:Uint8Array) => number
}

/** What `attachmentEndToEnd` saw as it ran. */
export interface AttachmentFlowResult {
    /** The file that was sealed. */
    plaintext:Uint8Array
    /** The caption the sender put in the application message. */
    sentCaption:string
    /** The reference the sender produced. */
    sentRef:AttachmentRef
    /** The caption the receiver decrypted. */
    caption:string
    /** The reference the receiver recovered from authenticated data. */
    ref:AttachmentRef
    /** The whole object, decrypted sequentially. */
    received:Uint8Array
    /** The plaintext range the receiver asked for. */
    rangeRequest:{ offset:number, length:number }
    /** That range, decrypted through the range path. */
    rangeBytes:Uint8Array
    /** The Range headers the range read actually sent. */
    httpRanges:string[]
    /** How many ciphertext octets the store holds. */
    storedLength:number
}

/**
 * A group to seal the attachment to. Two members, because the point of
 * a reference is that somebody else reads it: Alice creates the group,
 * commits Bob in, and Bob joins from the welcome. Both land in the
 * same epoch, which is what makes their derived CEKs agree.
 */
export async function createAttachmentGroup (
    cs:CiphersuiteImpl
):Promise<{ alice:ClientState, bob:ClientState }> {
    // The library's default config fails closed on credentials: it
    // refuses to guess whether one is genuine. An example has no
    // identity system, so accept-all is the honest answer here. A real
    // application replaces it with a check against a CA or a directory.
    const config:ClientConfig = {
        ...defaultClientConfig,
        authService: unsafeAcceptAllAuthenticationService
    }

    const aliceKeys = await generateKeyPackage(
        basic('alice'), defaultCapabilities(), defaultLifetime(), [], cs
    )
    const bobKeys = await generateKeyPackage(
        basic('bob'), defaultCapabilities(), defaultLifetime(), [], cs
    )

    let alice = await createGroup(
        new TextEncoder().encode('attachment-example'),
        aliceKeys.publicPackage,
        aliceKeys.privatePackage,
        [],
        cs,
        config
    )

    const addBob:Proposal = {
        proposalType: 'add',
        add: { keyPackage: bobKeys.publicPackage }
    }
    const commit = await createCommit(
        { state: alice, cipherSuite: cs },
        { extraProposals: [addBob] }
    )
    alice = commit.newState

    const bob = await joinGroup(
        commit.welcome!,
        bobKeys.publicPackage,
        bobKeys.privatePackage,
        emptyPskIndex,
        cs,
        alice.ratchetTree,
        undefined,
        config
    )

    return { alice, bob }
}

/**
 * Seal `plaintext`, upload it, and send the reference to the group.
 *
 * The CEK is derived from `state.keySchedule` and the objectId, and
 * `encryptAttachmentForGroup` wipes it before returning -- the caller
 * never holds key material. Uploading `.readable` rather than `.bytes`
 * keeps the whole ciphertext from having to be one buffer on its way
 * out; `.bytes` is the same octets if a buffer is what you want.
 *
 * The reference rides in the application message's authenticated data,
 * which the sender's signature covers but the message body does not
 * hide. That is the point: the delivery service can route on it, and a
 * receiver knows the sender vouched for it.
 */
export async function sendAttachment (
    state:ClientState,
    plaintext:Uint8Array,
    caption:string,
    store:ObjectStore,
    cs:CiphersuiteImpl
):Promise<{
    newState:ClientState,
    wire:Uint8Array,
    ref:AttachmentRef
}> {
    // Any unique octets will do. The objectId is not secret; it binds
    // the CEK to this one object, so reusing one across two files
    // would reuse a key.
    const objectId = new Uint8Array(16)
    globalThis.crypto.getRandomValues(objectId)

    const encrypted = await encryptAttachmentForGroup(
        state.keySchedule, objectId, plaintext, cs
    )
    await store.put(objectId, encrypted.readable)

    const { newState, privateMessage } = await createApplicationMessage(
        state,
        new TextEncoder().encode(caption),
        cs,
        refToAuthData(encrypted.reference)
    )

    const wire = encodeMlsMessage({
        privateMessage,
        wireformat: 'mls_private_message',
        version: 'mls10'
    })

    return { newState, wire, ref: encrypted.reference }
}

/**
 * Read an application message and stream the attachment it points at.
 *
 * The reference comes off the wire message's authenticated data.
 * `processPrivateMessage` is what verifies the sender's signature over
 * those bytes, so decode the reference but do not act on it until the
 * message has been processed.
 *
 * `decryptAttachmentStreamForGroup` owns the CEK it derives and zeroes
 * it when the stream ends, errors, or is cancelled. Read the stream to
 * the end or cancel its reader; walking away from it leaves the key in
 * memory.
 */
export async function receiveAttachment (
    state:ClientState,
    wire:Uint8Array,
    store:ObjectStore,
    cs:CiphersuiteImpl
):Promise<{
    newState:ClientState,
    caption:string,
    ref:AttachmentRef,
    plaintext:Uint8Array
}> {
    const privateMessage = decodePrivateMessage(wire)

    const result = await processPrivateMessage(
        state, privateMessage, makePskIndex(state, {}), cs
    )
    if (result.kind !== 'applicationMessage') {
        throw new Error('expected an application message')
    }

    const ref = refFromAuthData(privateMessage.authenticatedData)

    const plain = await decryptAttachmentStreamForGroup(
        state.keySchedule,
        ref,
        store.get(ref.objectId),
        cs
    )

    return {
        newState: result.newState,
        caption: new TextDecoder().decode(result.message),
        ref,
        plaintext: await drain(plain)
    }
}

/**
 * Read one plaintext range without downloading the whole object.
 *
 * `openAttachmentRangeForGroup` answers with the ciphertext ranges
 * that range needs: the header, the metadata for the epochs it
 * touches, and the segment blocks themselves. Fetch each one, then
 * hand `decrypt` one stream per range, in the same order and carrying
 * exactly those bytes. The ranges are not contiguous, so they cannot
 * be collapsed into a single request.
 *
 * The read owns the CEK it derived, so `close()` zeroes it, and that
 * makes the read single use: open a new one for the next seek.
 */
export async function receiveAttachmentRange (
    state:ClientState,
    ref:AttachmentRef,
    range:{ offset:number, length:number },
    store:ObjectStore,
    cs:CiphersuiteImpl
):Promise<{ bytes:Uint8Array, httpRanges:string[] }> {
    const read = await openAttachmentRangeForGroup(
        state.keySchedule, ref, range, cs
    )

    try {
        const httpRanges = read.ranges.map(r => (
            `bytes=${r.offset}-${r.offset + r.length - 1}`
        ))
        const streams = httpRanges.map(header => (
            store.getRange(ref.objectId, header)
        ))

        return { bytes: await drain(read.decrypt(streams)), httpRanges }
    } finally {
        read.close()
    }
}

/**
 * The whole flow wired together: build a group, send an attachment as
 * Alice, read it back as Bob twice -- once whole, once as a range --
 * and report what happened at each step.
 */
export async function attachmentEndToEnd (
    cs:CiphersuiteImpl
):Promise<AttachmentFlowResult> {
    const { alice, bob } = await createAttachmentGroup(cs)
    const store = memoryObjectStore()

    // Big enough to span several segments, so the range read below
    // fetches a few blocks out of the middle rather than the lot.
    const plaintext = new Uint8Array(200000)
    for (let i = 0; i < plaintext.length; i++) {
        plaintext[i] = (i * 7) & 0xff
    }

    const sentCaption = 'the quarterly numbers'
    const sent = await sendAttachment(
        alice, plaintext, sentCaption, store, cs
    )

    const got = await receiveAttachment(bob, sent.wire, store, cs)

    // A seek: one slice that straddles a segment boundary.
    const rangeRequest = { offset: 60000, length: 10000 }
    const ranged = await receiveAttachmentRange(
        got.newState, got.ref, rangeRequest, store, cs
    )

    return {
        plaintext,
        sentCaption,
        sentRef: sent.ref,
        caption: got.caption,
        ref: got.ref,
        received: got.plaintext,
        rangeRequest,
        rangeBytes: ranged.bytes,
        httpRanges: ranged.httpRanges,
        storedLength: store.size(sent.ref.objectId)
    }
}

/**
 * An object store that keeps its blobs in a Map. A real one is an HTTP
 * server, an S3 bucket, or a CDN -- anything that stores octets and
 * honours Range. None of them need a key.
 */
export function memoryObjectStore ():ObjectStore {
    const blobs = new Map<string, Uint8Array>()

    return {
        async put (objectId, body) {
            blobs.set(keyOf(objectId), await drain(body))
        },

        get (objectId) {
            return oneChunk(mustGet(blobs, objectId))
        },

        getRange (objectId, rangeHeader) {
            const bytes = mustGet(blobs, objectId)
            const match = (/^bytes=(\d+)-(\d+)$/).exec(rangeHeader)
            if (!match) throw new Error('unsupported Range header')

            // HTTP byte ranges are inclusive at both ends, so the last
            // octet asked for is part of the response.
            const start = Number(match[1])
            const end = Number(match[2])
            if (end < start || end >= bytes.length) {
                throw new Error('range not satisfiable')
            }

            return oneChunk(bytes.slice(start, end + 1))
        },

        size (objectId) {
            return mustGet(blobs, objectId).length
        }
    }
}

function basic (name:string):Credential {
    return {
        credentialType: 'basic',
        identity: new TextEncoder().encode(name)
    }
}

function decodePrivateMessage (wire:Uint8Array):PrivateMessage {
    const decoded = decodeMlsMessage(wire, 0)?.[0]
    if (!decoded || decoded.wireformat !== 'mls_private_message') {
        throw new Error('expected a private message')
    }
    return decoded.privateMessage
}

function keyOf (objectId:Uint8Array):string {
    return Array.from(objectId, b => b.toString(16).padStart(2, '0'))
        .join('')
}

function mustGet (
    blobs:Map<string, Uint8Array>,
    objectId:Uint8Array
):Uint8Array {
    const bytes = blobs.get(keyOf(objectId))
    if (!bytes) throw new Error('no such object')
    return bytes
}

function oneChunk (bytes:Uint8Array):ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
        start (controller) {
            controller.enqueue(bytes)
            controller.close()
        }
    })
}

async function drain (
    stream:ReadableStream<Uint8Array>
):Promise<Uint8Array> {
    const chunks:Uint8Array[] = []
    const reader = stream.getReader()
    for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) chunks.push(value)
    }

    const out = new Uint8Array(
        chunks.reduce((n, c) => n + c.length, 0)
    )
    let at = 0
    for (const chunk of chunks) {
        out.set(chunk, at)
        at += chunk.length
    }
    return out
}
