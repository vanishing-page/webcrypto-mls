import { test } from '@substrate-system/tapzero'
import type { Proposal } from '../../src/proposal.js'
import { encodeProposal, decodeProposal } from '../../src/proposal.js'
import { createRoundtripTest } from './roundtrip.js'

const dummyProposalAdd: Proposal = {
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

const dummyProposalRemove: Proposal = {
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
