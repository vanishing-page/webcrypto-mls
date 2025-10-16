export function updateArray<T> (tree: T[], index: number, t: T): T[] {
    return [...tree.slice(0, index), t, ...tree.slice(index + 1)]
}

export function arraysEqual<T> (a: T[], b: T[]): boolean {
    if (a.length !== b.length) return false
    return a.every((val, index) => val === b[index])
}
