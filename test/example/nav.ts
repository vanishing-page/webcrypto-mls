import { test } from '@substrate-system/tapzero'
import { navItems } from '../../example/nav.js'

test('navItems - dev base path (/), on the main demo', (t) => {
    const items = navItems('/', '/')
    t.equal(items.length, 3, 'renders three links')

    const [main, persistence, multiDevice] = items
    t.equal(main.label, 'Main demo', 'first link is Main demo')
    t.equal(main.href, '/', 'Main demo links to the base path')
    t.equal(main.active, true, 'Main demo is active on /')

    t.equal(persistence.label, 'Persistence', 'second link is Persistence')
    t.equal(persistence.href, '/persistence',
        'Persistence links to <base>/persistence')
    t.equal(persistence.active, false, 'Persistence is not active on /')

    t.equal(multiDevice.label, 'Multi-device', 'third link is Multi-device')
    t.equal(multiDevice.href, '/multi-device',
        'Multi-device links to <base>/multi-device')
    t.equal(multiDevice.active, false, 'Multi-device is not active on /')
})

test('navItems - dev base path (/), on the persistence demo', (t) => {
    const items = navItems('/persistence', '/')
    const [main, persistence, multiDevice] = items

    t.equal(main.active, false, 'Main demo is not active on /persistence')
    t.equal(persistence.active, true, 'Persistence is active on /persistence')
    t.equal(multiDevice.active, false,
        'Multi-device is not active on /persistence')
})

test('navItems - dev base path (/), on the multi-device demo', (t) => {
    const items = navItems('/multi-device', '/')
    const [main, persistence, multiDevice] = items

    t.equal(main.active, false, 'Main demo is not active on /multi-device')
    t.equal(persistence.active, false,
        'Persistence is not active on /multi-device')
    t.equal(multiDevice.active, true,
        'Multi-device is active on /multi-device')
})

test('navItems - exactly one item is active on each route', (t) => {
    const routes = ['/', '/persistence', '/multi-device']
    routes.forEach((route) => {
        const activeCount = navItems(route, '/')
            .filter((item) => item.active).length
        t.equal(activeCount, 1, `exactly one active item on ${route}`)
    })
})

test('navItems - GitHub Pages base path (/webcrypto-mls/)', (t) => {
    const items = navItems('/webcrypto-mls/', '/webcrypto-mls/')
    const [main, persistence, multiDevice] = items

    t.equal(main.href, '/webcrypto-mls/',
        'Main demo links to the Pages base path')
    t.equal(persistence.href, '/webcrypto-mls/persistence',
        'Persistence links to <base>/persistence')
    t.equal(multiDevice.href, '/webcrypto-mls/multi-device',
        'Multi-device links to <base>/multi-device')
    t.equal(main.active, true, 'Main demo is active on the Pages base path')

    const onPersistence = navItems('/webcrypto-mls/persistence',
        '/webcrypto-mls/')
    t.equal(onPersistence[1].active, true,
        'Persistence is active on /webcrypto-mls/persistence')
    t.equal(onPersistence[0].active, false,
        'Main demo is not active on /webcrypto-mls/persistence')

    const onMultiDevice = navItems('/webcrypto-mls/multi-device',
        '/webcrypto-mls/')
    t.equal(onMultiDevice[2].active, true,
        'Multi-device is active on /webcrypto-mls/multi-device')
    t.equal(onMultiDevice[0].active, false,
        'Main demo is not active on /webcrypto-mls/multi-device')
})
