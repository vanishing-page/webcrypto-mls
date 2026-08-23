
/**
 * Create a ReadableStream from bytes, yielding chunks of specified size.
 */
export function chunked (
    bytes:Uint8Array,
    size:number,
):ReadableStream<Uint8Array> {
    let offset = 0
    return new ReadableStream({
        pull (controller) {
            if (offset >= bytes.length) {
                controller.close()
            } else {
                const chunk = bytes.slice(
                    offset, Math.min(offset + size, bytes.length),
                )
                offset += size
                controller.enqueue(chunk)
            }
        },
    })
}

/**
 * Drain a stream to bytes and collect emitted chunks.
 *
 * Pass `sink` when the stream is expected to error and the test needs
 * to know what it emitted before erroring. Chunks are pushed to `sink`
 * as they arrive, so the array is still readable from the catch block.
 * The returned `chunks` are only available on the success path, because
 * a throw discards the return value entirely.
 */
export async function drainStream (
    stream:ReadableStream<Uint8Array>,
    sink?:Uint8Array[],
):Promise<{
    chunks:Uint8Array[]
    total:Uint8Array
}> {
    // One accumulator, aliased to `sink` when the caller supplied one.
    // Two parallel arrays would invite an edit that pushes to one only.
    const chunks:Uint8Array[] = sink ?? []
    const reader = stream.getReader()
    try {
        let result = await reader.read()
        while (!result.done) {
            if (result.value) {
                chunks.push(result.value)
            }
            result = await reader.read()
        }
    } finally {
        reader.releaseLock()
    }

    const totalLen = chunks.reduce((sum, c) => sum + c.length, 0)
    const total = new Uint8Array(totalLen)
    let offset = 0
    for (const c of chunks) {
        total.set(c, offset)
        offset += c.length
    }
    return { chunks, total }
}

/**
 * Like `chunked`, but emits a zero-length chunk before every real
 * chunk and `trailingEmpties` of them after the last one.
 *
 * A `TransformStream` or socket adapter can legally enqueue an empty
 * `Uint8Array`, so a reader must not read that as data. The trailing
 * empties matter most: they are what a reader sees on the read that is
 * supposed to report `done`.
 */
export function chunkedWithEmpties (
    bytes:Uint8Array,
    size:number,
    trailingEmpties = 1,
):ReadableStream<Uint8Array> {
    let offset = 0
    let emptiesLeft = trailingEmpties
    return new ReadableStream({
        pull (controller) {
            if (offset >= bytes.length) {
                if (emptiesLeft > 0) {
                    emptiesLeft--
                    controller.enqueue(new Uint8Array(0))
                } else {
                    controller.close()
                }
                return
            }
            controller.enqueue(new Uint8Array(0))
            controller.enqueue(bytes.slice(
                offset, Math.min(offset + size, bytes.length),
            ))
            offset += size
        },
    })
}
