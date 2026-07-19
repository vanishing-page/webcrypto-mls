import { decodeUint8, encodeUint8 } from './codec/number.js'
import type { Decoder } from './codec/tls-decoder.js'
import { flatMapDecoder, mapDecoder, mapDecoderOption } from './codec/tls-decoder.js'
import type { Encoder } from './codec/tls-encoder.js'
import { contramapEncoder, contramapEncoders } from './codec/tls-encoder.js'
import { decodeVarLenData, encodeVarLenData } from './codec/variable-length.js'
import type { Proposal } from './proposal.js'
import { decodeProposal, encodeProposal } from './proposal.js'
import { enumNumberToKey } from './util/enum-helpers.js'

const proposalOrRefTypes = {
    proposal: 1,
    reference: 2,
} as const

export type ProposalOrRefTypeName = keyof typeof proposalOrRefTypes
export type ProposalOrRefTypeValue = (typeof proposalOrRefTypes)[ProposalOrRefTypeName]

export const encodeProposalOrRefType:Encoder<ProposalOrRefTypeName> = contramapEncoder(
    encodeUint8,
    (t) => proposalOrRefTypes[t],
)

export const decodeProposalOrRefType:Decoder<ProposalOrRefTypeName> = mapDecoderOption(
    decodeUint8,
    enumNumberToKey(proposalOrRefTypes),
)

export interface ProposalOrRefProposal {
    proposalOrRefType:'proposal'
    proposal:Proposal
}
export interface ProposalOrRefProposalRef {
    proposalOrRefType:'reference'
    reference:Uint8Array
}

export type ProposalOrRef = ProposalOrRefProposal | ProposalOrRefProposalRef

export const encodeProposalOrRefProposal:Encoder<ProposalOrRefProposal> = contramapEncoders(
    [encodeProposalOrRefType, encodeProposal],
    (p) => [p.proposalOrRefType, p.proposal] as const,
)

export const encodeProposalOrRefProposalRef:Encoder<ProposalOrRefProposalRef> = contramapEncoders(
    [encodeProposalOrRefType, encodeVarLenData],
    (r) => [r.proposalOrRefType, r.reference] as const,
)

export const encodeProposalOrRef:Encoder<ProposalOrRef> = (input) => {
    switch (input.proposalOrRefType) {
        case 'proposal':
            return encodeProposalOrRefProposal(input)
        case 'reference':
            return encodeProposalOrRefProposalRef(input)
    }
}

export const decodeProposalOrRef:Decoder<ProposalOrRef> = flatMapDecoder(
    decodeProposalOrRefType,
    (proposalOrRefType):Decoder<ProposalOrRef> => {
        switch (proposalOrRefType) {
            case 'proposal':
                return mapDecoder(decodeProposal, (proposal) => ({ proposalOrRefType, proposal }))
            case 'reference':
                return mapDecoder(decodeVarLenData, (reference) => ({ proposalOrRefType, reference }))
        }
    },
)
