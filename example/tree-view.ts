import type { Node, RatchetTree } from '../src/ratchet-tree.js'
import { getHpkePublicKey } from '../src/ratchet-tree.js'
import type { LeafIndex, NodeIndex } from '../src/treemath.js'
import { bytesToBase64url } from '../src/util/byte-array.js'
import {
    directPath,
    isLeaf,
    leafToNodeIndex,
    leafWidth,
    left,
    nodeToLeafIndex,
    right,
    root,
    toNodeIndex,
} from '../src/treemath.js'

export type TreeViewNodeKind = 'leaf' | 'parent' | 'blank'

export interface TreeViewNode {
    nodeIndex:number;
    kind:TreeViewNodeKind;
    name?:string;
    left?:TreeViewNode;
    right?:TreeViewNode;
}

/**
 * Pure helper that turns a RatchetTree into a positional model the view
 * can draw without re-deriving any tree index math itself.
 */
export function buildTreeViewModel (
    tree:RatchetTree,
    leafNames:Map<LeafIndex, string>
):TreeViewNode | undefined {
    if (tree.length === 0) return undefined

    const width = leafWidth(tree.length)
    const rootIndex = root(width)

    function build (nodeIndex:NodeIndex):TreeViewNode {
        const node:Node | undefined = tree[nodeIndex]

        if (isLeaf(nodeIndex)) {
            return {
                nodeIndex,
                kind: node === undefined ? 'blank' : 'leaf',
                name: node === undefined ?
                    undefined :
                    leafNames.get(nodeToLeafIndex(nodeIndex)),
            }
        }

        return {
            nodeIndex,
            kind: node === undefined ? 'blank' : 'parent',
            left: build(left(nodeIndex)),
            right: build(right(nodeIndex)),
        }
    }

    return build(toNodeIndex(rootIndex))
}

/**
 * Pure helper: the set of node indices on the direct path from `leafIndex`
 * up to and including the root -- the leaf itself plus every ancestor.
 * Used by the view to highlight a member's update path on hover. Returns an
 * empty set if the tree is empty or the leaf index is out of range.
 */
export function directPathNodeIndices (
    tree:RatchetTree,
    leafIndex:LeafIndex
):Set<number> {
    const result = new Set<number>()
    if (tree.length === 0) return result

    const width = leafWidth(tree.length)
    const leafNode = leafToNodeIndex(leafIndex)
    if (leafNode < 0 || leafNode >= tree.length) return result

    result.add(leafNode)
    for (const ancestor of directPath(leafNode, width)) {
        result.add(ancestor)
    }
    return result
}

export interface PositionedTreeNode {
    nodeIndex:number;
    kind:TreeViewNodeKind;
    name?:string;
    x:number;
    y:number;
}

export interface TreeViewEdge {
    x1:number;
    y1:number;
    x2:number;
    y2:number;
    parentIndex:number;
    childIndex:number;
}

export interface TreeViewLayout {
    nodes:PositionedTreeNode[];
    edges:TreeViewEdge[];
    width:number;
    height:number;
}

export interface TreeViewLayoutOptions {
    nodeSpacing?:number;
    levelHeight?:number;
}

/**
 * Layout options for a group big enough that the defaults stop being
 * readable: 21 members round up to 32 leaf slots, which at the default
 * 60px spacing is a 1860px-wide, five-level diagram. These numbers keep
 * the 14px node circles from touching while roughly halving the width.
 * The caller is responsible for giving the diagram somewhere to scroll.
 */
export const TIGHT_TREE_LAYOUT:TreeViewLayoutOptions = {
    nodeSpacing: 34,
    levelHeight: 48,
}

/**
 * Pure layout pass over a TreeViewNode: assigns each node an (x, y)
 * position (leaves ordered left-to-right, depth increasing downward)
 * and lists the parent/child connectors as line segments. Kept free of
 * DOM/signals so the geometry can be unit tested without a browser --
 * the view is responsible for turning this into SVG.
 */
export function layoutTreeView (
    root:TreeViewNode | undefined,
    options:TreeViewLayoutOptions = {}
):TreeViewLayout {
    const nodeSpacing = options.nodeSpacing ?? 60
    const levelHeight = options.levelHeight ?? 80

    const nodes:PositionedTreeNode[] = []
    const edges:TreeViewEdge[] = []

    if (!root) return { nodes, edges, width: 0, height: 0 }

    let nextLeafSlot = 0

    function place (
        node:TreeViewNode,
        depth:number
    ):PositionedTreeNode {
        const y = depth * levelHeight

        if (!node.left && !node.right) {
            const x = nextLeafSlot * nodeSpacing
            nextLeafSlot += 1
            const positioned:PositionedTreeNode = {
                nodeIndex: node.nodeIndex,
                kind: node.kind,
                name: node.name,
                x,
                y,
            }
            nodes.push(positioned)
            return positioned
        }

        const left = place(node.left!, depth + 1)
        const right = place(node.right!, depth + 1)
        const x = (left.x + right.x) / 2

        const positioned:PositionedTreeNode = {
            nodeIndex: node.nodeIndex,
            kind: node.kind,
            name: node.name,
            x,
            y,
        }
        nodes.push(positioned)

        edges.push({
            x1: x,
            y1: y,
            x2: left.x,
            y2: left.y,
            parentIndex: node.nodeIndex,
            childIndex: left.nodeIndex,
        })
        edges.push({
            x1: x,
            y1: y,
            x2: right.x,
            y2: right.y,
            parentIndex: node.nodeIndex,
            childIndex: right.nodeIndex,
        })

        return positioned
    }

    place(root, 0)

    const width = nextLeafSlot > 0 ? (nextLeafSlot - 1) * nodeSpacing : 0
    const height = nodes.reduce((max, n) => Math.max(max, n.y), 0)

    return { nodes, edges, width, height }
}

/**
 * Pure decision of whether a tree diagram should render at all, and if
 * so, its layout. Returns `null` whenever there's no group yet (or no
 * ratchet tree available for it), so the view can hide the diagram card
 * entirely rather than drawing an empty or broken tree.
 */
export function selectTreeLayout (
    hasGroup:boolean,
    ratchetTree:RatchetTree | undefined,
    leafNames:Map<LeafIndex, string>,
    options?:TreeViewLayoutOptions
):TreeViewLayout | null {
    if (!hasGroup) return null
    if (!ratchetTree) return null

    const model = buildTreeViewModel(ratchetTree, leafNames)
    return layoutTreeView(model, options)
}

/**
 * Number of key changes a self-update (key rotation) by `leafIndex`
 * would cause: the rotator's own leaf plus every ancestor up to the root
 * -- i.e. the size of its direct path. Returns 0 when the tree is empty
 * or the leaf index is out of range.
 */
export function rotationKeyChangeCount (
    tree:RatchetTree,
    leafIndex:LeafIndex
):number {
    return directPathNodeIndices(tree, leafIndex).size
}

export interface SelectedNodeDetails {
    nodeIndex:number;
    kind:TreeViewNodeKind;
    publicKeyBase64:string | null;
    isRoot:boolean;
    nodeJson:string | null;
}

/**
 * Serialize a raw ratchet-tree node to pretty-printed JSON. Nodes hold
 * their key material and signatures as `Uint8Array`, which `JSON.stringify`
 * would otherwise expand into `{ "0": .., "1": .. }`; the replacer renders
 * each byte array as a base64url string to match the public-key display.
 * Lifetime bounds are `bigint`, which `JSON.stringify` cannot serialize at
 * all, so they are rendered as decimal strings.
 */
function nodeToJson (node:Node):string {
    return JSON.stringify(node, (_key, value) => {
        if (value instanceof Uint8Array) return bytesToBase64url(value)
        if (typeof value === 'bigint') return value.toString()
        return value
    }, 2)
}

/**
 * Details for a single tree node the status panel can pin. A populated
 * node (leaf or parent) yields its kind and full base64 HPKE public key;
 * a blank or out-of-range position yields kind 'blank' and a null key so
 * the view can report "no key material". `isRoot` lets the view explain
 * how the root ties to the group's epoch authenticator. `nodeJson` is the
 * full raw node serialized to JSON (byte arrays as base64url) for display,
 * or null for a blank position. The view is responsible for any base64
 * truncation.
 */
export function selectNodeDetails (
    tree:RatchetTree,
    nodeIndex:number
):SelectedNodeDetails {
    const isRoot = tree.length > 0 &&
        nodeIndex === root(leafWidth(tree.length))
    const node = tree[nodeIndex]
    if (node === undefined) {
        return {
            nodeIndex,
            kind: 'blank',
            publicKeyBase64: null,
            isRoot,
            nodeJson: null,
        }
    }
    return {
        nodeIndex,
        kind: node.nodeType,
        publicKeyBase64: bytesToBase64url(getHpkePublicKey(node)),
        isRoot,
        nodeJson: nodeToJson(node),
    }
}
