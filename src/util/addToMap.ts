export function addToMap<K, V> (map: Map<K, V>, k: K, v: V): Map<K, V> {
    const copy = new Map(map)
    copy.set(k, v)
    return copy
}
