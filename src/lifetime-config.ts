export interface LifetimeConfig {
    maximumTotalLifetime:bigint
    validateLifetimeOnReceive:boolean
}

/**
 * `validateLifetimeOnReceive` defaults to `false`: a received KeyPackage's
 * `notBefore`/`notAfter` window and its total span against
 * `maximumTotalLifetime` are only checked when *this client* is the one
 * generating a leaf node (add/join/update), not when validating a leaf
 * node received from a peer. Set it to `true` to also enforce, on every
 * received KeyPackage leaf node, that the current time falls within the
 * lifetime window and the window does not exceed `maximumTotalLifetime`
 * -- recommended for production so an expired or improbably long-lived
 * peer credential cannot be accepted into the group.
 */
export const defaultLifetimeConfig:LifetimeConfig = {
    maximumTotalLifetime: 2628000n, // 1 month
    validateLifetimeOnReceive: false,
}
