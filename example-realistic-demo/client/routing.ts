import { isValidRoomId } from '../room-logic.js'

/**
 * Where a path points. Pure -- no `location`, no signals -- so the one
 * decision that turns a URL into a screen is unit testable in Node.
 *
 * `gone` rather than `setup` for a bad id is deliberate. An id that
 * cannot name a room must never reach the socket, and quietly showing
 * the create form instead would hide a mistyped invitation behind a
 * screen that looks like it worked.
 */
export type Route =
    | { kind:'setup' }
    | { kind:'room', roomId:string }
    | { kind:'gone' }

export function routeFromPath (pathname:string):Route {
    const path = pathname.split('?')[0].split('#')[0]
    const segment = path.replace(/^\/+/, '').replace(/\/+$/, '')

    if (segment === '') return { kind: 'setup' }
    if (!isValidRoomId(segment)) return { kind: 'gone' }

    return { kind: 'room', roomId: segment }
}

/**
 * The absolute URL people paste to each other. Built from the origin the
 * page was served from, so there is nothing to configure and nothing to
 * get wrong between development and deployment.
 */
export function roomUrl (origin:string, roomId:string):string {
    return `${origin.replace(/\/+$/, '')}/${roomId}`
}
