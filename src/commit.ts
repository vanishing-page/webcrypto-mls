import { decodeOptional, encodeOptional } from './codec/optional.js'
import type { Decoder } from './codec/tlsDecoder.js'
import { mapDecoders } from './codec/tlsDecoder.js'
import type { Encoder } from './codec/tlsEncoder.js'
import { contramapEncoders } from './codec/tlsEncoder.js'
import { decodeVarLenType, encodeVarLenType } from './codec/variableLength.js'
import type { ProposalOrRef } from './proposalOrRefType.js'
import { decodeProposalOrRef, encodeProposalOrRef } from './proposalOrRefType.js'
import type { UpdatePath } from './updatePath.js'
import { decodeUpdatePath, encodeUpdatePath } from './updatePath.js'

export interface Commit {
  proposals: ProposalOrRef[]
  path: UpdatePath | undefined
}

export const encodeCommit: Encoder<Commit> = contramapEncoders(
    [encodeVarLenType(encodeProposalOrRef), encodeOptional(encodeUpdatePath)],
    (commit) => [commit.proposals, commit.path] as const,
)

export const decodeCommit: Decoder<Commit> = mapDecoders(
    [decodeVarLenType(decodeProposalOrRef), decodeOptional(decodeUpdatePath)],
    (proposals, path) => ({ proposals, path }),
)
