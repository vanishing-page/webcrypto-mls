import {
    type CiphersuiteImpl,
    type ClientState,
    createGroup,
    defaultCapabilities,
    defaultLifetime,
    generateKeyPackage
} from '../../src/index.js'
import { demoClientConfig } from '../../example-shared/demo-client-config.js'

/** Create a compact real group for attachment tests. */
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
            identity: new TextEncoder().encode('attachments-test')
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
