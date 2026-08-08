import { test } from '@substrate-system/tapzero'
import { clientId } from '../../example/devices.js'
import { selectUser } from '../../example/user.js'
import {
    userPathNodeIndices,
    userLeafNodeIndices
} from '../../example/user-highlight.js'
import type { DemoUser } from '../../example-shared/demo-user.js'
import type { Node, RatchetTree } from '../../src/ratchet-tree.js'

function fakeLeaf ():Node {
    return { nodeType: 'leaf', leaf: {} } as unknown as Node
}

function fakeParent ():Node {
    return { nodeType: 'parent', parent: {} } as unknown as Node
}

// A 4-leaf tree: leaves at nodes 0, 2, 4, 6.
function fourLeafTree ():RatchetTree {
    return [
        fakeLeaf(), // node 0 - leaf 0
        fakeParent(), // node 1
        fakeLeaf(), // node 2 - leaf 1
        fakeParent(), // node 3 - root
        fakeLeaf(), // node 4 - leaf 2
        fakeParent(), // node 5
        fakeLeaf(), // node 6 - leaf 3
    ]
}

// Only `state.privatePath.leafIndex` is read off a user here, so the
// fixtures fill in just enough to look like an in-group client.
function usersMap (
    entries:[string, number|null][]
):Map<string, DemoUser> {
    return new Map(entries.map(([name, leafIndex]) => [
        name,
        {
            name,
            keyPackage: {},
            state: leafIndex === null ?
                undefined :
                { privatePath: { leafIndex } }
        } as unknown as DemoUser
    ]))
}

test('userPathNodeIndices - one in-group device', (t) => {
    const users = usersMap([
        [clientId('Alice', 'phone'), 0],
        [clientId('Alice', 'laptop'), null],
        [clientId('Alice', 'desktop'), null]
    ])

    const path = userPathNodeIndices(
        fourLeafTree(),
        selectUser('Alice', users),
        users
    )

    t.deepEqual(
        [...path].sort((a, b) => a - b),
        [0, 1, 3],
        'the single leaf contributes its own direct path'
    )
})

test('userPathNodeIndices - unions several leaves', (t) => {
    const users = usersMap([
        [clientId('Alice', 'phone'), 0],
        [clientId('Alice', 'laptop'), 2],
        [clientId('Alice', 'desktop'), null]
    ])

    const path = userPathNodeIndices(
        fourLeafTree(),
        selectUser('Alice', users),
        users
    )

    t.deepEqual(
        [...path].sort((a, b) => a - b),
        [0, 1, 3, 4, 5],
        'both leaves and both of their ancestries are highlighted'
    )
    t.ok(path.has(3), 'the shared root appears once')
})

test('userPathNodeIndices - ignores other people', (t) => {
    const users = usersMap([
        [clientId('Alice', 'phone'), 0],
        [clientId('Bob', 'phone'), 2]
    ])

    const path = userPathNodeIndices(
        fourLeafTree(),
        selectUser('Alice', users),
        users
    )

    t.deepEqual(
        [...path].sort((a, b) => a - b),
        [0, 1, 3],
        "only the named person's leaves are highlighted"
    )
})

test('userPathNodeIndices - nobody in the group is empty', (t) => {
    const users = usersMap([
        [clientId('Alice', 'phone'), null],
        [clientId('Alice', 'laptop'), null],
        [clientId('Alice', 'desktop'), null]
    ])

    const path = userPathNodeIndices(
        fourLeafTree(),
        selectUser('Alice', users),
        users
    )

    t.equal(path.size, 0, 'a person with no in-group device highlights none')
})

test('userPathNodeIndices - empty tree is empty', (t) => {
    const users = usersMap([[clientId('Alice', 'phone'), 0]])

    const path = userPathNodeIndices(
        [],
        selectUser('Alice', users),
        users
    )

    t.equal(path.size, 0, 'no tree means nothing to highlight')
})

test('userLeafNodeIndices - every in-group device, no ancestors', (t) => {
    const users = usersMap([
        [clientId('Alice', 'phone'), 0],
        [clientId('Alice', 'laptop'), 2],
        [clientId('Alice', 'desktop'), 3]
    ])

    const leaves = userLeafNodeIndices(
        fourLeafTree(),
        selectUser('Alice', users),
        users
    )

    t.deepEqual(
        [...leaves].sort((a, b) => a - b),
        [0, 4, 6],
        'one node index per leaf the person holds'
    )
})

test('userLeafNodeIndices - ignores other people', (t) => {
    const users = usersMap([
        [clientId('Alice', 'phone'), 0],
        [clientId('Bob', 'phone'), 2]
    ])

    const leaves = userLeafNodeIndices(
        fourLeafTree(),
        selectUser('Alice', users),
        users
    )

    t.deepEqual([...leaves], [0], "only the named person's leaves")
})

test('userLeafNodeIndices - devices outside the group', (t) => {
    const users = usersMap([
        [clientId('Alice', 'phone'), null],
        [clientId('Alice', 'laptop'), null],
        [clientId('Alice', 'desktop'), null]
    ])

    const leaves = userLeafNodeIndices(
        fourLeafTree(),
        selectUser('Alice', users),
        users
    )

    t.equal(leaves.size, 0, 'a person with no in-group device outlines none')
})

test('userLeafNodeIndices - leaf past the end of the tree', (t) => {
    const users = usersMap([
        [clientId('Alice', 'phone'), 0],
        [clientId('Alice', 'laptop'), 9]
    ])

    const leaves = userLeafNodeIndices(
        fourLeafTree(),
        selectUser('Alice', users),
        users
    )

    t.deepEqual([...leaves], [0], 'an out-of-range leaf is skipped')
})

test('userLeafNodeIndices - empty tree is empty', (t) => {
    const users = usersMap([[clientId('Alice', 'phone'), 0]])

    const leaves = userLeafNodeIndices(
        [],
        selectUser('Alice', users),
        users
    )

    t.equal(leaves.size, 0, 'no tree means nothing to outline')
})
