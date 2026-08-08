import type { Decoder } from './tls-decoder.js'
import type { Encoder } from './tls-encoder.js'
import { CodecError } from '../mls-error.js'

function assertUintRange (n:number, bits:number):void {
    const max = 2 ** bits - 1
    if (!Number.isInteger(n) || n < 0 || n > max) {
        throw new CodecError(
            `Cannot encode ${n} as an unsigned ${bits}-bit integer: ` +
            `must be an integer in range [0, ${max}]`,
        )
    }
}

export const encodeUint8:Encoder<number> = (n) => {
    assertUintRange(n, 8)
    const buffer = new ArrayBuffer(1)
    const view = new DataView(buffer)
    view.setUint8(0, n)
    return new Uint8Array(buffer)
}

export const decodeUint8:Decoder<number> = (b, offset) => {
    const value = b.at(offset)
    return value !== undefined ? [value, 1] : undefined
}

export const encodeUint16:Encoder<number> = (n) => {
    assertUintRange(n, 16)
    const buffer = new ArrayBuffer(2)
    const view = new DataView(buffer)
    view.setUint16(0, n)
    return new Uint8Array(buffer)
}

export const decodeUint16:Decoder<number> = (b, offset) => {
    const view = new DataView(b.buffer, b.byteOffset, b.byteLength)
    try {
        return [view.getUint16(offset), 2]
    } catch (_e) {
        return undefined
    }
}

export const encodeUint32:Encoder<number> = (n) => {
    assertUintRange(n, 32)
    const buffer = new ArrayBuffer(4)
    const view = new DataView(buffer)
    view.setUint32(0, n)
    return new Uint8Array(buffer)
}

export const decodeUint32:Decoder<number> = (b, offset) => {
    const view = new DataView(b.buffer, b.byteOffset, b.byteLength)
    try {
        return [view.getUint32(offset), 4]
    } catch (_e) {
        return undefined
    }
}

export const encodeUint64:Encoder<bigint> = (n) => {
    const buffer = new ArrayBuffer(8)
    const view = new DataView(buffer)
    view.setBigUint64(0, n)
    return new Uint8Array(buffer)
}

export const decodeUint64:Decoder<bigint> = (b, offset) => {
    const view = new DataView(b.buffer, b.byteOffset, b.byteLength)
    try {
        return [view.getBigUint64(offset), 8]
    } catch (_e) {
        return undefined
    }
}
