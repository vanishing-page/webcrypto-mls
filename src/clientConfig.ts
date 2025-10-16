import type { AuthenticationService } from './authenticationService.js'
import { defaultAuthenticationService } from './authenticationService.js'
import type { KeyPackageEqualityConfig } from './keyPackageEqualityConfig.js'
import { defaultKeyPackageEqualityConfig } from './keyPackageEqualityConfig.js'
import type { KeyRetentionConfig } from './keyRetentionConfig.js'
import { defaultKeyRetentionConfig } from './keyRetentionConfig.js'
import type { LifetimeConfig } from './lifetimeConfig.js'
import { defaultLifetimeConfig } from './lifetimeConfig.js'
import type { PaddingConfig } from './paddingConfig.js'
import { defaultPaddingConfig } from './paddingConfig.js'

export interface ClientConfig {
  keyRetentionConfig: KeyRetentionConfig
  lifetimeConfig: LifetimeConfig
  keyPackageEqualityConfig: KeyPackageEqualityConfig
  paddingConfig: PaddingConfig
  authService: AuthenticationService
}

export const defaultClientConfig = {
    keyRetentionConfig: defaultKeyRetentionConfig,
    lifetimeConfig: defaultLifetimeConfig,
    keyPackageEqualityConfig: defaultKeyPackageEqualityConfig,
    paddingConfig: defaultPaddingConfig,
    authService: defaultAuthenticationService,
}
