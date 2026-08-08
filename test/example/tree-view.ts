import { test } from '@substrate-system/tapzero'
import {
    buildTreeViewModel,
    directPathNodeIndices,
    layoutTreeView,
    rotationKeyChangeCount,
    selectNodeDetails,
    selectTreeLayout,
    TIGHT_TREE_LAYOUT,
} from '../../example/tree-view.js'
import type { Node, RatchetTree } from '../../src/ratchet-tree.js'
import type { LeafIndex } from '../../src/treemath.js'
import { toLeafIndex } from '../../src/treemath.js'
import { bytesToBase64, bytesToBase64url } from '../../src/util/byte-array.js'

function fakeLeaf ():Node {
    return { nodeType: 'leaf', leaf: {} } as unknown as Node
}

function fakeParent ():Node {
    return { nodeType: 'parent', parent: {} } as unknown as Node
}

function leafWithKey (key:Uint8Array):Node {
    return {
        nodeType: 'leaf',
        leaf: { hpkePublicKey: key },
    } as unknown as Node
}

function parentWithKey (key:Uint8Array):Node {
    return {
        nodeType: 'parent',
        parent: { hpkePublicKey: key },
    } as unknown as Node
}

test('buildTreeViewModel - 2-leaf group', (t) => {
    const tree:RatchetTree = [
        fakeLeaf(), // node 0 - leaf 0 (Alice)
        fakeParent(), // node 1 - root
        fakeLeaf(), // node 2 - leaf 1 (Bob)
    ]
    const leafNames = new Map([
        [toLeafIndex(0), 'Alice'],
        [toLeafIndex(1), 'Bob'],
    ])

    const model = buildTreeViewModel(tree, leafNames)

    t.ok(model, 'should return a model')
    t.equal(model!.nodeIndex, 1, 'root is node 1')
    t.equal(model!.kind, 'parent', 'root is a parent node')
    t.equal(model!.left!.nodeIndex, 0, 'left child is node 0')
    t.equal(model!.left!.kind, 'leaf', 'left child is a leaf')
    t.equal(model!.left!.name, 'Alice', 'left leaf is named Alice')
    t.equal(model!.right!.nodeIndex, 2, 'right child is node 2')
    t.equal(model!.right!.kind, 'leaf', 'right child is a leaf')
    t.equal(model!.right!.name, 'Bob', 'right leaf is named Bob')
})

test('buildTreeViewModel - 3-member group (blanks preserved)', (t) => {
    // leafWidth 4 (extended for 3 members), nodeWidth 7, root at node 3
    const tree:RatchetTree = [
        fakeLeaf(), // node 0 - leaf 0 (Alice)
        undefined, // node 1 - blank parent
        fakeLeaf(), // node 2 - leaf 1 (Bob)
        fakeParent(), // node 3 - root
        fakeLeaf(), // node 4 - leaf 2 (Carl)
        fakeParent(), // node 5 - parent
        undefined, // node 6 - leaf 3, blank (no 4th member)
    ]
    const leafNames = new Map([
        [toLeafIndex(0), 'Alice'],
        [toLeafIndex(1), 'Bob'],
        [toLeafIndex(2), 'Carl'],
    ])

    const model = buildTreeViewModel(tree, leafNames)

    t.ok(model, 'should return a model')
    t.equal(model!.nodeIndex, 3, 'root is node 3')
    t.equal(model!.kind, 'parent', 'root is a parent node')

    const leftSubtree = model!.left!
    t.equal(leftSubtree.nodeIndex, 1, 'left subtree root is node 1')
    t.equal(leftSubtree.kind, 'blank', 'node 1 is a blank parent')
    t.equal(leftSubtree.left!.kind, 'leaf', 'node 0 is a leaf')
    t.equal(leftSubtree.left!.name, 'Alice', 'node 0 is named Alice')
    t.equal(leftSubtree.right!.kind, 'leaf', 'node 2 is a leaf')
    t.equal(leftSubtree.right!.name, 'Bob', 'node 2 is named Bob')

    const rightSubtree = model!.right!
    t.equal(rightSubtree.nodeIndex, 5, 'right subtree root is node 5')
    t.equal(rightSubtree.kind, 'parent', 'node 5 is a populated parent')
    t.equal(rightSubtree.left!.kind, 'leaf', 'node 4 is a leaf')
    t.equal(rightSubtree.left!.name, 'Carl', 'node 4 is named Carl')
    t.equal(rightSubtree.right!.kind, 'blank', 'node 6 is a blank leaf')
    t.equal(rightSubtree.right!.name, undefined, 'blank leaf has no name')
})

test('layoutTreeView - 2-leaf group', (t) => {
    const tree:RatchetTree = [
        fakeLeaf(), // node 0 - leaf 0 (Alice)
        fakeParent(), // node 1 - root
        fakeLeaf(), // node 2 - leaf 1 (Bob)
    ]
    const leafNames = new Map([
        [toLeafIndex(0), 'Alice'],
        [toLeafIndex(1), 'Bob'],
    ])
    const model = buildTreeViewModel(tree, leafNames)

    const layout = layoutTreeView(model)

    t.equal(layout.nodes.length, 3, 'positions all 3 nodes')
    t.equal(layout.edges.length, 2, 'draws 2 edges (root to each leaf)')

    const byIndex = new Map(layout.nodes.map((n) => [n.nodeIndex, n]))
    const leftLeaf = byIndex.get(0)!
    const root = byIndex.get(1)!
    const rightLeaf = byIndex.get(2)!

    t.ok(leftLeaf.x < rightLeaf.x, 'left leaf is positioned left of right leaf')
    t.ok(root.y < leftLeaf.y, 'root is positioned above the leaves')
    t.equal(leftLeaf.y, rightLeaf.y, 'leaves share the same depth/row')
    t.equal(leftLeaf.name, 'Alice', 'left leaf carries its name through')
    t.equal(rightLeaf.name, 'Bob', 'right leaf carries its name through')

    for (const edge of layout.edges) {
        t.ok(typeof edge.x1 === 'number', 'edge has numeric x1')
        t.ok(typeof edge.y1 === 'number', 'edge has numeric y1')
        t.ok(typeof edge.x2 === 'number', 'edge has numeric x2')
        t.ok(typeof edge.y2 === 'number', 'edge has numeric y2')
    }
})

test('layoutTreeView - 3-member group (blanks included)', (t) => {
    const tree:RatchetTree = [
        fakeLeaf(), // node 0 - leaf 0 (Alice)
        undefined, // node 1 - blank parent
        fakeLeaf(), // node 2 - leaf 1 (Bob)
        fakeParent(), // node 3 - root
        fakeLeaf(), // node 4 - leaf 2 (Carl)
        fakeParent(), // node 5 - parent
        undefined, // node 6 - leaf 3, blank (no 4th member)
    ]
    const leafNames = new Map([
        [toLeafIndex(0), 'Alice'],
        [toLeafIndex(1), 'Bob'],
        [toLeafIndex(2), 'Carl'],
    ])
    const model = buildTreeViewModel(tree, leafNames)

    const layout = layoutTreeView(model)

    t.equal(layout.nodes.length, 7, 'positions all 7 nodes, blanks included')
    t.equal(layout.edges.length, 6, 'draws one edge per non-root node')

    const byIndex = new Map(layout.nodes.map((n) => [n.nodeIndex, n]))
    const blankParent = byIndex.get(1)!
    const blankLeaf = byIndex.get(6)!

    t.equal(blankParent.kind, 'blank', 'blank parent node keeps its kind')
    t.equal(blankLeaf.kind, 'blank', 'blank leaf node keeps its kind')

    // leaves in in-order (left-to-right) position: 0, 2, 4, 6
    const leafXs = [0, 2, 4, 6].map((idx) => byIndex.get(idx)!.x)
    t.ok(
        leafXs[0] < leafXs[1] && leafXs[1] < leafXs[2] && leafXs[2] < leafXs[3],
        'leaves are ordered left-to-right matching leaf index order'
    )
})

test('selectTreeLayout - no group returns null', (t) => {
    const tree:RatchetTree = [
        fakeLeaf(),
        fakeParent(),
        fakeLeaf(),
    ]
    const leafNames = new Map([
        [toLeafIndex(0), 'Alice'],
        [toLeafIndex(1), 'Bob'],
    ])

    const layout = selectTreeLayout(false, tree, leafNames)

    t.equal(layout, null, 'returns null when there is no group')
})

test('selectTreeLayout - group with no ratchet tree returns null', (t) => {
    const layout = selectTreeLayout(true, undefined, new Map())

    t.equal(layout, null, 'returns null when there is no ratchet tree yet')
})

test('selectTreeLayout - group with a ratchet tree returns a layout', (t) => {
    const tree:RatchetTree = [
        fakeLeaf(),
        fakeParent(),
        fakeLeaf(),
    ]
    const leafNames = new Map([
        [toLeafIndex(0), 'Alice'],
        [toLeafIndex(1), 'Bob'],
    ])

    const layout = selectTreeLayout(true, tree, leafNames)

    t.ok(layout, 'returns a layout')
    t.equal(layout!.nodes.length, 3, 'positions all 3 nodes')
    t.equal(layout!.edges.length, 2, 'draws 2 edges')
})

test('directPathNodeIndices - leaf to root path', (t) => {
    const tree:RatchetTree = [
        fakeLeaf(), // node 0 - leaf 0
        fakeParent(), // node 1
        fakeLeaf(), // node 2 - leaf 1
        fakeParent(), // node 3 - root
        fakeLeaf(), // node 4 - leaf 2
        fakeParent(), // node 5
        fakeLeaf(), // node 6 - leaf 3
    ]

    const alicePath = directPathNodeIndices(tree, toLeafIndex(0))
    t.deepEqual(
        [...alicePath].sort((a, b) => a - b),
        [0, 1, 3],
        'leaf 0 path is nodes 0, 1, 3 (leaf, parent, root)'
    )

    const carlPath = directPathNodeIndices(tree, toLeafIndex(2))
    t.deepEqual(
        [...carlPath].sort((a, b) => a - b),
        [3, 4, 5],
        'leaf 2 path is nodes 4, 5, 3 (leaf, parent, root)'
    )

    t.ok(carlPath.has(3), 'root is always on the path')
})

test('directPathNodeIndices - empty tree is empty set', (t) => {
    const path = directPathNodeIndices([], toLeafIndex(0))
    t.equal(path.size, 0, 'no nodes on the path for an empty tree')
})

test('rotationKeyChangeCount - 2-leaf tree', (t) => {
    const tree:RatchetTree = [
        fakeLeaf(), // node 0 - leaf 0
        fakeParent(), // node 1 - root
        fakeLeaf(), // node 2 - leaf 1
    ]

    const count = rotationKeyChangeCount(tree, toLeafIndex(0))
    t.equal(count, 2, 'leaf 0 rotation affects 2 nodes (leaf 0 + root 1)')
})

test('rotationKeyChangeCount - 4-leaf tree', (t) => {
    const tree:RatchetTree = [
        fakeLeaf(), // node 0 - leaf 0
        fakeParent(), // node 1
        fakeLeaf(), // node 2 - leaf 1
        fakeParent(), // node 3 - root
        fakeLeaf(), // node 4 - leaf 2
        fakeParent(), // node 5
        fakeLeaf(), // node 6 - leaf 3
    ]

    const count = rotationKeyChangeCount(tree, toLeafIndex(0))
    t.equal(count, 3, 'leaf 0 rotation affects 3 nodes (nodes 0, 1, 3)')
})

test('rotationKeyChangeCount - empty tree', (t) => {
    const count = rotationKeyChangeCount([], toLeafIndex(0))
    t.equal(count, 0, 'empty tree has 0 key changes')
})

test('selectNodeDetails - leaf with key', (t) => {
    const keyBytes = new Uint8Array([1, 2, 3])
    const tree:RatchetTree = [leafWithKey(keyBytes)]

    const details = selectNodeDetails(tree, 0)

    t.equal(details.nodeIndex, 0, 'node index is 0')
    t.equal(details.kind, 'leaf', 'kind is leaf')
    t.equal(
        details.publicKeyBase64,
        bytesToBase64(keyBytes),
        'public key is base64 encoded'
    )
})

test('selectNodeDetails - parent with key', (t) => {
    const keyBytes = new Uint8Array([4, 5, 6])
    const tree:RatchetTree = [
        fakeLeaf(),
        parentWithKey(keyBytes),
        fakeLeaf(),
    ]

    const details = selectNodeDetails(tree, 1)

    t.equal(details.nodeIndex, 1, 'node index is 1')
    t.equal(details.kind, 'parent', 'kind is parent')
    t.equal(
        details.publicKeyBase64,
        bytesToBase64(keyBytes),
        'public key is base64 encoded'
    )
})

test('selectNodeDetails - blank node', (t) => {
    const tree:RatchetTree = [fakeLeaf(), undefined, fakeLeaf()]

    const details = selectNodeDetails(tree, 1)

    t.equal(details.nodeIndex, 1, 'node index is 1')
    t.equal(details.kind, 'blank', 'kind is blank')
    t.equal(details.publicKeyBase64, null, 'public key is null')
    t.equal(details.nodeJson, null, 'nodeJson is null for a blank node')
})

test('selectNodeDetails - nodeJson serializes the raw node', (t) => {
    const keyBytes = new Uint8Array([1, 2, 3])
    const tree:RatchetTree = [leafWithKey(keyBytes)]

    const details = selectNodeDetails(tree, 0)

    t.ok(details.nodeJson, 'nodeJson is populated')
    const parsed = JSON.parse(details.nodeJson as string)
    t.equal(parsed.nodeType, 'leaf', 'nodeJson preserves nodeType')
    t.equal(
        parsed.leaf.hpkePublicKey,
        bytesToBase64url(keyBytes),
        'byte arrays are serialized as base64url'
    )
})

test('selectNodeDetails - nodeJson serializes bigint fields', (t) => {
    const leaf = {
        nodeType: 'leaf',
        leaf: { hpkePublicKey: new Uint8Array([1]), notAfter: 42n },
    } as unknown as Node
    const tree:RatchetTree = [leaf]

    const details = selectNodeDetails(tree, 0)

    const parsed = JSON.parse(details.nodeJson as string)
    t.equal(parsed.leaf.notAfter, '42', 'bigint is serialized as a string')
})

test('selectNodeDetails - out of range index', (t) => {
    const tree:RatchetTree = [fakeLeaf()]

    const details = selectNodeDetails(tree, 5)

    t.equal(details.nodeIndex, 5, 'node index is 5')
    t.equal(details.kind, 'blank', 'kind is blank')
    t.equal(details.publicKeyBase64, null, 'public key is null')
})

test('selectNodeDetails - isRoot flags only the root node', (t) => {
    // 4-leaf tree: 7 node slots, root is node 3.
    const k = new Uint8Array([9])
    const tree:RatchetTree = [
        leafWithKey(k), parentWithKey(k), leafWithKey(k), parentWithKey(k),
        leafWithKey(k), parentWithKey(k), leafWithKey(k),
    ]

    t.equal(selectNodeDetails(tree, 3).isRoot, true, 'node 3 is root')
    t.equal(selectNodeDetails(tree, 0).isRoot, false, 'leaf 0 not root')
    t.equal(selectNodeDetails(tree, 1).isRoot, false, 'parent 1 not root')
})

/**
 * A tree with `slots` leaf positions, the first `memberCount` of them
 * occupied and the rest blank -- the shape the multi-device demo hits
 * once seven three-device users are in the group.
 */
function treeWithMembers (memberCount:number, slots:number):RatchetTree {
    const size = (slots * 2) - 1
    const tree:RatchetTree = new Array(size).fill(undefined)

    for (let i = 0; i < size; i++) {
        if (i % 2 === 1) {
            tree[i] = fakeParent()
        } else if (i / 2 < memberCount) {
            tree[i] = fakeLeaf()
        }
    }

    return tree
}

test('TIGHT_TREE_LAYOUT - 21 members in 32 leaf slots', (t) => {
    const tree = treeWithMembers(21, 32)
    const leafNames = new Map<LeafIndex, string>()

    const tight = selectTreeLayout(true, tree, leafNames, TIGHT_TREE_LAYOUT)!
    const leaves = tight.nodes.filter(n => n.nodeIndex % 2 === 0)

    t.equal(leaves.length, 32, 'positions all 32 leaf slots')
    t.equal(
        leaves.filter(n => n.kind === 'blank').length,
        11,
        'the 11 unoccupied slots are still drawn as blanks'
    )
    t.equal(
        leaves.filter(n => n.kind === 'leaf').length,
        21,
        'the 21 members are drawn as leaves'
    )
})

test('TIGHT_TREE_LAYOUT - smaller than the default spacing', (t) => {
    const tree = treeWithMembers(21, 32)
    const leafNames = new Map<LeafIndex, string>()

    const tight = selectTreeLayout(true, tree, leafNames, TIGHT_TREE_LAYOUT)!
    const dflt = selectTreeLayout(true, tree, leafNames)!

    t.ok(
        tight.width < dflt.width,
        'the tight layout is narrower than the default'
    )
    t.ok(
        tight.height < dflt.height,
        'the tight layout is shorter than the default'
    )
    t.equal(
        tight.nodes.length,
        dflt.nodes.length,
        'tightening changes positions only, not which nodes are drawn'
    )
})
