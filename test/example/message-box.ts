import { test } from '@substrate-system/tapzero'
import { PersonMessageBox } from '../../example/message-box.js'
import type { PersonMessageView } from '../../example/message-view.js'
import { DEVICES } from '../../example/devices.js'
import { allNodes, findByClass } from './vnode.js'

/**
 * Alice sent from her phone. Her phone holds the plaintext already, her
 * laptop has the ciphertext queued, and her desktop was never added to
 * the group.
 */
function aliceView ():PersonMessageView {
    return {
        person: 'Alice',
        holdsMessage: true,
        devices: [
            {
                device: DEVICES[0],
                clientId: 'Alice/phone',
                inGroup: true,
                queued: false,
                decrypted: true,
                isSender: true,
                text: 'hello'
            },
            {
                device: DEVICES[1],
                clientId: 'Alice/laptop',
                inGroup: true,
                queued: true,
                decrypted: false,
                isSender: false,
                text: null
            },
            {
                device: DEVICES[2],
                clientId: 'Alice/desktop',
                inGroup: false,
                queued: false,
                decrypted: false,
                isSender: false,
                text: null
            }
        ]
    }
}

function render (props:Partial<Parameters<typeof PersonMessageBox>[0]>) {
    return PersonMessageBox({
        view: aliceView(),
        from: "Alice's Phone 📱",
        epoch: '3',
        ciphertext: 'AAAA',
        expanded: false,
        onExpand: () => {},
        onDecrypt: () => {},
        ...props
    }, {})
}

test('a collapsed box offers one Decrypt button', t => {
    let expanded = 0
    const tree = render({ onExpand: () => { expanded++ } })

    t.equal(
        findByClass(tree, 'ciphertext-section').length,
        1,
        'should show the ciphertext section'
    )

    const buttons = findByClass(tree, 'decrypt-btn expand')
    t.equal(buttons.length, 1, 'should offer a single Decrypt button')
    t.equal(buttons[0].type, 'button', 'should be a button')

    t.equal(
        findByClass(tree, 'device-section').length,
        0,
        'no device is offered until the box is expanded'
    )

    ;(buttons[0].props.onClick as () => void)()
    t.equal(expanded, 1, 'activating it should expand the box')
})

test('an expanded box offers one section per device', t => {
    const tree = render({ expanded: true })

    t.equal(
        findByClass(tree, 'decrypt-btn expand').length,
        0,
        'the single Decrypt button is replaced'
    )
    t.equal(
        findByClass(tree, 'decrypt-with').length,
        1,
        'should label the device list'
    )
    t.equal(
        findByClass(tree, 'device-section').length,
        DEVICES.length,
        'should show one section per device'
    )
    t.equal(
        findByClass(tree, 'device-heading').length,
        DEVICES.length,
        'every section should be headed by its device'
    )
})

test('the sending device is already decrypted', t => {
    const tree = render({ expanded: true })
    const sections = findByClass(tree, 'device-section')

    const phone = allNodes(sections[0])
    t.equal(
        phone.filter(n => n.props.class === 'decrypted-text').length,
        1,
        'the sender composed the plaintext, so it is on show'
    )
    t.equal(
        phone.filter(n => n.props.class === 'decrypt-btn device').length,
        0,
        'there is nothing for the sending client to decrypt'
    )
})

test("the sender's other in-group device must decrypt for itself", t => {
    const decrypted:string[] = []
    const tree = render({
        expanded: true,
        onDecrypt: (id:string) => { decrypted.push(id) }
    })

    const laptop = allNodes(findByClass(tree, 'device-section')[1])
    const buttons = laptop.filter(n => {
        return n.props.class === 'decrypt-btn device'
    })

    t.equal(buttons.length, 1, 'should offer its own Decrypt button')
    t.equal(
        laptop.filter(n => n.props.class === 'decrypted-text').length,
        0,
        'belonging to the sender is no free pass'
    )

    ;(buttons[0].props.onClick as () => void)()
    t.deepEqual(
        decrypted,
        ['Alice/laptop'],
        'should decrypt for that one client'
    )
})

test('a device out of the group is offered no Decrypt button', t => {
    const tree = render({ expanded: true })
    const desktop = allNodes(findByClass(tree, 'device-section')[2])

    t.equal(
        desktop.filter(n => n.props.class === 'decrypt-btn device').length,
        0,
        'a client with no leaf holds no key schedule for this epoch'
    )
    t.equal(
        desktop.filter(n => n.props.class === 'hint not-in-group').length,
        1,
        'a short explanation stands in for the missing button'
    )
})

test('a decrypt in flight cannot be raced', t => {
    const tree = render({ expanded: true, decrypting: 'Alice/laptop' })
    const laptop = allNodes(findByClass(tree, 'device-section')[1])

    t.equal(
        laptop.filter(n => {
            return n.props.class === 'decrypt-btn device'
        })[0].props.disabled,
        true,
        'the button is unavailable while its decrypt is running'
    )
})
