import type { AuthenticationService } from './authentication-service.js'
import { defaultAuthenticationService } from './authentication-service.js'
import type { KeyPackageEqualityConfig } from './key-package-equality-config.js'
import { defaultKeyPackageEqualityConfig } from './key-package-equality-config.js'
import type { KeyRetentionConfig } from './key-retention-config.js'
import { defaultKeyRetentionConfig } from './key-retention-config.js'
import type { LifetimeConfig } from './lifetime-config.js'
import { defaultLifetimeConfig } from './lifetime-config.js'
import type { PaddingConfig } from './padding-config.js'
import { defaultPaddingConfig } from './padding-config.js'

export interface ClientConfig {
    keyRetentionConfig:KeyRetentionConfig
    lifetimeConfig:LifetimeConfig
    keyPackageEqualityConfig:KeyPackageEqualityConfig
    paddingConfig:PaddingConfig
    authService:AuthenticationService
}

export const defaultClientConfig = {
    keyRetentionConfig: defaultKeyRetentionConfig,
    lifetimeConfig: defaultLifetimeConfig,
    keyPackageEqualityConfig: defaultKeyPackageEqualityConfig,
    paddingConfig: defaultPaddingConfig,
    authService: defaultAuthenticationService,
}
