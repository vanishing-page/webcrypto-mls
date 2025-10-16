export async function repeatAsync<T> (fn: (input: T) => Promise<T>, initial: T, times: number): Promise<T> {
    let result = initial
    for (let i = 0; i < times; i++) {
        result = await fn(result)
    }
    return result
}
