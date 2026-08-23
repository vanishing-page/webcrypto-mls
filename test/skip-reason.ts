import { test } from '@substrate-system/tapzero'
import { skipReason } from './helpers/skip.js'

/**
 * The tokens `tapout` treats as evidence that a browser run failed. A
 * skip comment carrying any of them turns a green run red, so the
 * reason a ciphersuite was skipped has to be free of all three.
 */
const TAPOUT_FAILURE_TOKENS = ['Failed', 'FAIL', 'Error:']

function triggers (text:string):string[] {
    return TAPOUT_FAILURE_TOKENS.filter(token => text.includes(token))
}

test('skipReason keeps the reason a skip happened', t => {
    const message = 'Algorithm: Unrecognized name'
    t.ok(
        skipReason(new Error(message)).includes('Unrecognized name'),
        'the part that says what was unsupported survives'
    )
})

test('skipReason carries no token tapout reads as a failure', t => {
    // The message Chromium gives for an algorithm it does not
    // implement, which is what every browser-side skip is.
    const chromium = new Error(
        "Failed to execute 'importKey' on 'SubtleCrypto': " +
        'Algorithm: Unrecognized name'
    )
    chromium.name = 'NotSupportedError'

    t.deepEqual(
        triggers(chromium.message),
        ['Failed'],
        'the raw message is one tapout would fail the run on'
    )
    t.deepEqual(
        triggers(skipReason(chromium)),
        [],
        'and the reworded one is not'
    )
})

test('skipReason handles a nested error name in the message', t => {
    // Deserialization wraps the cause, so the message itself carries a
    // second `Name:` prefix -- `Error:` is a tapout trigger too.
    const wrapped = new Error(
        "DeserializeError: Failed to execute 'importKey' on 'SubtleCrypto'"
    )

    t.deepEqual(triggers(skipReason(wrapped)), [], 'no trigger survives')
    t.ok(
        skipReason(wrapped).includes('DeserializeError'),
        'and the wrapped error is still named'
    )
})

test('skipReason accepts something that is not an Error', t => {
    t.equal(skipReason('plain string'), 'plain string',
        'a thrown string is its own reason')
    t.equal(skipReason(null), 'null', 'and null does not throw')
})
