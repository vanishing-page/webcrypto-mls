import { test } from '@substrate-system/tapzero'
import json from '../../test_vectors/tree-math.json'
import { left, nodeWidth, parent, right, root, sibling, toNodeIndex } from '../../src/treemath.js'
import { InternalError } from '../../src/mlsError.js'

for (const [index, x] of json.entries()) {
    test(`tree math test vectors ${index}`, (t) => {
        treemathTest(t, x)
    })
}

function treemathTest (t: any, data: {
  n_leaves: number
  n_nodes: number
  root: number
  left: (number | null)[]
  right: (number | null)[]
  parent: (number | null)[]
  sibling: (number | null)[]
}) {
    // n_nodes is the number of nodes in the tree with n_leaves leaves
    t.equal(nodeWidth(data.n_leaves), data.n_nodes, 'node width should match expected')
    // root is the root node index of the tree
    t.equal(root(data.n_leaves), data.root, 'root node index should match expected')

    // left[i] is the node index of the left child of the node with index i in a tree with n_leaves leaves
    for (const [i, expected] of data.left.entries()) {
        const leftFn = () => left(toNodeIndex(i))
        if (expected != null) {
            t.equal(leftFn(), expected, `left child of node ${i} should match expected`)
        } else {
            t.throws(leftFn, `left child of node ${i} should throw InternalError`)
        }
    }

    // right[i] is the node index of the right child of the node with index i in a tree with n_leaves leaves
    for (const [i, expected] of data.right.entries()) {
        const rightFn = () => right(toNodeIndex(i))
        if (expected != null) {
            t.equal(rightFn(), expected, `right child of node ${i} should match expected`)
        } else {
            t.throws(rightFn, `right child of node ${i} should throw InternalError`)
        }
    }

    // parent[i] is the node index of the parent of the node with index i in a tree with n_leaves leaves
    for (const [i, expected] of data.parent.entries()) {
        const parentFn = () => parent(toNodeIndex(i), data.n_leaves)
        if (expected != null) {
            t.equal(parentFn(), expected, `parent of node ${i} should match expected`)
        } else {
            t.throws(parentFn, `parent of node ${i} should throw InternalError`)
        }
    }

    // sibling[i] is the node index of the sibling of the node with index i in a tree with n_leaves leaves
    for (const [i, expected] of data.sibling.entries()) {
        const siblingFn = () => sibling(toNodeIndex(i), data.n_leaves)
        if (expected != null) {
            t.equal(siblingFn(), expected, `sibling of node ${i} should match expected`)
        } else {
            t.throws(siblingFn, `sibling of node ${i} should throw InternalError`)
        }
    }
}
