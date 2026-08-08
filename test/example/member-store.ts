import { test } from '@substrate-system/tapzero'
import {
    createMemberStore,
    type PersistedMember
} from '../../example-shared/persistence-storage.js'

/**
 * The smallest `indexedDB` stand-in that `createMemberStore` actually
 * uses: open (with a first-open upgrade), a readwrite transaction with
 * put/delete, a readonly getAll, and deleteDatabase. Records live in a
 * per-database-name map, which is what lets these tests observe whether
 * two stores are really talking to two different databases.
 *
 * Node has no `indexedDB` global, so installing this is what makes the
 * I/O half of the module testable here at all.
 */
function installFakeIndexedDB (
    // Which object stores each database ended up with. Passed in so a
    // test can read what the upgrade path created; the fake asks before
    // it creates, the way the real one does.
    stores:Map<string, Set<string>> = new Map()
):() => void {
    const dbs = new Map<string, Map<string, PersistedMember>>()

    function makeDb (
        records:Map<string, PersistedMember>,
        storeNames:Set<string>
    ) {
        return {
            objectStoreNames: {
                contains: (name:string) => storeNames.has(name)
            },
            createObjectStore (name:string) {
                storeNames.add(name)
            },
            transaction () {
                const tx:any = {
                    objectStore: () => ({
                        put (record:PersistedMember, key:string) {
                            records.set(key, record)
                        },
                        delete (key:string) {
                            records.delete(key)
                        },
                        getAll () {
                            const request:any = {}
                            queueMicrotask(() => {
                                request.result = [...records.values()]
                                request.onsuccess?.()
                            })
                            return request
                        }
                    })
                }
                queueMicrotask(() => tx.oncomplete?.())
                return tx
            }
        }
    }

    const fake = {
        open (name:string) {
            const request:any = {}
            queueMicrotask(() => {
                const isNew = !dbs.has(name)
                if (isNew) {
                    dbs.set(name, new Map())
                    stores.set(name, new Set())
                }
                request.result = makeDb(dbs.get(name)!, stores.get(name)!)
                if (isNew) request.onupgradeneeded?.()
                request.onsuccess?.()
            })
            return request
        },
        deleteDatabase (name:string) {
            const request:any = {}
            queueMicrotask(() => {
                dbs.delete(name)
                stores.delete(name)
                request.onsuccess?.()
            })
            return request
        }
    }

    const had = 'indexedDB' in globalThis
    const previous = (globalThis as any).indexedDB;
    (globalThis as any).indexedDB = fake

    return () => {
        if (had) (globalThis as any).indexedDB = previous
        else delete (globalThis as any).indexedDB
    }
}

function fakeState (name:string):any {
    return {
        clientConfig: { authService: () => {} },
        groupContext: { groupId: new Uint8Array([1, 2, 3]) },
        marker: name
    }
}

test('a store round trips a member through its own database', async (t) => {
    const uninstall = installFakeIndexedDB()

    try {
        const store = createMemberStore({ dbName: 'round-trip-db' })
        await store.saveMember('group1', 'Alice', fakeState('Alice'))

        const records = await store.loadAllMembers()
        t.equal(records.length, 1, 'the saved member comes back')
        t.equal(records[0].name, 'Alice', 'under the name it was saved with')
        t.equal(
            (records[0].state as any).clientConfig,
            undefined,
            'clientConfig is stripped before storage'
        )

        await store.deleteMember('group1', 'Alice')
        t.equal(
            (await store.loadAllMembers()).length,
            0,
            'deleteMember removes the record'
        )
    } finally {
        uninstall()
    }
})

test('two stores with different dbNames cannot see each other\'s records',
    async (t) => {
        const uninstall = installFakeIndexedDB()

        try {
            const one = createMemberStore({ dbName: 'demo-one' })
            const two = createMemberStore({ dbName: 'demo-two' })

            await one.saveMember('group1', 'Alice', fakeState('one'))
            await two.saveMember('group1', 'Bob', fakeState('two'))

            const fromOne = await one.loadAllMembers()
            const fromTwo = await two.loadAllMembers()

            t.equal(fromOne.length, 1, 'each store loads only its own records')
            t.equal(fromOne[0].name, 'Alice', 'the first store keeps Alice')
            t.equal(fromTwo.length, 1, 'each store loads only its own records')
            t.equal(fromTwo[0].name, 'Bob', 'the second store keeps Bob')
        } finally {
            uninstall()
        }
    }
)

test('deleteDatabase drops only that store\'s database', async (t) => {
    const uninstall = installFakeIndexedDB()

    try {
        const one = createMemberStore({ dbName: 'demo-one' })
        const two = createMemberStore({ dbName: 'demo-two' })

        await one.saveMember('group1', 'Alice', fakeState('one'))
        await two.saveMember('group1', 'Bob', fakeState('two'))

        await one.deleteDatabase()

        t.equal(
            (await one.loadAllMembers()).length,
            0,
            'the reset store is empty'
        )
        t.equal(
            (await two.loadAllMembers()).length,
            1,
            'the other demo\'s records survive'
        )
    } finally {
        uninstall()
    }
})

test('a store keys its records by group as well as name', async (t) => {
    const uninstall = installFakeIndexedDB()

    try {
        const store = createMemberStore({ dbName: 'key-db' })
        await store.saveMember('group1', 'Alice', fakeState('in-group1'))
        await store.saveMember('group2', 'Alice', fakeState('in-group2'))

        t.equal(
            (await store.loadAllMembers()).length,
            2,
            'the same name in two groups is two records'
        )

        await store.deleteMember('group1', 'Alice')
        const left = await store.loadAllMembers()

        t.equal(left.length, 1, 'deleting one group\'s record leaves the other')
        t.equal(
            (left[0].state as any).marker,
            'in-group2',
            'the surviving record is the one saved under the other group'
        )
    } finally {
        uninstall()
    }
})

test('creating a store does not open a database', (t) => {
    // No fake installed: Node has no `indexedDB`, so a factory that
    // opened eagerly would throw here. Demo modules build their store at
    // module scope, so construction has to stay lazy.
    t.ok(
        createMemberStore({ dbName: 'never-opened' }),
        'the factory returns a store without touching indexedDB'
    )
})

test('the shared upgrade path creates both object stores', async (t) => {
    // `createMemberStore` and `createSessionStore` share one `openDb`,
    // so opening either way has to leave the database with both stores.
    // A member store that created only `members` would leave the
    // session store with nowhere to write on a fresh database.
    const stores = new Map<string, Set<string>>()
    const uninstall = installFakeIndexedDB(stores)

    try {
        const store = createMemberStore({ dbName: 'both-stores-db' })
        await store.saveMember('group1', 'Alice', fakeState('Alice'))

        const created = stores.get('both-stores-db')
        t.deepEqual([...(created ?? [])].sort(), ['members', 'session'],
            'a first open creates the member store and the session store')
    } finally {
        uninstall()
    }
})
