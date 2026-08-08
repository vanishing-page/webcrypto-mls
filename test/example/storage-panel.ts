import { test } from '@substrate-system/tapzero'
import {
    PERSIST_MESSAGES,
    persistOutcome
} from '../../example-shared/storage-panel.js'

test('a request outcome is granted only when storage is persistent',
    (t) => {
        t.equal(
            persistOutcome('persistent'),
            'granted',
            'a persistent status is a granted request'
        )
        t.equal(
            persistOutcome('best-effort'),
            'denied',
            'best-effort means the browser did not grant persistence'
        )
        t.equal(
            persistOutcome('unsupported'),
            'denied',
            'a browser without the API cannot grant persistence'
        )
    }
)

test('every non-idle request state has a message', (t) => {
    const states = ['pending', 'granted', 'denied'] as const
    for (const state of states) {
        t.ok(
            PERSIST_MESSAGES[state].length > 0,
            `${state} is reported to the visitor`
        )
    }

    t.notEqual(
        PERSIST_MESSAGES.granted,
        PERSIST_MESSAGES.denied,
        'granted and denied read differently'
    )
})
