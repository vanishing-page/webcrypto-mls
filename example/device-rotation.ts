import { describeClient } from './user.js'

/**
 * Deciding what to say after a device rotates its keys.
 *
 * `rotateKeys` in demo-actions.ts returns void and reports both success
 * and failure through the shared `status` signal, so a page that wants a
 * friendlier line cannot just overwrite it -- a failure would read as a
 * success. What it can do is compare the rotating client's own epoch
 * before and after: only a commit that actually landed advances it.
 *
 * Pure -- no preact, no signals, no DOM -- so it can be unit tested in
 * node.
 */

/**
 * The status line for a rotation by the client named `id`, or null when
 * nothing rotated, in which case the action's own message is the honest
 * one and should be left alone.
 *
 * Both epochs are the rotating client's own: a device with no group
 * state has none, and `rotateKeys` regenerates its key package rather
 * than rotating anything, so that case reports null too.
 */
export function rotationStatus (
    id:string,
    before:bigint|null,
    after:bigint|null
):string|null {
    if (before === null || after === null) return null
    if (after <= before) return null

    return `${describeClient(id)} rotated keys ` +
        `(now Epoch ${after.toString()})`
}
