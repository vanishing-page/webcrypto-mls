import { decodeOptional, encodeOptional } from './codec/optional.js'
import type { Decoder } from './codec/tls-decoder.js'
import { mapDecoders } from './codec/tls-decoder.js'
import type { Encoder } from './codec/tls-encoder.js'
import { contramapEncoders } from './codec/tls-encoder.js'
import { decodeVarLenType, encodeVarLenType } from './codec/variable-length.js'
import type { ProposalOrRef } from './proposal-or-ref-type.js'
import { decodeProposalOrRef, encodeProposalOrRef } from './proposal-or-ref-type.js'
import type { UpdatePath } from './update-path.js'
import { decodeUpdatePath, encodeUpdatePath } from './update-path.js'

export interface Commit {
    proposals:ProposalOrRef[]
    path:UpdatePath | undefined
}

export const encodeCommit:Encoder<Commit> = contramapEncoders(
    [encodeVarLenType(encodeProposalOrRef), encodeOptional(encodeUpdatePath)],
    (commit) => [commit.proposals, commit.path] as const,
)

export const decodeCommit:Decoder<Commit> = mapDecoders(
    [decodeVarLenType(decodeProposalOrRef), decodeOptional(decodeUpdatePath)],
    (proposals, path) => ({ proposals, path }),
)
