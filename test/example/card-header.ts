import { test } from '@substrate-system/tapzero'
import { CardHeader } from '../../example-shared/card-header.js'
import { allNodes, childrenOf, findByType } from './vnode.js'

function render (props:Parameters<typeof CardHeader>[0]):unknown {
    return CardHeader(props, {})
}

test('CardHeader renders the title it is given', t => {
    const tree = render({
        title: 'Device Info',
        showClear: false,
        onClear: () => {}
    })

    const headings = findByType(tree, 'h3')
    t.equal(headings.length, 1, 'should render one heading')
    t.deepEqual(
        childrenOf(headings[0]).filter(kid => kid !== undefined),
        ['Device Info'],
        'the heading should show the given title'
    )
})

test('CardHeader hides the Clear button unless asked for it', t => {
    const tree = render({
        title: 'Ratchet Tree',
        showClear: false,
        onClear: () => {}
    })

    t.equal(
        findByType(tree, 'button').length,
        0,
        'should render no button when showClear is false'
    )
})

test('CardHeader shows a Clear button that calls onClear', t => {
    let cleared = 0
    const tree = render({
        title: 'Ratchet Tree',
        showClear: true,
        onClear: () => { cleared++ }
    })

    const buttons = findByType(tree, 'button')
    t.equal(buttons.length, 1, 'should render one button')
    t.equal(
        buttons[0].props.class,
        'clear',
        'the button should keep the `clear` class'
    )
    t.equal(
        buttons[0].props['aria-label'],
        'Clear selection',
        'the button should keep its accessible name'
    )

    const onClick = buttons[0].props.onClick as () => void
    onClick()
    t.equal(cleared, 1, 'clicking should call onClear')
})

test('CardHeader keeps the header wrapper class', t => {
    const tree = render({
        title: 'Ratchet Tree',
        showClear: true,
        onClear: () => {}
    })

    const wrappers = allNodes(tree).filter(node => {
        return node.props.class === 'tree-header'
    })

    t.equal(wrappers.length, 1, 'should render one `tree-header` wrapper')
})
