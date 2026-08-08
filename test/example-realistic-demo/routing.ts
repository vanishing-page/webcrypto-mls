import { test } from '@substrate-system/tapzero'
import { routeFromPath, roomUrl } from
    '../../example-realistic-demo/client/routing.js'

test('routeFromPath - the root path is the setup view', t => {
    t.deepEqual(
        routeFromPath('/'),
        { kind: 'setup' },
        'a bare slash is setup'
    )
    t.deepEqual(
        routeFromPath(''),
        { kind: 'setup' },
        'an empty path is setup'
    )
})

test('routeFromPath - a valid room id routes to that room', t => {
    t.deepEqual(
        routeFromPath('/abcdeFGH12'),
        { kind: 'room', roomId: 'abcdeFGH12' },
        'a ten character id is a room'
    )
    t.deepEqual(
        routeFromPath('/abcdeFGH12/'),
        { kind: 'room', roomId: 'abcdeFGH12' },
        'a trailing slash does not change the id'
    )
    t.deepEqual(
        routeFromPath('/_-abcdEF12'),
        { kind: 'room', roomId: '_-abcdEF12' },
        'the nanoid alphabet includes _ and -'
    )
})

test('routeFromPath - an invalid id is gone, never a room', t => {
    t.deepEqual(
        routeFromPath('/short'),
        { kind: 'gone' },
        'too short is gone'
    )
    t.deepEqual(
        routeFromPath('/abcdeFGH12345'),
        { kind: 'gone' },
        'too long is gone'
    )
    t.deepEqual(
        routeFromPath('/abcde.GH12'),
        { kind: 'gone' },
        'a character outside the alphabet is gone'
    )
    t.deepEqual(
        routeFromPath('/abcdeFGH12/more'),
        { kind: 'gone' },
        'a nested path is gone rather than its first segment'
    )
    t.deepEqual(
        routeFromPath('/api'),
        { kind: 'gone' },
        'a reserved word is gone'
    )
})

test('routeFromPath - query and hash are not part of the id', t => {
    t.deepEqual(
        routeFromPath('/abcdeFGH12?ref=x'),
        { kind: 'room', roomId: 'abcdeFGH12' },
        'a query string is stripped before validating'
    )
    t.deepEqual(
        routeFromPath('/abcdeFGH12#top'),
        { kind: 'room', roomId: 'abcdeFGH12' },
        'a hash is stripped before validating'
    )
    t.deepEqual(
        routeFromPath('/?ref=x'),
        { kind: 'setup' },
        'a query string on the root is still setup'
    )
})

test('roomUrl - the absolute URL people paste to each other', t => {
    t.equal(
        roomUrl('https://demo.test', 'abcdeFGH12'),
        'https://demo.test/abcdeFGH12',
        'origin and id joined by one slash'
    )
    t.equal(
        roomUrl('https://demo.test/', 'abcdeFGH12'),
        'https://demo.test/abcdeFGH12',
        'an origin with a trailing slash does not double it'
    )
})
