import { test } from '@substrate-system/tapzero'
import { DeviceInfoPanel } from '../../example/device-info-panel.js'
import type { DeviceInfo } from '../../example/device-info.js'
import { DEVICES } from '../../example/devices.js'
import { CardHeader } from '../../example-shared/card-header.js'
import { allNodes, findByClass } from './vnode.js'

function outOfGroup ():DeviceInfo {
    return {
        clientId: 'Alice/laptop',
        user: 'Alice',
        device: DEVICES[1],
        created: true,
        inGroup: false,
        leafIndex: null,
        nodeIndex: null,
        epoch: null,
        hpkePublicKeyBase64: null
    }
}

function inGroup ():DeviceInfo {
    return {
        clientId: 'Alice/phone',
        user: 'Alice',
        device: DEVICES[0],
        created: true,
        inGroup: true,
        leafIndex: 2,
        nodeIndex: 4,
        epoch: '5',
        hpkePublicKeyBase64: 'abc123'
    }
}

function render (info:DeviceInfo, onClear:() => void = () => {}):unknown {
    return DeviceInfoPanel({ info, onClear }, {})
}

test('DeviceInfoPanel keeps the card header and its Clear button', t => {
    let cleared = 0
    const tree = render(inGroup(), () => { cleared++ })

    // CardHeader is a component vnode here, not expanded markup -- what
    // this asserts is the contract the panel hands it.
    const headers = allNodes(tree).filter(node => {
        return (node.type as unknown) === CardHeader
    })
    t.equal(headers.length, 1, 'should render one card header')
    t.equal(
        headers[0].props.title,
        'Device Info',
        'the card should be headed Device Info'
    )
    t.equal(
        headers[0].props.showClear,
        true,
        'the Clear button should stay in the header'
    )

    ;(headers[0].props.onClear as () => void)()
    t.equal(cleared, 1, 'clearing from the header should call onClear')
})

test('DeviceInfoPanel shows the identifying facts about a device', t => {
    const tree = render(inGroup())

    t.equal(
        findByClass(tree, 'icon').length,
        1,
        'should show the device icon'
    )
    t.equal(
        findByClass(tree, 'label').length,
        1,
        'should show the device label'
    )
    t.equal(findByClass(tree, 'owner').length, 1, 'should name the owner')
    t.equal(
        findByClass(tree, 'client-id').length,
        1,
        'should show the client id'
    )
    t.equal(
        findByClass(tree, 'membership in-group').length,
        1,
        'should mark it as in the group'
    )
})

test('DeviceInfoPanel shows the group state of an in-group device', t => {
    const tree = render(inGroup())

    for (const key of ['leaf-index', 'node-index', 'epoch', 'pubkey']) {
        t.equal(
            findByClass(tree, key).length,
            1,
            `should show the ${key}`
        )
    }
})

test('DeviceInfoPanel explains a device with no group state', t => {
    const tree = render(outOfGroup())

    t.equal(
        findByClass(tree, 'no-state').length,
        1,
        'should explain why there is nothing to show'
    )

    for (const key of ['leaf-index', 'node-index', 'epoch', 'pubkey']) {
        t.equal(
            findByClass(tree, key).length,
            0,
            `should not claim to know the ${key}`
        )
    }
})

test('DeviceInfoPanel offers a rotate control for an in-group device', t => {
    let rotated = 0
    const tree = DeviceInfoPanel({
        info: inGroup(),
        onClear: () => {},
        onRotate: () => { rotated++ }
    }, {})

    const buttons = findByClass(tree, 'rotate')
    t.equal(buttons.length, 1, 'should render one rotate control')
    t.equal(buttons[0].type, 'button', 'should be a button')

    ;(buttons[0].props.onClick as () => void)()
    t.equal(rotated, 1, 'activating it should call onRotate')
})

test('DeviceInfoPanel disables the rotate control while in flight', t => {
    const tree = DeviceInfoPanel({
        info: inGroup(),
        onClear: () => {},
        onRotate: () => {},
        rotating: true
    }, {})

    t.equal(
        findByClass(tree, 'rotate')[0].props.disabled,
        true,
        'a second click cannot race the commit in flight'
    )
})

test('DeviceInfoPanel offers no rotate control without group state', t => {
    const tree = DeviceInfoPanel({
        info: outOfGroup(),
        onClear: () => {},
        onRotate: () => {}
    }, {})

    t.equal(
        findByClass(tree, 'rotate').length,
        0,
        'a device holding no leaf has nothing to rotate'
    )
})

test('DeviceInfoPanel omits the rotate control with no handler', t => {
    t.equal(
        findByClass(render(inGroup()), 'rotate').length,
        0,
        'the control is opt in, so other pages keep the panel as it was'
    )
})

test('DeviceInfoPanel renders no SVG diagram', t => {
    t.equal(
        allNodes(render(inGroup())).filter(n => n.type === 'svg').length,
        0,
        'the device body replaces the tree rather than joining it'
    )
})

test('DeviceInfoPanel offers a remove control for an in-group device', t => {
    let removed = 0
    const tree = DeviceInfoPanel({
        info: inGroup(),
        onClear: () => {},
        onRemove: () => { removed++ }
    }, {})

    const buttons = findByClass(tree, 'remove')
    t.equal(buttons.length, 1, 'should render one remove control')
    t.equal(buttons[0].type, 'button', 'should be a button')
    t.equal(
        buttons[0].props.disabled,
        false,
        'a removal that can be committed is available'
    )

    ;(buttons[0].props.onClick as () => void)()
    t.equal(removed, 1, 'activating it should call onRemove')
})

test('DeviceInfoPanel disables the remove control while in flight', t => {
    const tree = DeviceInfoPanel({
        info: inGroup(),
        onClear: () => {},
        onRemove: () => {},
        removing: true
    }, {})

    t.equal(
        findByClass(tree, 'remove')[0].props.disabled,
        true,
        'a second click cannot race the commit in flight'
    )
})

test('DeviceInfoPanel explains a removal nobody can commit', t => {
    let removed = 0
    const tree = DeviceInfoPanel({
        info: inGroup(),
        onClear: () => {},
        onRemove: () => { removed++ },
        removeBlocked: true
    }, {})

    const buttons = findByClass(tree, 'remove')
    t.equal(buttons.length, 1, 'the control is still shown')
    t.equal(
        buttons[0].props.disabled,
        true,
        'clicking it would fail, so it is unavailable'
    )
    t.equal(
        findByClass(tree, 'hint blocked').length,
        1,
        'a short explanation stands in for the failing click'
    )
    t.equal(removed, 0, 'nothing was committed')
})

test('DeviceInfoPanel offers no remove control without group state', t => {
    const tree = DeviceInfoPanel({
        info: outOfGroup(),
        onClear: () => {},
        onRemove: () => {}
    }, {})

    t.equal(
        findByClass(tree, 'remove').length,
        0,
        'a device holding no leaf is not in the group to be removed'
    )
})

test('DeviceInfoPanel omits the remove control with no handler', t => {
    t.equal(
        findByClass(render(inGroup()), 'remove').length,
        0,
        'the control is opt in, so other pages keep the panel as it was'
    )
})

test('DeviceInfoPanel offers a persist control for an in-group device', t => {
    let persisted = 0
    const tree = DeviceInfoPanel({
        info: inGroup(),
        onClear: () => {},
        onPersist: () => { persisted++ }
    }, {})

    const buttons = findByClass(tree, 'persist')
    t.equal(buttons.length, 1, 'should render one persist control')
    t.equal(buttons[0].type, 'button', 'should be a button')
    t.equal(
        buttons[0].props.disabled,
        false,
        'a device holding a leaf has state worth saving'
    )

    ;(buttons[0].props.onClick as () => void)()
    t.equal(persisted, 1, 'activating it should call onPersist')
})

test('DeviceInfoPanel disables the persist control while in flight', t => {
    const tree = DeviceInfoPanel({
        info: inGroup(),
        onClear: () => {},
        onPersist: () => {},
        persisting: true
    }, {})

    t.equal(
        findByClass(tree, 'persist')[0].props.disabled,
        true,
        'a second click cannot race the write in flight'
    )
})

test('DeviceInfoPanel marks a device already saved to storage', t => {
    let persisted = 0
    const tree = DeviceInfoPanel({
        info: inGroup(),
        onClear: () => {},
        onPersist: () => { persisted++ },
        persisted: true
    }, {})

    const buttons = findByClass(tree, 'persist')
    t.equal(buttons.length, 1, 'the control is still shown')
    t.equal(
        buttons[0].props.disabled,
        true,
        'there is nothing more to save until the state advances'
    )
    t.equal(persisted, 0, 'nothing was written')
})

test('DeviceInfoPanel offers no persist control without group state', t => {
    const tree = DeviceInfoPanel({
        info: outOfGroup(),
        onClear: () => {},
        onPersist: () => {}
    }, {})

    t.equal(
        findByClass(tree, 'persist').length,
        0,
        'a device holding no leaf has no client state to save'
    )
})

test('DeviceInfoPanel omits the persist control with no handler', t => {
    t.equal(
        findByClass(render(inGroup()), 'persist').length,
        0,
        'the control is opt in, so other pages keep the panel as it was'
    )
})
