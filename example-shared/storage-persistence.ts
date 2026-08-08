export type StorageStatus = 'unsupported' | 'best-effort' | 'persistent'

export function storageStatusLabel (status:StorageStatus):string {
    switch (status) {
        case 'persistent':
            return 'Storage: persistent'
        case 'best-effort':
            return 'Storage: best-effort'
        case 'unsupported':
            return 'Storage: unavailable'
    }
}

function storageManager ():StorageManager | null {
    if (typeof navigator === 'undefined') return null
    return navigator.storage ?? null
}

export async function checkPersisted ():Promise<StorageStatus> {
    const storage = storageManager()
    if (!storage || typeof storage.persisted !== 'function') {
        return 'unsupported'
    }

    return (await storage.persisted()) ? 'persistent' : 'best-effort'
}

export async function requestPersistentStorage ():Promise<StorageStatus> {
    const storage = storageManager()

    if (!storage || typeof storage.persist !== 'function') {
        return 'unsupported'
    }

    // `persist()` rejects in some browsers instead of resolving false.
    try {
        return (await storage.persist()) ? 'persistent' : 'best-effort'
    } catch (_err) {
        return 'best-effort'
    }
}
