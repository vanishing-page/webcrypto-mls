import { bytesToBuffer } from '../../../util/byte-array.js'
import type { HashAlgorithm, Hash } from '../../hash.js'

const webcrypto = globalThis.crypto

export function makeHashImpl (sc:SubtleCrypto, h:HashAlgorithm):Hash {
    return {
        async digest (data) {
            const result = await sc.digest(h, bytesToBuffer(data))
            return new Uint8Array(result)
        },
        async mac (key, data) {
            const result = await sc.sign('HMAC', await importMacKey(key, h), bytesToBuffer(data))
            return new Uint8Array(result)
        },
        async verifyMac (key, mac, data) {
            return sc.verify('HMAC', await importMacKey(key, h), bytesToBuffer(mac), bytesToBuffer(data))
        },
    }
}
function importMacKey (rawKey:Uint8Array, h:HashAlgorithm):Promise<CryptoKey> {
    return webcrypto.subtle.importKey(
        'raw',
        bytesToBuffer(rawKey),
        {
            name: 'HMAC',
            hash: { name: h },
        },
        false,
        ['sign', 'verify'],
    )
}
