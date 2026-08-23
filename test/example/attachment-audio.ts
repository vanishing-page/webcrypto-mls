import { test } from '@substrate-system/tapzero'
import { AttachmentError } from '../../src/attachment/error.js'
import {
    SAMPLE_RATE,
    makeTonePcm,
    bytesToPcm,
    chunkStartSeconds
} from '../../example/attachment-audio.js'

test('a second of tone is a second on the playback clock', (t) => {
    // The two ends of the same rate: makeTonePcm lays down samples at
    // SAMPLE_RATE, chunkStartSeconds reads them back off it. One
    // second of PCM has to start the next chunk at one second.
    const pcm = makeTonePcm(1)
    t.equal(chunkStartSeconds(pcm.length * 4), 1,
        'should place the chunk after a second of tone at 1s')
})

test('makeTonePcm generates correct sample count', (t) => {
    const pcm = makeTonePcm(2)
    const expectedSamples = 2 * SAMPLE_RATE
    t.equal(pcm.length, expectedSamples,
        `makeTonePcm(2) has exactly ${expectedSamples} samples`)
})

test('makeTonePcm generates samples within [-1, 1]', (t) => {
    const pcm = makeTonePcm(2)
    let allInRange = true
    for (let i = 0; i < pcm.length; i++) {
        if (pcm[i] < -1 || pcm[i] > 1) {
            allInRange = false
            break
        }
    }
    t.equal(allInRange, true, 'all samples are within [-1, 1]')
})

test('makeTonePcm generates non-trivial RMS (not silence)', (t) => {
    const pcm = makeTonePcm(2)
    let sumSquares = 0
    for (let i = 0; i < pcm.length; i++) {
        sumSquares += pcm[i] * pcm[i]
    }
    const rms = Math.sqrt(sumSquares / pcm.length)
    t.ok(rms > 0.1, `RMS is ${rms}, indicating non-zero signal`)
})

test('makeTonePcm peak approaches expected amplitude', (t) => {
    const pcm = makeTonePcm(2)
    let maxAbs = 0
    for (let i = 0; i < pcm.length; i++) {
        maxAbs = Math.max(maxAbs, Math.abs(pcm[i]))
    }
    // Expected peak is around 0.25 (0.75 * 0.25 to 1.0 * 0.25)
    t.ok(maxAbs > 0.15 && maxAbs < 0.3,
        `peak is ${maxAbs}, near expected 0.25`)
})

test('makeTonePcm generates varying samples (not constant)', (t) => {
    const pcm = makeTonePcm(2)
    let hasVariation = false
    for (let i = 1; i < Math.min(100, pcm.length); i++) {
        if (Math.abs(pcm[i] - pcm[i - 1]) > 0.001) {
            hasVariation = true
            break
        }
    }
    t.ok(hasVariation, 'consecutive samples differ (signal varies)')
})

test('bytesToPcm round-trips correctly', (t) => {
    const original = new Float32Array([0.1, 0.2, 0.3, 0.4])
    const bytes = new Uint8Array(
        original.buffer.slice(0)
    )
    const result = bytesToPcm(bytes)

    t.equal(result.length, original.length,
        'round-tripped array has same length')
    let equal = true
    for (let i = 0; i < result.length; i++) {
        if (result[i] !== original[i]) {
            equal = false
            break
        }
    }
    t.equal(equal, true, 'round-tripped values are equal')
})

test('bytesToPcm throws on non-aligned input', (t) => {
    const bytes = new Uint8Array(6)  // not a whole number of samples
    try {
        bytesToPcm(bytes)
        t.fail('should have thrown')
    } catch (err) {
        t.ok(err instanceof AttachmentError,
            'should throw AttachmentError')
    }
})

test('chunkStartSeconds advances with the byte offset', (t) => {
    const oneSecond = SAMPLE_RATE * 4
    t.equal(chunkStartSeconds(0), 0, 'should start at zero')
    t.equal(
        chunkStartSeconds(3 * oneSecond) - chunkStartSeconds(oneSecond),
        2,
        'should advance two seconds over two seconds of samples'
    )
})
