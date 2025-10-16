import { test } from '@substrate-system/tapzero'
import json from '../../test_vectors/messages.json'

import { hexToBytes } from '@noble/ciphers/utils.js'
import { decodeMlsMessage, encodeMlsMessage } from '../../src/message.js'
import { decodeCommit, encodeCommit } from '../../src/commit.js'
import type { Encoder } from '../../src/codec/tlsEncoder.js'
import type { Decoder } from '../../src/codec/tlsDecoder.js'
import {
    decodeAdd,
    decodeExternalInit,
    decodeGroupContextExtensions,
    decodePSK,
    decodeReinit,
    decodeRemove,
    decodeUpdate,
    encodeAdd,
    encodeExternalInit,
    encodeGroupContextExtensions,
    encodePSK,
    encodeReinit,
    encodeRemove,
    encodeUpdate,
} from '../../src/proposal.js'
import { decodeRatchetTree, encodeRatchetTree } from '../../src/ratchetTree.js'
import { decodeGroupSecrets, encodeGroupSecrets } from '../../src/groupSecrets.js'

for (const [index, x] of json.entries()) {
    test(`messages test vectors ${index}`, (t) => {
        codecRoundtrip(t, x)
    })
}

type Messages = {
  mls_welcome: string
  mls_group_info: string
  mls_key_package: string
  ratchet_tree: string
  group_secrets: string
  add_proposal: string
  update_proposal: string
  remove_proposal: string
  pre_shared_key_proposal: string
  re_init_proposal: string
  external_init_proposal: string
  group_context_extensions_proposal: string
  commit: string
  public_message_application: string
  public_message_proposal: string
  public_message_commit: string
  private_message: string
}

function codecRoundtrip (t: any, msgs: Messages) {
    welcome(t, msgs.mls_welcome)
    groupInfo(t, msgs.mls_group_info)
    keyPackage(t, msgs.mls_key_package)
    ratchetTree(t, msgs.ratchet_tree)
    groupSecrets(t, msgs.group_secrets)
    addProposal(t, msgs.add_proposal)
    updateProposal(t, msgs.update_proposal)
    removeProposal(t, msgs.remove_proposal)
    pskProposal(t, msgs.pre_shared_key_proposal)
    reinitProposal(t, msgs.re_init_proposal)
    externalInitProposal(t, msgs.external_init_proposal)
    groupContextExtension(t, msgs.group_context_extensions_proposal)
    commit(t, msgs.commit)
    publicMessageApplication(t, msgs.public_message_application)
    publicMessageCommit(t, msgs.public_message_commit)
    publicMessageProposal(t, msgs.public_message_proposal)
    privateMessage(t, msgs.private_message)
}

function welcome (t: any, s: string) {
    const inputBytes = hexToBytes(s)
    const mlsWelcome = decodeMlsMessage(inputBytes, 0)

    if (mlsWelcome === undefined || mlsWelcome[0].wireformat !== 'mls_welcome') {
        throw new Error('could not decode mls welcome')
    } else {
        const reEncoded = encodeMlsMessage(mlsWelcome[0])
        t.deepEqual(reEncoded, inputBytes, 'mls_welcome should roundtrip correctly')
    }
}

function privateMessage (t: any, s: string) {
    const inputBytes = hexToBytes(s)
    const p = decodeMlsMessage(inputBytes, 0)

    if (p === undefined || p[0].wireformat !== 'mls_private_message') {
        throw new Error('could not decode mls private message')
    } else {
        const reEncoded = encodeMlsMessage(p?.[0])
        t.deepEqual(reEncoded, inputBytes, 'mls_private_message should roundtrip correctly')
    }
}

function groupInfo (t: any, s: string) {
    const inputBytes = hexToBytes(s)
    const gi = decodeMlsMessage(inputBytes, 0)

    if (gi === undefined || gi[0].wireformat !== 'mls_group_info') {
        throw new Error('could not decode mls_group_info')
    } else {
        const reEncoded = encodeMlsMessage(gi[0])
        t.deepEqual(reEncoded, inputBytes, 'mls_group_info should roundtrip correctly')
    }
}

function keyPackage (t: any, s: string) {
    const inputBytes = hexToBytes(s)
    const kp = decodeMlsMessage(inputBytes, 0)

    if (kp === undefined || kp[0].wireformat !== 'mls_key_package') {
        throw new Error('could not decode mls_key_package')
    } else {
        const reEncoded = encodeMlsMessage(kp[0])
        t.deepEqual(reEncoded, inputBytes, 'mls_key_package should roundtrip correctly')
    }
}

function publicMessageApplication (t: any, s: string) {
    const inputBytes = hexToBytes(s)
    const p = decodeMlsMessage(inputBytes, 0)

    if (p === undefined || p[0].wireformat !== 'mls_public_message') {
        throw new Error('could not decode mls_public_message')
    } else {
        t.equal(p[0].publicMessage.content.contentType, 'application', 'content type should be application')
        const reEncoded = encodeMlsMessage(p[0])
        t.deepEqual(reEncoded, inputBytes, 'mls_public_message application should roundtrip correctly')
    }
}

function publicMessageProposal (t: any, s: string) {
    const inputBytes = hexToBytes(s)
    const p = decodeMlsMessage(inputBytes, 0)

    if (p === undefined || p[0].wireformat !== 'mls_public_message') {
        throw new Error('could not decode mls_public_message')
    } else {
        t.equal(p[0].publicMessage.content.contentType, 'proposal', 'content type should be proposal')
        const reEncoded = encodeMlsMessage(p[0])
        t.deepEqual(reEncoded, inputBytes, 'mls_public_message proposal should roundtrip correctly')
    }
}

function publicMessageCommit (t: any, s: string) {
    const inputBytes = hexToBytes(s)
    const p = decodeMlsMessage(inputBytes, 0)

    if (p === undefined || p[0].wireformat !== 'mls_public_message') {
        throw new Error('could not decode mls_public_message')
    } else {
        t.equal(p[0].publicMessage.content.contentType, 'commit', 'content type should be commit')
        const reEncoded = encodeMlsMessage(p[0])
        t.deepEqual(reEncoded, inputBytes, 'mls_public_message commit should roundtrip correctly')
    }
}

// const keyPackage = createTest(encodeKeyPackage, decodeKeyPackage, '')
const commit = createTest(encodeCommit, decodeCommit, 'commit')
const groupSecrets = createTest(encodeGroupSecrets, decodeGroupSecrets, 'group_secrets')
const ratchetTree = createTest(encodeRatchetTree, decodeRatchetTree, 'ratchet_tree')
const updateProposal = createTest(encodeUpdate, decodeUpdate, 'update_proposal')
const addProposal = createTest(encodeAdd, decodeAdd, 'add_proposal')
const pskProposal = createTest(encodePSK, decodePSK, 'pre_shared_key_proposal')
const removeProposal = createTest(encodeRemove, decodeRemove, 'remove_proposal')
const reinitProposal = createTest(encodeReinit, decodeReinit, 're_init_proposal')
const externalInitProposal = createTest(encodeExternalInit, decodeExternalInit, 'external_init_proposal')
const groupContextExtension = createTest(
    encodeGroupContextExtensions,
    decodeGroupContextExtensions,
    'group_context_extensions_proposal',
)

function createTest<T> (enc: Encoder<T>, dec: Decoder<T>, typeName: string): (t: any, s: string) => void {
    return (t, s) => {
        const inputBytes = hexToBytes(s)
        const decoded = dec(inputBytes, 0)

        if (decoded === undefined) {
            throw new Error(`could not decode ${typeName}`)
        } else {
            const reEncoded = enc(decoded[0])
            t.deepEqual(reEncoded, inputBytes, `${typeName} should roundtrip correctly`)
        }
    }
}
