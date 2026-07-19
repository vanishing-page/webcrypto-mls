import { test } from '@substrate-system/tapzero'
import json from '../../test_vectors/message-protection.json'
import { hexToBytes } from '@noble/ciphers/utils.js'
import type { GroupContext } from '../../src/group-context.js'
import type { SignatureSecretKey } from '../../src/crypto/signature.js'
import type {
    CiphersuiteId,
    CiphersuiteImpl
} from '../../src/crypto/ciphersuite.js'
import {
    getCiphersuiteFromId,
    getCiphersuiteNameFromId,
} from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import { decodeMlsMessage } from '../../src/message.js'
import {
    protect,
    unprotectPrivateMessage,
    protectApplicationData,
    protectProposal
} from '../../src/message-protection.js'
import { createContentCommitSignature } from '../../src/framed-content.js'
import { decodeProposal, encodeProposal } from '../../src/proposal.js'
import { decodeCommit, encodeCommit } from '../../src/commit.js'
import type { AuthenticatedContent } from '../../src/authenticated-content.js'
import { createSecretTree } from '../../src/secret-tree.js'
import {
    protectProposalPublic,
    protectPublicMessage,
    unprotectPublicMessage,
} from '../../src/message-protection-public.js'
import { defaultKeyRetentionConfig } from '../../src/key-retention-config.js'
import { defaultCapabilities } from '../../src/default-capabilities.js'
import type { RatchetTree } from '../../src/ratchet-tree.js'
import { UsageError, ValidationError } from '../../src/mls-error.js'
import { defaultPaddingConfig } from '../../src/padding-config.js'

for (const [index, x] of json.entries()) {
    test(`message-protection test vectors ${index}`, async (t) => {
        try {
            const impl = await getCipherSuite(
                getCiphersuiteFromId(x.cipher_suite as CiphersuiteId)
            )
            await testMessageProtection(t, x, impl)
        } catch (error:any) {
        // Skip ciphersuites not supported in the current
        // environment (e.g., X448/Ed448 in browsers)
            if (error?.name === 'NotSupportedError' ||
                error?.name === 'DependencyError' ||
                error?.name === 'CryptoError' ||
                error?.name === 'DeriveKeyPairError' ||
                error?.message?.includes('SubtleCrypto') ||
                error?.message?.includes('Unrecognized name')) {
                t.comment(`Skipping: ${error.message}`)
                return
            }
            throw error
        }
    })
}

type MessageProtectionData = {
    cipher_suite:number
    group_id:string
    epoch:number
    tree_hash:string
    confirmed_transcript_hash:string
    signature_priv:string
    signature_pub:string
    encryption_secret:string
    sender_data_secret:string
    membership_key:string
    proposal:string
    proposal_priv:string
    proposal_pub:string
    commit:string
    commit_priv:string
    commit_pub:string
    application:string
    application_priv:string
}

async function testMessageProtection (
    t:any,
    data:MessageProtectionData,
    impl:CiphersuiteImpl
) {
    const signKey = await impl.signature.importSignatureKey(
        hexToBytes(data.signature_priv)
    )
    const gc:GroupContext = {
        version: 'mls10',
        cipherSuite: getCiphersuiteNameFromId(
            data.cipher_suite as CiphersuiteId),
        groupId: hexToBytes(data.group_id),
        epoch: BigInt(data.epoch),
        treeHash: hexToBytes(data.tree_hash),
        confirmedTranscriptHash: hexToBytes(
            data.confirmed_transcript_hash),
        extensions: [],
    }

    await publicProposal(t, data, gc, impl)
    await protectThenUnprotectProposalPublic(t, data, gc, impl, signKey)

    await publicCommit(t, data, gc, impl)
    await protectThenUnprotectCommitPublic(t, data, gc, impl, signKey)

    await proposal(t, data, gc, impl)
    await protectThenUnprotectProposal(t, data, gc, impl, signKey)

    await application(t, data, gc, impl)
    await protectThenUnprotectApplication(t, data, gc, impl, signKey)

    await commit(t, data, gc, impl)
    await protectThenUnprotectCommit(t, data, gc, impl, signKey)

    await publicApplicationFails(t, data, gc, impl)

    await applicationWithBlankLeafSenderRejected(t, data, gc, impl, signKey)
}

// need to provide a ratchet tree with non blank leaf node so senderData validation doesn't fail
const treeForLeafIndex1:RatchetTree = [
    undefined,
    undefined,
    {
        nodeType: 'leaf',
        leaf: {
            leafNodeSource: 'commit',
            hpkePublicKey: new Uint8Array(),
            signaturePublicKey: new Uint8Array(),
            capabilities: defaultCapabilities(),
            parentHash: new Uint8Array(),
            extensions: [],
            signature: new Uint8Array(),
            credential: { credentialType: 'basic', identity: new Uint8Array() },
        },
    },
]

async function protectThenUnprotectProposalPublic (
    t:any,
    data:MessageProtectionData,
    gc:GroupContext,
    impl:CiphersuiteImpl,
    signKey:SignatureSecretKey,
) {
    const p = decodeProposal(hexToBytes(data.proposal), 0)
    if (p === undefined) throw new Error('could not decode proposal')

    const prot = await protectProposalPublic(
        signKey,
        hexToBytes(data.membership_key),
        gc,
        new Uint8Array(),
        p[0],
        1,
        impl,
    )

    const unprotected = await unprotectPublicMessage(
        hexToBytes(data.membership_key),
        gc,
        [],
        prot.publicMessage,
        impl,
        hexToBytes(data.signature_pub),
    )

    if (unprotected === undefined || unprotected.content.contentType !== 'proposal') { throw new Error('could not unprotect mls public message') }

    t.deepEqual(encodeProposal(unprotected.content.proposal), hexToBytes(data.proposal), 'proposal should roundtrip correctly')
}

async function protectThenUnprotectCommitPublic (
    t:any,
    data:MessageProtectionData,
    gc:GroupContext,
    impl:CiphersuiteImpl,
    signKey:SignatureSecretKey,
) {
    const c = decodeCommit(hexToBytes(data.commit), 0)
    if (c === undefined) throw new Error('could not decode commit')

    const confirmationTag = crypto.getRandomValues(
        new Uint8Array(impl.hpke.keyLength)
    )

    const { framedContent, signature } = await createContentCommitSignature(
        gc,
        'mls_public_message',
        c[0],
        { leafIndex: 1, senderType: 'member' },
        new Uint8Array(),
        signKey,
        impl.signature,
    )

    const authenticatedContent:AuthenticatedContent = {
        wireformat: 'mls_public_message',
        content: framedContent,
        auth: { contentType: 'commit', signature, confirmationTag },
    }

    const prot = await protectPublicMessage(hexToBytes(data.membership_key), gc, authenticatedContent, impl)

    const unprotected = await unprotectPublicMessage(
        hexToBytes(data.membership_key),
        gc,
        [],
        prot,
        impl,
        hexToBytes(data.signature_pub),
    )

    if (unprotected === undefined || unprotected.content.contentType !== 'commit') { throw new Error('could not unprotect mls public message') }

    t.deepEqual(encodeCommit(unprotected.content.commit), hexToBytes(data.commit), 'commit should roundtrip correctly')
}

async function publicProposal (t:any, data:MessageProtectionData, gc:GroupContext, impl:CiphersuiteImpl) {
    const prop = decodeMlsMessage(hexToBytes(data.proposal_pub), 0)
    if (prop === undefined || prop[0].wireformat !== 'mls_public_message') { throw new Error('could not decode mls public message') }

    const unprotected = await unprotectPublicMessage(
        hexToBytes(data.membership_key),
        gc,
        [],
        prop[0].publicMessage,
        impl,
        hexToBytes(data.signature_pub),
    )

    if (unprotected.content.contentType !== 'proposal') throw new Error('Could not decode as proposal')

    t.deepEqual(encodeProposal(unprotected.content.proposal), hexToBytes(data.proposal), 'public proposal should decode correctly')
}

async function publicCommit (t:any, data:MessageProtectionData, gc:GroupContext, impl:CiphersuiteImpl) {
    const c = decodeMlsMessage(hexToBytes(data.commit_pub), 0)
    if (c === undefined || c[0].wireformat !== 'mls_public_message') { throw new Error('could not decode mls public message') }

    const unprotected = await unprotectPublicMessage(
        hexToBytes(data.membership_key),
        gc,
        [],
        c[0].publicMessage,
        impl,
        hexToBytes(data.signature_pub),
    )

    if (unprotected.content.contentType !== 'commit') throw new Error('Could not decode as commit')

    t.deepEqual(encodeCommit(unprotected.content.commit), hexToBytes(data.commit), 'public commit should decode correctly')
}

async function publicApplicationFails (t:any, data:MessageProtectionData, gc:GroupContext, impl:CiphersuiteImpl) {
    const privateApplication = decodeMlsMessage(hexToBytes(data.application_priv), 0)
    if (privateApplication === undefined || privateApplication[0].wireformat !== 'mls_private_message') { throw new Error('could not decode mls private message') }

    const secretTree = await createSecretTree(2, hexToBytes(data.encryption_secret), impl.kdf)

    const unprotected = await unprotectPrivateMessage(
        hexToBytes(data.sender_data_secret),
        privateApplication[0].privateMessage,
        secretTree,
        treeForLeafIndex1,
        gc,
        defaultKeyRetentionConfig,
        impl,
        hexToBytes(data.signature_pub),
    )

    if (unprotected === undefined || unprotected.content.content.contentType !== 'application') { throw new Error('could not unprotect mls private message') }

    const content:AuthenticatedContent = {
        content: {
            ...unprotected.content.content,
            contentType: 'application',
            groupId: gc.groupId,
            sender: { leafIndex: 0, senderType: 'member' },
            epoch: gc.epoch,
            authenticatedData: new Uint8Array(),
        },
        auth: unprotected.content.auth,
        wireformat: 'mls_public_message',
    }

    try {
        await protectPublicMessage(hexToBytes(data.membership_key), gc, content, impl)
        t.fail('should throw UsageError when protecting application data as public message')
    } catch (err) {
        t.ok(err instanceof UsageError, 'should throw UsageError')
    }
}

async function applicationWithBlankLeafSenderRejected (
    t:any,
    data:MessageProtectionData,
    gc:GroupContext,
    impl:CiphersuiteImpl,
    signKey:SignatureSecretKey,
) {
    const secretTree = await createSecretTree(
        2,
        hexToBytes(data.encryption_secret),
        impl.kdf
    )

    // encrypted for leaf index 1, but the tree below has a blank
    // (undefined) node at that leaf's node index (2), so the sender's
    // leaf is not occupied -- the receiver must reject this message.
    const pro = await protectApplicationData(
        signKey,
        hexToBytes(data.sender_data_secret),
        hexToBytes(data.application),
        new Uint8Array(),
        gc,
        secretTree,
        1,
        defaultPaddingConfig,
        impl,
    )

    const blankLeafTree:RatchetTree = [undefined, undefined, undefined]

    try {
        await unprotectPrivateMessage(
            hexToBytes(data.sender_data_secret),
            pro.privateMessage,
            secretTree,
            blankLeafTree,
            gc,
            defaultKeyRetentionConfig,
            impl,
            hexToBytes(data.signature_pub),
        )
        t.fail('should reject a PrivateMessage whose sender leaf is blank')
    } catch (err:any) {
        t.ok(err instanceof ValidationError, 'should throw ValidationError for blank-leaf sender')
    }
}

async function commit (t:any, data:MessageProtectionData, gc:GroupContext, impl:CiphersuiteImpl) {
    const privateCommit = decodeMlsMessage(hexToBytes(data.commit_priv), 0)
    if (privateCommit === undefined || privateCommit[0].wireformat !== 'mls_private_message') { throw new Error('could not decode mls private message') }

    const secretTree = await createSecretTree(2, hexToBytes(data.encryption_secret), impl.kdf)

    const unprotected = await unprotectPrivateMessage(
        hexToBytes(data.sender_data_secret),
        privateCommit[0].privateMessage,
        secretTree,
        treeForLeafIndex1,
        gc,
        defaultKeyRetentionConfig,
        impl,
        hexToBytes(data.signature_pub),
    )

    if (unprotected === undefined || unprotected.content.content.contentType !== 'commit') { throw new Error('could not unprotect mls private message') }

    t.deepEqual(encodeCommit(unprotected.content.content.commit), hexToBytes(data.commit), 'private commit should decode correctly')
}

async function application (t:any, data:MessageProtectionData, gc:GroupContext, impl:CiphersuiteImpl) {
    const privateApplication = decodeMlsMessage(hexToBytes(data.application_priv), 0)
    if (privateApplication === undefined || privateApplication[0].wireformat !== 'mls_private_message') { throw new Error('could not decode mls private message') }

    const secretTree = await createSecretTree(2, hexToBytes(data.encryption_secret), impl.kdf)

    const unprotected = await unprotectPrivateMessage(
        hexToBytes(data.sender_data_secret),
        privateApplication[0].privateMessage,
        secretTree,
        treeForLeafIndex1,
        gc,
        defaultKeyRetentionConfig,
        impl,
        hexToBytes(data.signature_pub),
    )

    if (unprotected === undefined || unprotected.content.content.contentType !== 'application') { throw new Error('could not unprotect mls private message') }

    t.deepEqual(unprotected.content.content.applicationData, hexToBytes(data.application), 'private application should decode correctly')
}

async function protectThenUnprotectProposal (
    t:any,
    data:MessageProtectionData,
    gc:GroupContext,
    impl:CiphersuiteImpl,
    signKey:SignatureSecretKey,
) {
    const p = decodeProposal(hexToBytes(data.proposal), 0)
    if (p === undefined) throw new Error('could not decode proposal')

    const secretTree = await createSecretTree(
        2,
        hexToBytes(data.encryption_secret),
        impl.kdf
    )

    const pro = await protectProposal(
        signKey,
        hexToBytes(data.sender_data_secret),
        p[0],
        new Uint8Array(),
        gc,
        secretTree,
        1,
        defaultPaddingConfig,
        impl,
    )

    const unprotected = await unprotectPrivateMessage(
        hexToBytes(data.sender_data_secret),
        pro.privateMessage,
        secretTree,
        treeForLeafIndex1,
        gc,
        defaultKeyRetentionConfig,
        impl,
        hexToBytes(data.signature_pub),
    )

    if (unprotected === undefined || unprotected.content.content.contentType !== 'proposal') { throw new Error('could not unprotect mls private message') }

    t.deepEqual(encodeProposal(unprotected.content.content.proposal), hexToBytes(data.proposal), 'proposal should roundtrip through private message protection')
}

async function protectThenUnprotectApplication (
    t:any,
    data:MessageProtectionData,
    gc:GroupContext,
    impl:CiphersuiteImpl,
    signKey:SignatureSecretKey,
) {
    const secretTree = await createSecretTree(
        2,
        hexToBytes(data.encryption_secret),
        impl.kdf
    )

    const pro = await protectApplicationData(
        signKey,
        hexToBytes(data.sender_data_secret),
        hexToBytes(data.application),
        new Uint8Array(),
        gc,
        secretTree,
        1,
        defaultPaddingConfig,
        impl,
    )

    const unprotected = await unprotectPrivateMessage(
        hexToBytes(data.sender_data_secret),
        pro.privateMessage,
        secretTree,
        treeForLeafIndex1,
        gc,
        defaultKeyRetentionConfig,
        impl,
        hexToBytes(data.signature_pub),
    )

    if (unprotected === undefined || unprotected.content.content.contentType !== 'application') { throw new Error('could not unprotect mls private message') }

    t.deepEqual(unprotected.content.content.applicationData, hexToBytes(data.application), 'application data should roundtrip through private message protection')
}

async function protectThenUnprotectCommit (
    t:any,
    data:MessageProtectionData,
    gc:GroupContext,
    impl:CiphersuiteImpl,
    signKey:SignatureSecretKey,
) {
    const c = decodeCommit(hexToBytes(data.commit), 0)
    if (c === undefined) throw new Error('could not decode commit')

    const secretTree = await createSecretTree(
        2,
        hexToBytes(data.encryption_secret),
        impl.kdf
    )

    const confirmationTag = crypto.getRandomValues(
        new Uint8Array(impl.hpke.keyLength)
    )

    const { framedContent, signature } = await createContentCommitSignature(
        gc,
        'mls_private_message',
        c[0],
        { leafIndex: 1, senderType: 'member' },
        new Uint8Array(),
        signKey,
        impl.signature,
    )

    const content = {
        ...framedContent,
        auth: {
            contentType: framedContent.contentType,
            signature,
            confirmationTag,
        },
    }

    const pro = await protect(
        hexToBytes(data.sender_data_secret),
        new Uint8Array(),
        gc,
        secretTree,
        content,
        1,
        defaultPaddingConfig,
        impl,
    )

    const unprotected = await unprotectPrivateMessage(
        hexToBytes(data.sender_data_secret),
        pro.privateMessage,
        secretTree,
        treeForLeafIndex1,
        gc,
        defaultKeyRetentionConfig,
        impl,
        hexToBytes(data.signature_pub),
    )

    if (unprotected === undefined || unprotected.content.content.contentType !== 'commit') { throw new Error('could not unprotect mls private message') }

    t.deepEqual(encodeCommit(unprotected.content.content.commit), hexToBytes(data.commit), 'commit should roundtrip through private message protection')
}

async function proposal (t:any, data:MessageProtectionData, gc:GroupContext, impl:CiphersuiteImpl) {
    const privateProposal = decodeMlsMessage(hexToBytes(data.proposal_priv), 0)
    if (privateProposal === undefined || privateProposal[0].wireformat !== 'mls_private_message') { throw new Error('could not decode mls private message') }

    const secretTree = await createSecretTree(2, hexToBytes(data.encryption_secret), impl.kdf)

    const unprotected = await unprotectPrivateMessage(
        hexToBytes(data.sender_data_secret),
        privateProposal[0].privateMessage,
        secretTree,
        [
            undefined,
            undefined,
            {
                nodeType: 'leaf',
                leaf: {
                    leafNodeSource: 'commit',
                    hpkePublicKey: new Uint8Array(),
                    signaturePublicKey: new Uint8Array(),
                    capabilities: defaultCapabilities(),
                    parentHash: new Uint8Array(),
                    extensions: [],
                    signature: new Uint8Array(),
                    credential: { credentialType: 'basic', identity: new Uint8Array() },
                },
            },
        ],
        gc,
        defaultKeyRetentionConfig,
        impl,
        hexToBytes(data.signature_pub),
    )

    if (unprotected === undefined || unprotected.content.content.contentType !== 'proposal') { throw new Error('could not unprotect mls private message') }

    t.deepEqual(encodeProposal(unprotected.content.content.proposal), hexToBytes(data.proposal), 'private proposal should decode correctly')
}
