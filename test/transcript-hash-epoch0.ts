import { test } from '@substrate-system/tapzero'
import { getCiphersuiteFromId } from '../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../src/crypto/get-ciphersuite-impl.js'
import { nextEpochContext } from '../src/client-state.js'
import { createConfirmedHash } from '../src/transcript-hash.js'
import type { GroupContext } from '../src/group-context.js'
import type { FramedContentCommit } from '../src/framed-content.js'

const content:FramedContentCommit = {
    groupId: new Uint8Array([1]),
    epoch: 0n,
    sender: { senderType: 'member', leafIndex: 0 },
    authenticatedData: new Uint8Array([2]),
    contentType: 'commit',
    commit: { proposals: [], path: undefined },
}

test('nextEpochContext treats interim_transcript_hash[0] as empty', async (t) => {
    const impl = await getCipherSuite(getCiphersuiteFromId(1))

    const groupContext:GroupContext = {
        version: 'mls10',
        cipherSuite: impl.name,
        groupId: new Uint8Array([1]),
        epoch: 0n,
        treeHash: new Uint8Array([9]),
        confirmedTranscriptHash: new Uint8Array(),
        extensions: [],
    }

    const signature = new Uint8Array([5])
    const confirmationTag = new Uint8Array([6])
    const updatedTreeHash = new Uint8Array([7])

    const updated = await nextEpochContext(
        groupContext,
        'mls_public_message',
        content,
        signature,
        updatedTreeHash,
        confirmationTag,
        impl.hash,
    )

    const expectedConfirmedHash = await createConfirmedHash(
        new Uint8Array(),
        { wireformat: 'mls_public_message', content, signature },
        impl.hash,
    )

    t.deepEqual(
        updated.confirmedTranscriptHash,
        expectedConfirmedHash,
        'confirmed_transcript_hash[1] should be derived from the empty interim_transcript_hash[0]',
    )
})
