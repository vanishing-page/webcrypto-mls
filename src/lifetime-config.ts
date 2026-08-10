export interface LifetimeConfig {
    maximumTotalLifetime:bigint
    validateLifetimeOnReceive:boolean
}

/**
 * `validateLifetimeOnReceive` defaults to `true`: on every KeyPackage leaf
 * node, whether *this client* generated it (add/join/update) or it arrived
 * from a peer, the current time must fall within the `notBefore`/`notAfter`
 * window and that window must not exceed `maximumTotalLifetime`. This is
 * what RFC 9420 7.3 asks for, and it is what stops an expired or
 * improbably long-lived peer credential from being replayed into the
 * group. Set it to `false` to check only leaf nodes this client generated
 * -- an explicit opt-out, useful for clients with an untrustworthy system
 * clock or for interop with peers that publish stale KeyPackages.
 */
export const defaultLifetimeConfig:LifetimeConfig = {
    maximumTotalLifetime: 2628000n, // 1 month
    validateLifetimeOnReceive: true,
}
