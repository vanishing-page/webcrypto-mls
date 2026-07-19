import type { CiphersuiteImpl } from './crypto/ciphersuite.js'
import type { SignatureSecretKey } from './crypto/signature.js'
import { extensionsSupportedByCapabilities } from './extension.js'
import { decodeExternalSenders } from './external-sender.js'
import type { GroupInfo } from './group-info.js'
import type { KeyPackage, PrivateKeyPackage } from './key-package.js'
import type { MLSMessage } from './message.js'
import { protectExternalProposalPublic } from './message-protection-public.js'
import { UsageError, ValidationError } from './mls-error.js'
import type { Proposal } from './proposal.js'
import { constantTimeEqual } from './util/constant-time-compare.js'

export async function proposeAddExternal (
    groupInfo:GroupInfo,
    keyPackage:KeyPackage,
    privateKeyPackage:PrivateKeyPackage,
    cs:CiphersuiteImpl,
    authenticatedData:Uint8Array = new Uint8Array(),
):Promise<MLSMessage> {
    const allExtensionsSupported = extensionsSupportedByCapabilities(
        groupInfo.groupContext.extensions,
        keyPackage.leafNode.capabilities,
    )
    if (!allExtensionsSupported) throw new UsageError('client does not support every extension in the GroupContext')

    const proposal:Proposal = {
        proposalType: 'add',
        add: {
            keyPackage,
        },
    }

    const result = await protectExternalProposalPublic(
        privateKeyPackage.signaturePrivateKey,
        groupInfo.groupContext,
        authenticatedData,
        proposal,
        { senderType: 'new_member_proposal' },
        cs,
    )

    return {
        wireformat: 'mls_public_message',
        version: groupInfo.groupContext.version,
        publicMessage: result.publicMessage,
    }
}

const proposalTypesPermittedForExternalSenders = new Set([
    'add',
    'remove',
    'psk',
    'reinit',
    'group_context_extensions',
])

export async function proposeExternal (
    groupInfo:GroupInfo,
    proposal:Proposal,
    signaturePublicKey:Uint8Array,
    signaturePrivateKey:SignatureSecretKey,
    cs:CiphersuiteImpl,
    authenticatedData:Uint8Array = new Uint8Array(),
):Promise<MLSMessage> {
    if (
        typeof proposal.proposalType !== 'string' ||
        !proposalTypesPermittedForExternalSenders.has(proposal.proposalType)
    ) {
        throw new UsageError(`proposalType '${proposal.proposalType}' is not permitted for an external sender`)
    }

    const externalSendersExtension = groupInfo.groupContext.extensions.find(
        (ex) => ex.extensionType === 'external_senders',
    )
    if (externalSendersExtension === undefined) { throw new ValidationError('Could not find external_senders extension in groupContext.extensions') }

    let decoded:ReturnType<typeof decodeExternalSenders>
    try {
        decoded = decodeExternalSenders(externalSendersExtension.extensionData, 0)
    } catch {
        decoded = undefined
    }
    if (decoded === undefined) throw new ValidationError('Could not decode external_senders extension')

    const externalSenderExtensionIndex = decoded[0].findIndex(
        (sender) => constantTimeEqual(sender.signaturePublicKey, signaturePublicKey),
    )

    if (externalSenderExtensionIndex === -1) { throw new ValidationError('Could not find matching external sender in external_senders extension') }

    const result = await protectExternalProposalPublic(
        signaturePrivateKey,
        groupInfo.groupContext,
        authenticatedData,
        proposal,
        { senderType: 'external', senderIndex: externalSenderExtensionIndex },
        cs,
    )

    return {
        wireformat: 'mls_public_message',
        version: groupInfo.groupContext.version,
        publicMessage: result.publicMessage,
    }
}
