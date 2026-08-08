import { signal, type Signal } from '@preact/signals'
import Route from 'route-event'
import { createDemoState, type DemoState } from './demo-state.js'
import {
    initCiphersuite,
    createUser as createUserAction,
    decryptMessage as decryptMessageAction,
    removeUserFromGroup as removeUserFromGroupAction,
    rotateKeys as rotateKeysAction
} from './demo-actions.js'
const onRoute = Route()

// Re-exported for callers (example/index.ts) that were importing these
// types from this module before DemoUser moved to example-shared/demo-user.ts
// and the group-messaging state/actions moved to demo-state.ts/demo-actions.ts.
export type { DemoUser as User } from '../example-shared/demo-user.js'
export type { DemoMessage as Message } from './demo-state.js'

export function State ():DemoState & { route:Signal<string> } {
    const state = {
        route: signal<string>(location.pathname),
        ...createDemoState()
    }

    /**
     * set the app state to match the browser URL
     */
    onRoute(async (path:string, data) => {
        state.route.value = path

        // handle scroll state like a web browser
        // (restore scroll position on back/forward)
        if (data.popstate) {
            return window.scrollTo(data.scrollX, data.scrollY)
        }

        // anchor links
        if (path.includes('#')) {
            return setTimeout(() => {  // wait for render
                const el = document.getElementById(path.split('#').pop()!)
                el!.scrollIntoView()
            }, 1)
        }

        // if this was a link click (not back button), then scroll to top
        window.scrollTo(0, 0)
    })

    return state
}

State.init = async function (
    state:ReturnType<typeof State>
):Promise<void> {
    await initCiphersuite(state)
}

// Create a new user with key package
State.createUser = async function (
    state:ReturnType<typeof State>,
    name:string
):Promise<void> {
    await createUserAction(state, name)
}

// Remove a user from the group
State.removeUserFromGroup = async function (
    state:ReturnType<typeof State>,
    removerName:string,
    removedUserName:string
):Promise<void> {
    await removeUserFromGroupAction(state, removerName, removedUserName)
}

// Rotate a user's own keys (MLS self-update via an empty commit)
State.rotateKeys = async function (
    state:ReturnType<typeof State>,
    rotatorName:string
):Promise<void> {
    await rotateKeysAction(state, rotatorName)
}

// Decrypt a message for a specific user
State.decryptMessage = async function (
    state:ReturnType<typeof State>,
    userName:string,
    messageIndex:number
):Promise<void> {
    await decryptMessageAction(state, userName, messageIndex)
}
