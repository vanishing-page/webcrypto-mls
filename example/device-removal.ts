import { DEVICES, clientId, parseClientId } from './devices.js'
import { describeClient } from './user.js'

/**
 * Choosing who commits the removal of a single device.
 *
 * RFC 9420 does not let a member commit their own removal, so "remove
 * Alice's phone" has to resolve to some *other* client that holds a
 * leaf. The lost-phone story reads best when one of Alice's own devices
 * does the revoking, so a device of the same person is preferred; any
 * other member will do when the person has no second leaf.
 *
 * Pure -- no preact, no signals, no DOM -- so it can be unit tested in
 * node.
 */

/**
 * The client that commits the removal of `target`, or null when the
 * group holds no other leaf to commit from.
 *
 * `inGroup` is every client id currently holding a leaf. The fallback
 * takes the first other id in the order given, so the caller decides
 * what "any other client" means.
 */
export function removalCommitter (
    inGroup:readonly string[],
    target:string
):string|null {
    const others = inGroup.filter(id => id !== target)
    if (others.length === 0) return null

    const parsed = parseClientId(target)
    if (parsed) {
        // The person's own devices first, in DEVICES order rather than
        // in whatever order the group happens to list them.
        for (const device of DEVICES) {
            const id = clientId(parsed.user, device.id)
            if (id !== target && others.includes(id)) return id
        }
    }

    return others[0]
}

/**
 * The status line for a removal committed by `committer` against
 * `target`, or null when nothing was removed, in which case
 * `removeUserFromGroup` has already put the honest reason in `status`.
 *
 * That action returns void and reports both success and failure through
 * the shared signal, so success is read the same way a rotation is: only
 * a commit that actually landed advances the committer's own epoch.
 */
export function removalStatus (
    committer:string,
    target:string,
    before:bigint|null,
    after:bigint|null
):string|null {
    if (before === null || after === null) return null
    if (after <= before) return null

    return `${describeClient(committer)} removed ` +
        `${describeClient(target)} (now Epoch ${after.toString()})`
}
