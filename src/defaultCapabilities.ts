import type { Capabilities } from './capabilities.js'
import type { CiphersuiteName } from './crypto/ciphersuite.js'
import { ciphersuites } from './crypto/ciphersuite.js'
import { greaseCapabilities, defaultGreaseConfig } from './grease.js'

export function defaultCapabilities (): Capabilities {
    return greaseCapabilities(defaultGreaseConfig, {
        versions: ['mls10'],
        ciphersuites: Object.keys(ciphersuites) as CiphersuiteName[],
        extensions: [],
        proposals: [],
        credentials: ['basic', 'x509'],
    })
}
