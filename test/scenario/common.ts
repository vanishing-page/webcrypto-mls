import type { ClientState } from '../../src/client-state.js'
import { makePskIndex } from '../../src/client-state.js'
import { createApplicationMessage } from '../../src/create-message.js'
import { processPrivateMessage } from '../../src/process-messages.js'
import type { CiphersuiteImpl } from '../../src/crypto/ciphersuite.js'
import { UsageError } from '../../src/mls-error.js'

export async function testEveryoneCanMessageEveryone (
    clients:ClientState[],
    impl:CiphersuiteImpl,
    t:any,
):Promise<{ updatedGroups:ClientState[] }> {
    const encoder = new TextEncoder()
    const updatedGroups = [...clients]

    for (const [senderIndex, senderState] of updatedGroups.entries()) {
        const messageText = `Hello from member ${senderIndex}`
        const encodedMessage = encoder.encode(messageText)

        const { privateMessage, newState: newSenderState } =
            await createApplicationMessage(
                senderState,
                encodedMessage,
                impl,
            )
        updatedGroups[senderIndex] = newSenderState

        for (const [receiverIndex, receiverGroup] of updatedGroups.entries()) {
            if (receiverIndex === senderIndex) continue

            const result = await processPrivateMessage(receiverGroup,
                privateMessage, makePskIndex(receiverGroup, {}), impl)

            if (result.kind === 'newState') {
                throw new Error(
                    `Expected application message for member ${receiverIndex} from ${senderIndex}`)
            }

            t.deepEqual(result.message, encodedMessage,
                `Member ${receiverIndex} should receive message from ${senderIndex}`)

            updatedGroups[receiverIndex] = result.newState
        }
    }

    return { updatedGroups }
}

export async function cannotMessageAnymore (
    state:ClientState,
    impl:CiphersuiteImpl,
    t:any
):Promise<void> {
    let errorThrown = false
    try {
        await createApplicationMessage(state,
            new TextEncoder().encode('hello'), impl)
    } catch (error) {
        errorThrown = error instanceof UsageError
    }
    t.ok(errorThrown,
        'Should throw UsageError when trying to send message after leaving')
}

export function shuffledIndices<T> (arr:T[]):number[] {
    const indices = arr.map((_, i) => i)

    for (let i = indices.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
    ;[indices[i], indices[j]!] = [indices[j]!, indices[i]!]
    }

    return indices
}
export function getRandomElement<T> (arr:T[]):T {
    const index = Math.floor(Math.random() * arr.length)
    return arr[index]!
}
