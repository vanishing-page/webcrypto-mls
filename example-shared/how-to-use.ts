import { type FunctionComponent } from 'preact'
import { html } from 'htm/preact'
import { NBSP } from './constants'

export interface SetupStep {
    id:string;
    title:string;
    detail:string;
}

/**
 * The order the multi-device page has to be driven in. Each step depends
 * on the one above it: there is nothing to start a group with until a
 * person's devices exist, nothing to add until a group exists, and no
 * device to inspect until a person is selected.
 */
export const SETUP_STEPS:SetupStep[] = [
    {
        id: 'create-devices',
        title: 'Create a person\'s devices',
        detail: 'Three clients appear at once -- a phone, a laptop, and ' +
            'a desktop -- each with its own key package and its own ' +
            'signature keypair.'
    },
    {
        id: 'start-group',
        title: 'Start the group as that person',
        detail: 'Their phone creates the group and then adds their laptop ' +
            'and desktop, so one person already occupies three leaves.'
    },
    {
        id: 'add-users',
        title: 'Add another user',
        detail: 'All three of that person\'s devices join in a single ' +
            'commit, and every device in the group moves to the new epoch.'
    },
    {
        id: 'select-person',
        title: 'Select a person',
        detail: 'Their three leaves are highlighted in the ratchet tree. ' +
            'The tree itself has no idea they belong together.'
    },
    {
        id: 'select-device',
        title: 'Select one of their devices',
        detail: 'Its client id, leaf index, and epoch are shown, and it ' +
            'can send, decrypt, rotate, persist, or leave on its own.'
    }
]

/**
 * The setup order for a page, as a numbered list. Kept beside the steps
 * it renders so the list and the explanation of each step cannot drift.
 */
export const HowToUse:FunctionComponent<{ steps:SetupStep[] }> = function ({
    steps
}) {
    const list = steps ?? SETUP_STEPS

    return html`<div class="card instructions">
        <h2>How to use</h2>
        <ol>
            ${list.map(step => html`
                <li key=${step.id}>
                    <strong>${step.title}</strong> ${NBSP} ${step.detail}
                </li>
            `)}
        </ol>
    </div>`
}
