import type { Credential, CredentialCustom } from './credential.js'
import type { CredentialTypeName } from './credential-type.js'
import { UsageError } from './mls-error.js'

const RESERVED_CREDENTIAL_TYPES = [1, 2]

function createCustomCredentialType (credentialId:number):CredentialTypeName {
    return credentialId.toString() as CredentialTypeName
}

export function createCustomCredential (credentialId:number, data:Uint8Array):Credential {
    if (RESERVED_CREDENTIAL_TYPES.includes(credentialId)) {
        throw new UsageError(
            `Credential type ${credentialId} is reserved for the ` +
            'standard "basic" (1) and "x509" (2) credential types and ' +
            'cannot be used as a custom credential type',
        )
    }

    const result:CredentialCustom = {
        credentialType: createCustomCredentialType(credentialId),
        data,
    }
    return result as unknown as Credential
}
