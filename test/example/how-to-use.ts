import { test } from '@substrate-system/tapzero'
import { HowToUse, SETUP_STEPS } from '../../example-shared/how-to-use.js'
import { findByType, findByClass } from './vnode.js'

test('the setup steps are listed in the order they must be done', t => {
    t.deepEqual(
        SETUP_STEPS.map(step => step.id),
        [
            'create-devices',
            'start-group',
            'add-users',
            'select-person',
            'select-device'
        ],
        'should go from creating devices to inspecting one device'
    )
})

test('every setup step says what to do and why', t => {
    for (const step of SETUP_STEPS) {
        t.ok(
            step.title.length > 0,
            `${step.id} should name the action`
        )
        t.ok(
            step.detail.length > 0,
            `${step.id} should explain what it does`
        )
    }
})

test('HowToUse renders one ordered list item per step', t => {
    const tree = HowToUse({ steps: [] }, {})

    t.equal(
        findByClass(tree, 'card instructions').length,
        1,
        'should reuse the shared instructions card'
    )
    t.equal(findByType(tree, 'h2').length, 1, 'should render one heading')
    t.equal(findByType(tree, 'ol').length, 1, 'should render one list')
    t.equal(
        findByType(tree, 'li').length,
        SETUP_STEPS.length,
        'should render an item for each step'
    )
})

test('HowToUse lists the steps it is given, not the default ones', t => {
    // The realistic demo passes its own order. Without this, a card
    // that ignored its prop would still look right on the page it was
    // written for and show the wrong instructions everywhere else.
    const given = [
        { id: 'one', title: 'First', detail: 'Do the first thing.' },
        { id: 'two', title: 'Second', detail: 'Then the second.' }
    ]

    t.equal(
        findByType(HowToUse({ steps: given }, {}), 'li').length,
        given.length,
        'should render an item for each step it was handed'
    )
    t.notEqual(
        given.length,
        SETUP_STEPS.length,
        'and the fixture must differ in length, or this proves nothing'
    )
})
