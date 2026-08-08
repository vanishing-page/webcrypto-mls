import type { Credential } from './credential.js'

export interface AuthenticationService {
    validateCredential(credential:Credential, signaturePublicKey:Uint8Array):Promise<boolean>
}

/**
 * The default `AuthenticationService` accepts every credential
 * unconditionally -- it does not check that `signaturePublicKey` is bound
 * to `credential` by any external identity system (e.g. a CA for x509, or
 * an out-of-band directory for basic credentials). This is only safe for
 * local testing. A production application MUST supply its own
 * `AuthenticationService` whose `validateCredential` performs a real
 * check, or a malicious peer's forged/unauthorized credential will be
 * accepted into the group.
 */
export const defaultAuthenticationService = {
    async validateCredential (_credential:Credential, _signaturePublicKey:Uint8Array):Promise<boolean> {
        return true
    },
}
