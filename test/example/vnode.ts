import type { VNode } from 'preact'

/**
 * Helpers for asserting on a preact component's structure in the node
 * suite, with no DOM: call the component function directly
 * (`CardHeader(props, {})`) and walk the vnode tree it returns. Assert on
 * structure and props, never on rendered text.
 *
 * The tree is typed `unknown` on the way in on purpose -- a recursive
 * child type plus `.flat(Infinity)` makes tsc report TS2589.
 */

export type Element = VNode<Record<string, unknown>>

export function isVNode (child:unknown):child is Element {
    return (
        typeof child === 'object' &&
        child !== null &&
        !Array.isArray(child) &&
        'type' in child
    )
}

/**
 * A node's children, with the arrays htm produces flattened away.
 */
export function childrenOf (node:Element):unknown[] {
    const out:unknown[] = []

    const push = (kid:unknown) => {
        if (Array.isArray(kid)) return kid.forEach(push)
        out.push(kid)
    }

    push(node.props.children)
    return out
}

/**
 * Every vnode in the tree, depth first, including the root.
 */
export function allNodes (node:unknown, found:Element[] = []):Element[] {
    if (Array.isArray(node)) {
        node.forEach(kid => allNodes(kid, found))
        return found
    }

    if (!isVNode(node)) return found
    found.push(node)
    childrenOf(node).forEach(kid => allNodes(kid, found))
    return found
}

export function findByType (root:unknown, type:string):Element[] {
    return allNodes(root).filter(node => node.type === type)
}

export function findByClass (root:unknown, className:string):Element[] {
    return allNodes(root).filter(node => node.props.class === className)
}

/**
 * Elements carrying `className` among their classes. `findByClass`
 * compares the whole attribute, so it cannot find an element that
 * carries two -- which is what a `.block` that is also the `.you`
 * block does.
 */
export function findByClassToken (
    root:unknown,
    className:string
):Element[] {
    return allNodes(root).filter(node => {
        const classes = node.props.class
        return typeof classes === 'string' &&
            classes.split(' ').includes(className)
    })
}
