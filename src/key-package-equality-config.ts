import type { KeyPackage } from './key-package.js'
import type { LeafNode } from './leaf-node.js'
import { constantTimeEqual } from './util/constant-time-compare.js'

export interface KeyPackageEqualityConfig {
    compareKeyPackages(a:KeyPackage, b:KeyPackage):boolean
    compareKeyPackageToLeafNode(a:KeyPackage, b:LeafNode):boolean
    /**
     * Whether two leaves belong to the same member. A branch Welcome is
     * accepted only if every leaf of the new group matches a leaf of the
     * old one (RFC 9420 SS11.3). Omitted, it is signature-key equality.
     */
    compareLeafNodes?(a:LeafNode, b:LeafNode):boolean
}

export function sameMemberLeafNodes (
    config:KeyPackageEqualityConfig,
    a:LeafNode,
    b:LeafNode,
):boolean {
    return config.compareLeafNodes ?
        config.compareLeafNodes(a, b) :
        constantTimeEqual(a.signaturePublicKey, b.signaturePublicKey)
}

export const defaultKeyPackageEqualityConfig:KeyPackageEqualityConfig = {
    compareKeyPackages (a, b) {
        return constantTimeEqual(a.leafNode.signaturePublicKey, b.leafNode.signaturePublicKey)
    },
    compareKeyPackageToLeafNode (a, b) {
        return constantTimeEqual(a.leafNode.signaturePublicKey, b.signaturePublicKey)
    },
    compareLeafNodes (a, b) {
        return constantTimeEqual(a.signaturePublicKey, b.signaturePublicKey)
    },
}
