import type { User } from './state.js'

// Ordered names of users currently in the group (state is set),
// preserving Map insertion order.
export function selectParticipants (
    users:Map<string, User>
):string[] {
    const names:string[] = []
    for (const [name, user] of users.entries()) {
        if (user.state) names.push(name)
    }
    return names
}

// The first user holding group state. Every in-group member shares the
// same epoch, ratchet tree and key schedule, so any one of them stands
// in for the group as a whole.
export function selectGroupUser (
    users:Map<string, User>
):User|undefined {
    for (const user of users.values()) {
        if (user.state) return user
    }
    return undefined
}
