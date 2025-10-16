import { test } from '@substrate-system/tapzero'
import json from '../../test_vectors/deserialization.json'
import { hexToBytes } from '@noble/ciphers/utils.js'
import { determineLength } from '../../src/codec/variableLength.js'

for (const [index, x] of json.map((x, index) => [index, x] as [number, typeof x])) {
    test(`deserialization test vectors ${index}`, (t) => {
        checkLength(t, x.vlbytes_header, x.length)
    })
}

function checkLength (t: any, header: string, len: number) {
    const { length } = determineLength(hexToBytes(header))
    t.equal(length, len, `length should be ${len}`)
}
