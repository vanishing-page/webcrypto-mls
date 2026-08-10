import type { Credential } from './credential.js'
import { UsageError } from './mls-error.js'

export interface AuthenticationService {
    /**
     * @param credential The credential being introduced into the group.
     * @param signaturePublicKey The signature key `credential` is claimed to
     * be bound to.
     * @param priorCredential The credential currently occupying the leaf that
     * this one would replace, when there is one. Supplied for Update
     * proposals, for a commit's UpdatePath leaf, and whenever a received
     * ratchet tree is revalidated; `undefined` for an Add, an external commit
     * joining at a blank leaf, and for `external_senders` and GroupInfo
     * signer checks, which replace nothing.
     *
     * MLS itself does not require the identity at a leaf to stay constant, so
     * an implementation that ignores `priorCredential` lets any member claim
     * any identity string by sending an Update. Compare the two to enforce
     * identity continuity.
     */
    validateCredential(
        credential:Credential,
        signaturePublicKey:Uint8Array,
        priorCredential?:Credential,
    ):Promise<boolean>
}

/**
 * The `AuthenticationService` a `ClientConfig` gets when the application
 * has not chosen one. It authenticates nothing; it throws a `UsageError`
 * the first time the library needs a credential decision.
 *
 * A group cannot be built on credentials nobody checked, so the absence of
 * a choice is treated as a configuration bug rather than as permission to
 * accept everyone. Supply a real `AuthenticationService`, or -- for local
 * testing only -- `unsafeAcceptAllAuthenticationService`.
 */
export const failClosedAuthenticationService:AuthenticationService = {
    async validateCredential (
        _credential:Credential,
        _signaturePublicKey:Uint8Array,
        _priorCredential?:Credential,
    ):Promise<boolean> {
        throw new UsageError(
            'No AuthenticationService is configured, so this credential ' +
            'cannot be authenticated. Set `authService` on the ' +
            '`ClientConfig` passed to createGroup/joinGroup/' +
            'joinGroupExternal. For local testing only, pass ' +
            '`unsafeAcceptAllAuthenticationService`.',
        )
    },
}

/**
 * An `AuthenticationService` that accepts every credential
 * unconditionally -- it does not check that `signaturePublicKey` is bound
 * to `credential` by any external identity system (e.g. a CA for x509, or
 * an out-of-band directory for basic credentials), and it ignores
 * `priorCredential`, so it does not enforce identity continuity when a
 * leaf is replaced.
 *
 * This is for local testing and demos only. Passing it in production means
 * a malicious peer's forged or unauthorized credential is accepted into
 * the group under any identity it likes. It is deliberately not a default:
 * a caller has to name it.
 */
export const unsafeAcceptAllAuthenticationService:AuthenticationService = {
    async validateCredential (
        _credential:Credential,
        _signaturePublicKey:Uint8Array,
        _priorCredential?:Credential,
    ):Promise<boolean> {
        return true
    },
}
