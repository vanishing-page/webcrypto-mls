import type { ClientState } from '../../src/client-state.js'
import { nextEpochContext } from '../../src/client-state.js'
import { createGroupInfoWithRatchetTree } from '../../src/create-commit.js'
import {
    createConfirmationTag,
    createContentCommitSignature,
} from '../../src/framed-content.js'
import {
    protectPublicMessage
} from '../../src/message-protection-public.js'
import type { CiphersuiteImpl } from '../../src/crypto/ciphersuite.js'
import { makeKeyPackageRef, signKeyPackage } from '../../src/key-package.js'
import type {
    KeyPackage,
    PrivateKeyPackage,
} from '../../src/key-package.js'
import { initializeEpoch } from '../../src/key-schedule.js'
import { signLeafNodeKeyPackage } from '../../src/leaf-node.js'
import { addLeafNode } from '../../src/ratchet-tree.js'
import { treeHashRoot } from '../../src/tree-hash.js'
import { encryptGroupInfo, encryptGroupSecrets } from '../../src/welcome.js'
import type { Welcome } from '../../src/welcome.js'
import type { MLSMessage } from '../../src/message.js'

// Forging helpers for receive-side tests: each builds what an honest
// sender would, minus the sender-side check that would refuse it. A
// suite that uses one needs its own honest control (see AGENTS.md).

/**
 * Re-mint a KeyPackage around a chosen leaf encryption key, signed by its
 * own owner, so it fails on the key and not on a signature.
 */
export async function withLeafKey (
    base:KeyPackage,
    priv:PrivateKeyPackage,
    hpkePublicKey:Uint8Array,
    impl:CiphersuiteImpl,
):Promise<KeyPackage> {
    const { signature: _signature, ...tbs } = base.leafNode
    const leafNode = await signLeafNodeKeyPackage(
        {
            ...tbs,
            hpkePublicKey,
            info: { leafNodeSource: 'key_package' },
        },
        priv.signaturePrivateKey,
        impl.signature,
    )
    return signKeyPackage(
        {
            version: base.version,
            cipherSuite: base.cipherSuite,
            initKey: base.initKey,
            leafNode,
            extensions: base.extensions,
        },
        priv.signaturePrivateKey,
        impl.signature,
    )
}

/**
 * An Add-only commit of `keyPackages` from `state`, and its Welcome, built
 * the way createCommit built them before it validated a leaf's encryption
 * key: the tree, the epoch and every signature and tag are consistent, so
 * the only thing wrong with them is the key.
 */
export async function forgeAddCommit (
    state:ClientState,
    keyPackages:KeyPackage[],
    impl:CiphersuiteImpl,
):Promise<{ commit:MLSMessage; welcome:Welcome }> {
    let tree = state.ratchetTree
    for (const kp of keyPackages) {
        [tree] = addLeafNode(tree, kp.leafNode)
    }

    const { signature, framedContent } = await createContentCommitSignature(
        state.groupContext,
        'mls_public_message',
        {
            proposals: keyPackages.map((keyPackage) => ({
                proposalOrRefType: 'proposal' as const,
                proposal: { proposalType: 'add', add: { keyPackage } },
            })),
            path: undefined,
        },
        { senderType: 'member', leafIndex: state.privatePath.leafIndex },
        new Uint8Array(),
        state.signaturePrivateKey,
        impl.signature,
    )
    const groupContext = await nextEpochContext(
        state.groupContext,
        'mls_public_message',
        framedContent,
        signature,
        await treeHashRoot(tree, impl.hash),
        state.confirmationTag,
        impl.hash,
    )
    // no path and no PSKs: both secrets are all-zero
    const epoch = await initializeEpoch(
        state.keySchedule.initSecret,
        new Uint8Array(impl.kdf.size),
        groupContext,
        new Uint8Array(impl.kdf.size),
        impl.kdf,
    )
    const confirmationTag = await createConfirmationTag(
        epoch.keySchedule.confirmationKey,
        groupContext.confirmedTranscriptHash,
        impl.hash,
    )
    const publicMessage = await protectPublicMessage(
        state.keySchedule.membershipKey,
        state.groupContext,
        {
            wireformat: 'mls_public_message',
            content: framedContent,
            auth: { contentType: 'commit', signature, confirmationTag },
        },
        impl,
    )

    const groupInfo = await createGroupInfoWithRatchetTree(groupContext,
        confirmationTag, state, tree, [], impl)
    const encryptedGroupInfo = await encryptGroupInfo(groupInfo,
        epoch.welcomeSecret, impl)
    const secrets = await Promise.all(keyPackages.map(async (kp) => {
        const egs = await encryptGroupSecrets(
            await impl.hpke.importPublicKey(kp.initKey),
            encryptedGroupInfo,
            {
                joinerSecret: epoch.joinerSecret,
                pathSecret: undefined,
                psks: [],
            },
            impl.hpke,
        )
        return {
            newMember: await makeKeyPackageRef(kp, impl.hash),
            encryptedGroupSecrets: { kemOutput: egs.enc, ciphertext: egs.ct },
        }
    }))

    return {
        commit: {
            wireformat: 'mls_public_message',
            version: 'mls10',
            publicMessage,
        },
        welcome: {
            cipherSuite: groupContext.cipherSuite,
            secrets,
            encryptedGroupInfo,
        },
    }
}
