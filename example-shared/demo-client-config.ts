import {
    type ClientConfig,
    defaultClientConfig,
    unsafeAcceptAllAuthenticationService
} from '../src/index.js'

/**
 * The `ClientConfig` both demos hand to `createGroup`/`joinGroup`.
 *
 * It is the library default except for `authService`. The default one
 * fails closed -- it throws rather than guess whether a credential is
 * genuine -- so every application has to say what authentication means to
 * it. These demos have no identity system at all: names are typed into a
 * form, so `unsafeAcceptAllAuthenticationService` is the honest answer,
 * and naming it here is the point. A real application replaces this with
 * a `validateCredential` that checks the signature key against a CA, a
 * directory, or whatever binds identities in its world.
 */
export const demoClientConfig:ClientConfig = {
    ...defaultClientConfig,
    authService: unsafeAcceptAllAuthenticationService
}
