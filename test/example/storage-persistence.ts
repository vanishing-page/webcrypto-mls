import { test } from '@substrate-system/tapzero'
import {
    storageStatusLabel,
    checkPersisted,
    requestPersistentStorage
} from '../../example-shared/storage-persistence.js'

function setNavigatorStorage (storage:unknown):void {
    Object.defineProperty(globalThis, 'navigator', {
        value: storage === undefined ? {} : { storage },
        configurable: true
    })
}

test('storageStatusLabel - describes each status', (t) => {
    t.equal(storageStatusLabel('persistent'), 'Storage: persistent',
        'persistent status')
    t.equal(storageStatusLabel('best-effort'), 'Storage: best-effort',
        'best-effort status')
    t.equal(storageStatusLabel('unsupported'), 'Storage: unavailable',
        'unsupported status')
})

test('checkPersisted - reports persistent when already granted', async (t) => {
    setNavigatorStorage({ persisted: async () => true })
    t.equal(await checkPersisted(), 'persistent',
        'reflects navigator.storage.persisted() === true')
})

test('checkPersisted - reports best-effort when not granted', async (t) => {
    setNavigatorStorage({ persisted: async () => false })
    t.equal(await checkPersisted(), 'best-effort',
        'reflects navigator.storage.persisted() === false')
})

test('checkPersisted - reports unsupported without the StorageManager API',
    async (t) => {
        setNavigatorStorage(undefined)
        t.equal(await checkPersisted(), 'unsupported',
            'no navigator.storage at all')

        setNavigatorStorage({})
        t.equal(await checkPersisted(), 'unsupported',
            'navigator.storage present but no persisted method')
    }
)

test('requestPersistentStorage - reports the granted result', async (t) => {
    setNavigatorStorage({ persist: async () => true })
    t.equal(await requestPersistentStorage(), 'persistent',
        'granted request reports persistent')
})

test('requestPersistentStorage - reports a denied result, not an error',
    async (t) => {
        setNavigatorStorage({ persist: async () => false })
        t.equal(await requestPersistentStorage(), 'best-effort',
            'denied request reports best-effort, does not throw')
    }
)

test('requestPersistentStorage - reports unsupported without the API',
    async (t) => {
        setNavigatorStorage(undefined)
        t.equal(await requestPersistentStorage(), 'unsupported',
            'no navigator.storage at all')

        setNavigatorStorage({})
        t.equal(await requestPersistentStorage(), 'unsupported',
            'navigator.storage present but no persist method')
    }
)
