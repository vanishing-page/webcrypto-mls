import { test } from '@substrate-system/tapzero'
import {
    isPersistencePath,
    isMultiDevicePath
} from '../../example/routing.js'

test('isPersistencePath - dev base path (/)', (t) => {
    t.equal(isPersistencePath('/persistence', '/'), true,
        'exact /persistence matches')
    t.equal(isPersistencePath('/persistence/', '/'), true,
        'trailing slash matches (hard refresh URL shape)')
    t.equal(isPersistencePath('/', '/'), false, 'root does not match')
    t.equal(isPersistencePath('/multi-device', '/'), false,
        'multi-device path does not match')
})

test('isPersistencePath - GitHub Pages base path (/webcrypto-mls/)', (t) => {
    t.equal(
        isPersistencePath('/webcrypto-mls/persistence', '/webcrypto-mls/'),
        true,
        'exact base + /persistence matches'
    )
    t.equal(
        isPersistencePath('/webcrypto-mls/persistence/', '/webcrypto-mls/'),
        true,
        'trailing slash matches'
    )
    t.equal(isPersistencePath('/webcrypto-mls/', '/webcrypto-mls/'), false,
        'base root does not match')
    t.equal(isPersistencePath('/persistence', '/webcrypto-mls/'), false,
        'a path without the base prefix does not match')
})

test('isPersistencePath - ignores query strings', (t) => {
    t.equal(isPersistencePath('/persistence?foo=bar', '/'), true,
        'query string on a persistence path still matches')
    t.equal(isPersistencePath('/?persistence=1', '/'), false,
        'a query string mentioning persistence does not cause a false match')
})

test('isMultiDevicePath - dev base path (/)', (t) => {
    t.equal(isMultiDevicePath('/multi-device', '/'), true,
        'exact /multi-device matches')
    t.equal(isMultiDevicePath('/multi-device/', '/'), true,
        'trailing slash matches (hard refresh URL shape)')
    t.equal(isMultiDevicePath('/', '/'), false, 'root does not match')
    t.equal(isMultiDevicePath('/persistence', '/'), false,
        'persistence path does not match')
})

test('isMultiDevicePath - GitHub Pages base path (/webcrypto-mls/)', (t) => {
    t.equal(
        isMultiDevicePath('/webcrypto-mls/multi-device', '/webcrypto-mls/'),
        true,
        'exact base + /multi-device matches'
    )
    t.equal(
        isMultiDevicePath('/webcrypto-mls/multi-device/', '/webcrypto-mls/'),
        true,
        'trailing slash matches'
    )
    t.equal(isMultiDevicePath('/webcrypto-mls/', '/webcrypto-mls/'), false,
        'base root does not match')
    t.equal(isMultiDevicePath('/multi-device', '/webcrypto-mls/'), false,
        'a path without the base prefix does not match')
})

test('isMultiDevicePath - ignores query strings', (t) => {
    t.equal(isMultiDevicePath('/multi-device?foo=bar', '/'), true,
        'query string on a multi-device path still matches')
    t.equal(isMultiDevicePath('/?multi-device=1', '/'), false,
        'a query string mentioning multi-device does not match')
})
