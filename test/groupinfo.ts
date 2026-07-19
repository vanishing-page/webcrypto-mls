import { test } from '@substrate-system/tapzero'
import { getCiphersuiteFromId } from '../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../src/crypto/get-ciphersuite-impl.js'
import type { GroupContext } from '../src/group-context.js'
import type { GroupInfoTBS } from '../src/group-info.js'
import { signGroupInfo, verifyGroupInfoSignature } from '../src/group-info.js'
import { ed25519 } from '@noble/curves/ed25519.js'

test('GroupInfo - signs and verifies successfully', async (t) => {
    const privateKey = ed25519.utils.randomSecretKey()
    const publicKey = ed25519.getPublicKey(privateKey)

    const groupContext:GroupContext = {
        version: 'mls10',
        cipherSuite: 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519',
        groupId: new Uint8Array([0x01, 0x02]),
        epoch: BigInt(42),
        treeHash: new Uint8Array([0xaa]),
        confirmedTranscriptHash: new Uint8Array([0xbb]),
        extensions: [{ extensionType: 'application_id', extensionData: new Uint8Array([0x11]) }],
    }

    const baseTBS:GroupInfoTBS = {
        groupContext,
        extensions: [{ extensionType: 'ratchet_tree', extensionData: new Uint8Array([0x22]) }],
        confirmationTag: new Uint8Array([0xcc]),
        signer: 7,
    }

    const cs = await getCipherSuite(getCiphersuiteFromId(1))
    const gi = await signGroupInfo(baseTBS, privateKey, cs.signature)
    const verified = await verifyGroupInfoSignature(gi, publicKey, cs.signature)
    t.equal(verified, true, 'should sign and verify GroupInfo successfully')
})

test('GroupInfo - fails verification if confirmationTag is changed', async (t) => {
    const privateKey = ed25519.utils.randomSecretKey()
    const publicKey = ed25519.getPublicKey(privateKey)

    const groupContext:GroupContext = {
        version: 'mls10',
        cipherSuite: 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519',
        groupId: new Uint8Array([0x01, 0x02]),
        epoch: BigInt(42),
        treeHash: new Uint8Array([0xaa]),
        confirmedTranscriptHash: new Uint8Array([0xbb]),
        extensions: [{ extensionType: 'application_id', extensionData: new Uint8Array([0x11]) }],
    }

    const baseTBS:GroupInfoTBS = {
        groupContext,
        extensions: [{ extensionType: 'ratchet_tree', extensionData: new Uint8Array([0x22]) }],
        confirmationTag: new Uint8Array([0xcc]),
        signer: 7,
    }

    const cs = await getCipherSuite(getCiphersuiteFromId(1))
    const gi = await signGroupInfo(baseTBS, privateKey, cs.signature)
    const modified = { ...gi, confirmationTag: new Uint8Array([0xdd]) }
    const verified = await verifyGroupInfoSignature(modified, publicKey, cs.signature)
    t.equal(verified, false, 'should fail verification if confirmationTag is changed')
})

test('GroupInfo - fails verification if signature is tampered', async (t) => {
    const privateKey = ed25519.utils.randomSecretKey()
    const publicKey = ed25519.getPublicKey(privateKey)

    const groupContext:GroupContext = {
        version: 'mls10',
        cipherSuite: 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519',
        groupId: new Uint8Array([0x01, 0x02]),
        epoch: BigInt(42),
        treeHash: new Uint8Array([0xaa]),
        confirmedTranscriptHash: new Uint8Array([0xbb]),
        extensions: [{ extensionType: 'application_id', extensionData: new Uint8Array([0x11]) }],
    }

    const baseTBS:GroupInfoTBS = {
        groupContext,
        extensions: [{ extensionType: 'ratchet_tree', extensionData: new Uint8Array([0x22]) }],
        confirmationTag: new Uint8Array([0xcc]),
        signer: 7,
    }

    const cs = await getCipherSuite(getCiphersuiteFromId(1))
    const gi = await signGroupInfo(baseTBS, privateKey, cs.signature)
    const tampered = { ...gi, signature: gi.signature.fill(0, 2, 4) }
    const verified = await verifyGroupInfoSignature(tampered, publicKey, cs.signature)
    t.equal(verified, false, 'should fail verification if signature is tampered')
})
