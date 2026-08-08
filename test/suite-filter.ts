import { test } from '@substrate-system/tapzero'
import type { CiphersuiteName } from '../src/crypto/ciphersuite.js'
import { ciphersuites } from '../src/crypto/ciphersuite.js'
import {
    REPRESENTATIVE,
    selectSuites
} from './helpers/suite-filter.js'

const ALL = Object.keys(ciphersuites) as CiphersuiteName[]

test('an unset filter runs the whole matrix', t => {
    t.deepEqual(selectSuites(ALL, ''), ALL,
        'every ciphersuite, in the library\'s own order')
    t.deepEqual(selectSuites(ALL, '   '), ALL,
        'whitespace counts as unset')
    t.deepEqual(selectSuites(ALL, 'all'), ALL,
        'and `all` says so explicitly')
})

test('the fast filter runs the representative sample', t => {
    const chosen = selectSuites(ALL, 'fast')
    t.equal(chosen.length, REPRESENTATIVE.length,
        'one ciphersuite per entry in the sample')
    t.ok(chosen.every(name => REPRESENTATIVE.includes(name)),
        'and nothing outside the sample')
})

test('the representative sample is a subset of the matrix', t => {
    const outside = REPRESENTATIVE.filter(name => !ALL.includes(name))
    t.deepEqual(outside, [],
        'a renamed ciphersuite would strand the sample')
})

test('shards partition the matrix', t => {
    for (const count of [2, 3, 4, 5]) {
        const shards:CiphersuiteName[][] = []
        for (let i = 1; i <= count; i++) {
            shards.push(selectSuites(ALL, `shard:${i}/${count}`))
        }

        const flat = shards.flat()
        t.equal(flat.length, ALL.length,
            `${count} shards cover the matrix exactly once`)
        t.equal(new Set(flat).size, ALL.length,
            `${count} shards are disjoint`)
    }
})

test('shards stay balanced in size', t => {
    const sizes = [1, 2, 3, 4].map(i => {
        return selectSuites(ALL, `shard:${i}/4`).length
    })
    const spread = Math.max(...sizes) - Math.min(...sizes)
    t.ok(spread <= 1,
        `four shards differ by at most one ciphersuite, got ${sizes}`)
})

test('a filter can name ciphersuites', t => {
    const chosen = selectSuites(
        ALL,
        `${ALL[2]}, ${ALL[0]}`
    )
    t.deepEqual(chosen, [ALL[0], ALL[2]],
        'named ciphersuites come back in matrix order, not argument order')
})

test('a filter that would run nothing is an error', async t => {
    await t.throws(
        () => selectSuites(ALL, 'MLS_128_NOT_A_CIPHERSUITE'),
        /unknown ciphersuites/,
        'an unknown name fails instead of running an empty matrix')
    await t.throws(
        () => selectSuites(ALL, 'shard:0/4'),
        /out of range/,
        'shards are one-based')
    await t.throws(
        () => selectSuites(ALL, 'shard:5/4'),
        /out of range/,
        'and cannot exceed the shard count')
})
