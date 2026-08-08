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

    /**
     * Custom (application-defined) proposal types the application knows how
     * to interpret. RFC 9420 SS12.1 requires that a proposal type not
     * understood by an implementation MUST cause the commit referencing it
     * to be rejected -- an application can only accept a custom proposal
     * type by explicitly opting in here. Opted-in custom proposals are
     * otherwise unvalidated and untouched by tree-mutation logic; the
     * application is responsible for interpreting `proposalData` itself.
     * Custom proposals sent/received standalone (outside a commit) are
     * always accepted into `unappliedProposals` regardless of this list --
     * only committing them is gated.
     */
    supportedCustomProposalTypes:number[]
}

export const defaultClientConfig = {
    keyRetentionConfig: defaultKeyRetentionConfig,
    lifetimeConfig: defaultLifetimeConfig,
    keyPackageEqualityConfig: defaultKeyPackageEqualityConfig,
    paddingConfig: defaultPaddingConfig,
    authService: defaultAuthenticationService,
    supportedCustomProposalTypes: [],
}
