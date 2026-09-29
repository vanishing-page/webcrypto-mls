import type { CiphersuiteImpl } from './crypto/ciphersuite.js'
import type { Kdf } from './crypto/kdf.js'
import { deriveSecret, expandWithLabel } from './crypto/kdf.js'
import type { GroupContext } from './group-context.js'
import { extractEpochSecret, extractJoinerSecret } from './group-context.js'
import { extractWelcomeSecret } from './group-info.js'

export interface KeySchedule {
    senderDataSecret:Uint8Array
    exporterSecret:Uint8Array
    externalSecret:Uint8Array
    confirmationKey:Uint8Array
    membershipKey:Uint8Array
    resumptionPsk:Uint8Array
    epochAuthenticator:Uint8Array
    initSecret:Uint8Array
    applicationExportSecret:Uint8Array
}

/**
 * `encryptionSecret` is handed to the caller rather than kept on
 * `KeySchedule`: it regenerates the whole secret tree, including every
 * consumed generation, so it must not live for the epoch. The caller
 * allocated it, passes it to `createSecretTree`, then zeroes it.
 */
export interface DerivedKeySchedule {
    keySchedule:KeySchedule
    encryptionSecret:Uint8Array
}

export interface EpochSecrets extends DerivedKeySchedule {
    joinerSecret:Uint8Array
    welcomeSecret:Uint8Array
}

export async function mlsExporter (
    exporterSecret:Uint8Array,
    label:string,
    context:Uint8Array,
    length:number,
    cs:CiphersuiteImpl,
) {
    const secret = await deriveSecret(exporterSecret, label, cs.kdf)

    const hash = await cs.hash.digest(context)
    return expandWithLabel(secret, 'exported', hash, length, cs.kdf)
}

export async function deriveKeySchedule (
    joinerSecret:Uint8Array,
    pskSecret:Uint8Array,
    groupContext:GroupContext,
    kdf:Kdf,
):Promise<DerivedKeySchedule> {
    const epochSecret = await extractEpochSecret(
        groupContext,
        joinerSecret,
        kdf,
        pskSecret
    )

    return await deriveEpochKeys(epochSecret, kdf)
}

/**
 * Derives the epoch's `KeySchedule` alone, for callers that build no
 * secret tree. The encryption secret is wiped before returning.
 */
export async function initializeKeySchedule (
    epochSecret:Uint8Array,
    kdf:Kdf,
):Promise<KeySchedule> {
    const { keySchedule, encryptionSecret } = await deriveEpochKeys(
        epochSecret, kdf)
    encryptionSecret.fill(0)
    return keySchedule
}

export async function deriveEpochKeys (
    epochSecret:Uint8Array,
    kdf:Kdf,
):Promise<DerivedKeySchedule> {
    const newInitSecret = await deriveSecret(epochSecret, 'init', kdf)
    const senderDataSecret = await deriveSecret(epochSecret, 'sender data', kdf)
    const encryptionSecret = await deriveSecret(epochSecret, 'encryption', kdf)
    const exporterSecret = await deriveSecret(epochSecret, 'exporter', kdf)
    const externalSecret = await deriveSecret(epochSecret, 'external', kdf)
    const confirmationKey = await deriveSecret(epochSecret, 'confirm', kdf)
    const membershipKey = await deriveSecret(epochSecret, 'membership', kdf)
    const resumptionPsk = await deriveSecret(epochSecret, 'resumption', kdf)
    const epochAuthenticator = await deriveSecret(
        epochSecret, 'authentication', kdf)
    const applicationExportSecret = await deriveSecret(
        epochSecret, 'application_export', kdf)

    // best-effort: epochSecret can recompute every output above, so it
    // must not outlive this function once those outputs are derived
    epochSecret.fill(0)

    const newKeySchedule:KeySchedule = {
        initSecret: newInitSecret,
        senderDataSecret,
        exporterSecret,
        externalSecret,
        confirmationKey,
        membershipKey,
        resumptionPsk,
        epochAuthenticator,
        applicationExportSecret,
    }

    return { keySchedule: newKeySchedule, encryptionSecret }
}

export async function initializeEpoch (
    initSecret:Uint8Array,
    commitSecret:Uint8Array,
    groupContext:GroupContext,
    pskSecret:Uint8Array,
    kdf:Kdf,
):Promise<EpochSecrets> {
    const joinerSecret = await extractJoinerSecret(
        groupContext,
        initSecret,
        commitSecret,
        kdf
    )

    const welcomeSecret = await extractWelcomeSecret(
        joinerSecret, pskSecret, kdf)

    const derived = await deriveKeySchedule(
        joinerSecret,
        pskSecret,
        groupContext,
        kdf
    )

    return { welcomeSecret, joinerSecret, ...derived }
}
