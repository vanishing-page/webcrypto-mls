import {
    type CiphersuiteImpl,
    type ClientState,
    createGroup,
    defaultCapabilities,
    defaultLifetime,
    generateKeyPackage
} from '../src/index.js'
import { demoClientConfig } from '../example-shared/demo-client-config.js'

/**
 * Create the one-member MLS group the attachments demo encrypts
 * against.
 *
 * The demo used to invent a random 32-byte secret and derive a key
 * schedule from it directly. That derives a usable CEK, but it is not
 * the path a consumer of this library takes and it hides the fact that
 * an attachment key is scoped to a group epoch. Here the schedule comes
 * off a real `ClientState`, so `state.keySchedule` is exactly what an
 * application already has after `createGroup` or `joinGroup`, and the
 * `...ForGroup` wrappers take it unchanged.
 *
 * One member is enough: `keySchedule.applicationExportSecret` exists
 * from epoch 0 and does not depend on the roster.
 */
export async function createDemoGroup (
    cs:CiphersuiteImpl
):Promise<ClientState> {
    const signatureKeyPair = await globalThis.crypto.subtle.generateKey(
        { name: 'Ed25519' },
        false,
        ['sign', 'verify']
    )

    const { publicPackage, privatePackage } = await generateKeyPackage(
        {
            credentialType: 'basic',
            identity: new TextEncoder().encode('attachments-demo')
        },
        defaultCapabilities(),
        defaultLifetime(),
        [],
        cs,
        { signatureKeyPair: signatureKeyPair as CryptoKeyPair }
    )

    return createGroup(
        cs.rng.randomBytes(32),
        publicPackage,
        privatePackage,
        [],
        cs,
        demoClientConfig
    )
}
