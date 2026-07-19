import type { Decoder } from './codec/tls-decoder.js'
import { flatMapDecoder, mapDecoder, mapDecoders, succeedDecoder } from './codec/tls-decoder.js'
import type { Encoder } from './codec/tls-encoder.js'
import { contramapEncoders } from './codec/tls-encoder.js'
import { decodeVarLenData, encodeVarLenData } from './codec/variable-length.js'
import type { Extension } from './extension.js'
import type { ExternalSender } from './external-sender.js'
import { decodeExternalSenders } from './external-sender.js'
import type {
    FramedContent,
    FramedContentAuthData
} from './framed-content.js'
import {
    decodeFramedContent,
    decodeFramedContentAuthData,
    encodeFramedContent,
    encodeFramedContentAuthData
} from './framed-content.js'
import type { GroupContext } from './group-context.js'
import { CodecError, ValidationError } from './mls-error.js'
import type { RatchetTree } from './ratchet-tree.js'
import { getSignaturePublicKeyFromLeafIndex } from './ratchet-tree.js'
import type { SenderTypeName } from './sender.js'
import { toLeafIndex } from './treemath.js'

// RFC 9420 12.1.7 / 12.1.8.2: an external sender is not a group member and
// may only propose these types -- notably not Update, and no Commit or
// application content at all.
const externalSenderAllowedProposalTypes = new Set([
    'add',
    'remove',
    'psk',
    'reinit',
    'group_context_extensions',
])

// Type definitions used before defined - moved to top
type PublicMessageInfoMember = { senderType:'member'; membershipTag:Uint8Array }
type PublicMessageInfoMemberOther = { senderType:Exclude<SenderTypeName, 'member'> }
type PublicMessageInfo = PublicMessageInfoMember | PublicMessageInfoMemberOther

export type PublicMessage = { content:FramedContent; auth:FramedContentAuthData } & PublicMessageInfo
export type MemberPublicMessage = PublicMessage & PublicMessageInfoMember
export type ExternalPublicMessage = PublicMessage & PublicMessageInfoMemberOther

export const encodePublicMessageInfo:Encoder<PublicMessageInfo> = (info) => {
    switch (info.senderType) {
        case 'member':
            return encodeVarLenData(info.membershipTag)
        case 'external':
        case 'new_member_proposal':
        case 'new_member_commit':
            return new Uint8Array()
    }
}

export function decodePublicMessageInfo (senderType:SenderTypeName):Decoder<PublicMessageInfo> {
    switch (senderType) {
        case 'member':
            return mapDecoder(decodeVarLenData, (membershipTag) => ({
                senderType,
                membershipTag,
            }))
        case 'external':
        case 'new_member_proposal':
        case 'new_member_commit':
            return succeedDecoder({ senderType })
    }
}

export const encodePublicMessage:Encoder<PublicMessage> = contramapEncoders(
    [encodeFramedContent, encodeFramedContentAuthData, encodePublicMessageInfo],
    (msg) => [msg.content, msg.auth, msg] as const,
)

export const decodePublicMessage:Decoder<PublicMessage> = flatMapDecoder(decodeFramedContent, (content) =>
    mapDecoders(
        [decodeFramedContentAuthData(content.contentType), decodePublicMessageInfo(content.sender.senderType)],
        (auth, info) => ({
            ...info,
            content,
            auth,
        }),
    ),
)

export function findSignaturePublicKey (
    ratchetTree:RatchetTree,
    groupContext:GroupContext,
    framedContent:FramedContent,
):Uint8Array {
    switch (framedContent.sender.senderType) {
        case 'member':
            return getSignaturePublicKeyFromLeafIndex(ratchetTree, toLeafIndex(framedContent.sender.leafIndex))
        case 'external': {
            const sender = senderFromExtension(groupContext.extensions, framedContent.sender.senderIndex)
            if (sender === undefined) throw new ValidationError('Received external but no external_sender extension')

            if (framedContent.contentType !== 'proposal') { throw new ValidationError('Received external sender but contentType is not proposal') }
            if (
                typeof framedContent.proposal.proposalType === 'number' ||
                !externalSenderAllowedProposalTypes.has(framedContent.proposal.proposalType)
            ) {
                throw new ValidationError(`External sender is not permitted to send a ${String(framedContent.proposal.proposalType)} proposal`)
            }

            return sender.signaturePublicKey
        }
        case 'new_member_proposal':
            if (framedContent.contentType !== 'proposal') { throw new ValidationError('Received new_member_proposal but contentType is not proposal') }
            if (framedContent.proposal.proposalType !== 'add') { throw new ValidationError('Received new_member_proposal but proposalType was not add') }

            return framedContent.proposal.add.keyPackage.leafNode.signaturePublicKey
        case 'new_member_commit': {
            if (framedContent.contentType !== 'commit') { throw new ValidationError('Received new_member_commit but contentType is not commit') }

            if (framedContent.commit.path === undefined) throw new ValidationError('Commit contains no update path')
            return framedContent.commit.path.leafNode.signaturePublicKey
        }
    }
}

export function senderFromExtension (extensions:Extension[], senderIndex:number):ExternalSender | undefined {
    const externalSendersExtension = extensions.find((ex) => ex.extensionType === 'external_senders')
    if (externalSendersExtension === undefined) return undefined

    const decoded = decodeExternalSenders(externalSendersExtension.extensionData, 0)
    if (decoded === undefined) throw new CodecError('Could not decode external_senders')

    return decoded[0][senderIndex]
}
