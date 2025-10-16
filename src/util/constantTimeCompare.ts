export function constantTimeEqual (a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false

    let result = 0
    for (let i = 0; i < a.length; i++) {
        result |= (a[i] as number) ^ (b[i] as number)
    }
    return result === 0
}
