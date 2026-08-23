import { test } from '@substrate-system/tapzero'
import { toolchainOutcome } from '../scripts/interop-toolchain.js'

test('a present toolchain runs the harness either way', async t => {
    t.equal(
        toolchainOutcome(true, undefined).action,
        'run',
        'toolchain present, CI unset: run'
    )
    t.equal(
        toolchainOutcome(true, '1').action,
        'run',
        'toolchain present, CI set: run'
    )
    t.equal(
        toolchainOutcome(true, '1').exitCode,
        0,
        'a run outcome exits zero'
    )
})

test('a missing toolchain under CI fails the job', async t => {
    const outcome = toolchainOutcome(false, '1')
    t.equal(outcome.action, 'fail', 'CI set: fail rather than skip')
    t.ok(outcome.exitCode !== 0, 'the failure exit code is non-zero')
    t.ok(
        outcome.message.includes('swift'),
        'the failure message names the missing toolchain'
    )
    t.equal(
        toolchainOutcome(false, 'true').action,
        'fail',
        'the usual CI=true from GitHub Actions also fails'
    )
})

test('a missing toolchain off CI skips', async t => {
    const outcome = toolchainOutcome(false, undefined)
    t.equal(outcome.action, 'skip', 'CI unset: skip')
    t.equal(outcome.exitCode, 0, 'a skip exits zero')
    t.ok(
        outcome.message.includes('skipped'),
        'the skip message says the run was skipped'
    )
})

test('an empty CI value counts as unset', async t => {
    // `CI=` in the environment is how a shell spells "not on CI", and a
    // truthiness check on the variable already reads it that way, so
    // the decision has to agree or the two disagree about the same run.
    t.equal(
        toolchainOutcome(false, '').action,
        'skip',
        'CI set to the empty string skips'
    )
})
