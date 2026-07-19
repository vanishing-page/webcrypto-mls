import type { Capabilities } from './capabilities.js'
import type { CredentialTypeName } from './credential-type.js'
import type { CiphersuiteName } from './crypto/ciphersuite.js'
import type { Extension } from './extension.js'
import type { Rng } from './crypto/rng.js'

export const greaseValues = [
    0x0a0a, 0x1a1a, 0x2a2a, 0x3a3a, 0x4a4a, 0x5a5a, 0x6a6a, 0x7a7a, 0x8a8a, 0x9a9a, 0xaaaa, 0xbaba, 0xcaca, 0xdada,
    0xeaea,
]

export interface GreaseConfig {
    probabilityPerGreaseValue:number
}

export const defaultGreaseConfig = {
    probabilityPerGreaseValue: 0.1,
}

// Reads 4 rng bytes as a big-endian uint32 and scales to [0, 1).
function nextUnitInterval (rng:Rng):number {
    const bytes = rng.randomBytes(4)
    const uint32 = (
        (bytes[0] << 24) |
        (bytes[1] << 16) |
        (bytes[2] << 8) |
        bytes[3]
    ) >>> 0
    return uint32 / 0x100000000
}

export function grease (greaseConfig:GreaseConfig, rng:Rng):number[] {
    return greaseValues.filter(() => greaseConfig.probabilityPerGreaseValue > nextUnitInterval(rng))
}

export function greaseCiphersuites (greaseConfig:GreaseConfig, rng:Rng):CiphersuiteName[] {
    return grease(greaseConfig, rng).map((n) => n.toString() as CiphersuiteName)
}

export function greaseCredentials (greaseConfig:GreaseConfig, rng:Rng):CredentialTypeName[] {
    return grease(greaseConfig, rng).map((n) => n.toString() as CredentialTypeName)
}

export function greaseExtensions (greaseConfig:GreaseConfig, rng:Rng):Extension[] {
    return grease(greaseConfig, rng).map((n) => ({ extensionType: n, extensionData: new Uint8Array() }))
}

export function greaseCapabilities (
    config:GreaseConfig,
    capabilities:Capabilities,
    rng:Rng,
):Capabilities {
    return {
        ciphersuites: [...capabilities.ciphersuites, ...greaseCiphersuites(config, rng)],
        credentials: [...capabilities.credentials, ...greaseCredentials(config, rng)],
        extensions: [...capabilities.extensions, ...grease(config, rng)],
        proposals: [...capabilities.proposals, ...grease(config, rng)],
        versions: capabilities.versions,
    }
}
