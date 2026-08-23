/**
 * Single opaque error for every attachment integrity failure.
 * Callers must not be able to distinguish a commitment mismatch
 * from an AEAD or snapshot failure, so no detail is attached.
 */
export class AttachmentError extends Error {
    constructor () {
        super('attachment integrity failure')
        this.name = 'AttachmentError'
    }
}
