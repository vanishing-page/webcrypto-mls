import type { ClientConfig } from '../../src/client-config.js'
import { defaultClientConfig } from '../../src/client-config.js'
import {
    unsafeAcceptAllAuthenticationService
} from '../../src/authentication-service.js'

/**
 * The default config plus the one thing the library refuses to pick for
 * you: an `AuthenticationService`.
 *
 * `defaultClientConfig` fails closed, so every test that builds or joins a
 * group opts in to accept-all by name, exactly as an application would
 * have to. Tests that care about credential checking build their own
 * config instead of importing this one.
 */
export const testClientConfig:ClientConfig = {
    ...defaultClientConfig,
    authService: unsafeAcceptAllAuthenticationService,
}
