import { test } from '@substrate-system/tapzero'
import type { Proposal } from '../../src/proposal.js'
import { encodeProposal, decodeProposal } from '../../src/proposal.js'
import { createRoundtripTest } from './roundtrip.js'

const dummyProposalAdd:Proposal = {
    proposalType: 'add',
    add: {
        keyPackage: {
            version: 'mls10',
            cipherSuite: 'MLS_256_XWING_AES256GCM_SHA512_Ed25519',
            initKey: new Uint8Array([]),
            leafNode: {
                hpkePublicKey: new Uint8Array([]),
                signaturePublicKey: new Uint8Array([]),
                credential: { credentialType: 'basic', identity: new Uint8Array([]) },
                capabilities: {
                    versions: [],
                    ciphersuites: [],
                    extensions: [],
                    proposals: [],
                    credentials: [],
                },
                leafNodeSource: 'key_package',
                lifetime: { notBefore: 0n, notAfter: 0n },
                extensions: [],
                signature: new Uint8Array([]),
            },
            extensions: [],
            signature: new Uint8Array([]),
        },
    },
}

const dummyProposalRemove:Proposal = {
    proposalType: 'remove',
    remove: { removed: 42 },
}

const roundtrip = createRoundtripTest(encodeProposal, decodeProposal)

test('Proposal roundtrip add', (t) => {
    roundtrip(t, dummyProposalAdd, 'should roundtrip add')
})

test('Proposal roundtrip remove', (t) => {
    roundtrip(t, dummyProposalRemove, 'should roundtrip remove')
})

test('Proposal decode fails on truncated standard proposal body instead of falling back to custom', (t) => {
    const encoded = encodeProposal(dummyProposalRemove)
    // proposalType (3, remove) is a 2-byte uint16, followed by a 4-byte
    // uint32 `removed` field -- truncate the body so it is too short.
    const truncated = encoded.slice(0, encoded.length - 1)
    const decoded = decodeProposal(truncated, 0)
    t.equal(decoded, undefined, 'a malformed standard proposal body should fail to decode')
})

test('Proposal decode still treats genuinely unknown types as custom proposals', (t) => {
    const customProposal:Proposal = {
        proposalType: 999,
        proposalData: new Uint8Array([1, 2, 3]),
    }
    roundtrip(t, customProposal, 'should roundtrip an unknown custom proposal type')
})
