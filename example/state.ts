import { batch, signal, type Signal } from '@preact/signals'
import {
    type KeyPackage,
    type ClientState,
    type CiphersuiteImpl,
    type PrivateKeyPackage,
    generateKeyPackage,
    defaultCapabilities,
    defaultLifetime,
    getCipherSuite,
    processMessage,
    decodeMlsMessage,
    encodeMlsMessage,
    makePskIndex,
    acceptAll,
    createCommit,
    processPublicMessage,
    DEFAULT_CIPHERSUITE
} from '../src/index.js'
import { unprotectPrivateMessage } from '../src/message-protection.js'
import Debug from '@substrate-system/debug'

const debug = Debug(import.meta.env.DEV)

const ciphersuite = DEFAULT_CIPHERSUITE.name

export interface User {
    name:string
    state?:ClientState
    keyPackage?:KeyPackage
    privateKeys?:PrivateKeyPackage
}

export interface Message {
    from:string
    text:string
    ciphertext:Uint8Array // Encrypted message bytes
    epoch:bigint
    timestamp:number
}

type MessageQueue = Array<{
    messageIndex:number;
    ciphertext:Uint8Array;
    epoch:bigint
}>

export function State ():{
    users:Signal<Map<string, User>>;
    messages:Signal<Message[]>;
    ciphersuite:Signal<CiphersuiteImpl | null>;
    groupId:Signal<Uint8Array | null>;
    status:Signal<string>;
    inputMessage:Signal<string>;
    keyPackageInfo:Signal<string>;

    // messageIndex -> decryptedText for each participant
    decryptedMessagesAlice:Signal<Record<number, string>>;
    decryptedMessagesBob:Signal<Record<number, string>>;
    decryptedMessagesCarl:Signal<Record<number, string>>;

    // Message queues for each user (simulating different machines)
    // Each user processes messages independently
    messageQueueAlice:Signal<MessageQueue>;
    messageQueueBob:Signal<MessageQueue>;
    messageQueueCarl:Signal<MessageQueue>;
} {  // eslint-disable-line

    return {
        users: signal(new Map()),
        messages: signal([]),
        ciphersuite: signal(null),
        groupId: signal(null),
        status: signal('Ready to start'),
        inputMessage: signal(''),
        keyPackageInfo: signal(''),
        decryptedMessagesAlice: signal({}),
        decryptedMessagesBob: signal({}),
        decryptedMessagesCarl: signal({}),
        messageQueueAlice: signal([]),
        messageQueueBob: signal([]),
        messageQueueCarl: signal([])
    }
}

State.init = async function (state:ReturnType<typeof State>) {
    // Initialize ciphersuite -- uses the default ciphersuite
    const cs = await getCipherSuite()

    batch(() => {
        state.ciphersuite.value = cs
        state.status.value = 'Initialized with the default ciphersuite ' +
            `(${ciphersuite})`
    })
}

// Create a new user with key package
State.createUser = async function (
    state:ReturnType<typeof State>,
    name:string
) {
    const { ciphersuite, status, users } = state

    if (!ciphersuite.value) {
        status.value = 'Error: Ciphersuite not initialized'
        return
    }

    try {
        status.value = `Creating user: ${name}...`

        const {
            publicPackage: keyPackage,
            privatePackage: privateKeys
        } = await generateKeyPackage(
            {
                credentialType: 'basic',
                identity: new TextEncoder().encode(name)
            },
            defaultCapabilities(),
            defaultLifetime,
            [],
            ciphersuite.value
        )

        batch(() => {
            users.value = new Map(users.value).set(name, {
                name,
                keyPackage,
                privateKeys
            })
            status.value = `Created user: ${name}`
        })
    } catch (err) {
        status.value = `Error creating user: ${err instanceof Error ?
            err.message :
            String(err)
        }`
    }
}

// Remove a user from the group
State.removeUserFromGroup = async function (
    state:ReturnType<typeof State>,
    removerName:string,
    removedUserName:string
) {
    const { ciphersuite, status, users } = state

    if (!ciphersuite.value) {
        status.value = 'Error: Ciphersuite not initialized'
        return
    }

    const remover = users.value.get(removerName)
    const removedUser = users.value.get(removedUserName)

    if (!remover?.state || !removedUser?.state) {
        status.value = 'Error: Users not in group'
        return
    }

    try {
        status.value = `${removerName} removing ${removedUserName} from group...`

        // Get the leaf index of the user to be removed
        const removedLeafIndex = removedUser.state.privatePath.leafIndex

        // Create commit with Remove proposal
        const result = await createCommit(
            { state: remover.state, cipherSuite: ciphersuite.value },
            {
                extraProposals: [
                    {
                        proposalType: 'remove',
                        remove: { removed: removedLeafIndex }
                    }
                ],
                wireAsPublicMessage: true,
                ratchetTreeExtension: true
            }
        )

        // Update remover's state
        users.value = new Map(users.value).set(removerName, {
            ...remover,
            state: result.newState
        })

        // Process commit for all members (including the removed user)
        if (result.commit) {
            const commitBytes = encodeMlsMessage(result.commit)

            for (const [userName, user] of users.value.entries()) {
                if (userName !== removerName && user.state) {
                    try {
                        const decoded = decodeMlsMessage(commitBytes, 0)
                        if (decoded?.[0].wireformat === 'mls_public_message') {
                            const processResult = await processPublicMessage(
                                user.state,
                                decoded[0].publicMessage,
                                makePskIndex(user.state, {}),
                                ciphersuite.value
                            )

                            // If this user was removed, clear their state
                            let updatedUser:User
                            if (userName === removedUserName &&
                                processResult.newState.groupActiveState.kind === 'removedFromGroup') {
                                // Remove the state for the removed user
                                updatedUser = {
                                    name: user.name,
                                    keyPackage: user.keyPackage,
                                    privateKeys: user.privateKeys
                                }
                            } else {
                                // Update state for other users
                                updatedUser = {
                                    ...user,
                                    state: processResult.newState
                                }
                            }

                            users.value = new Map(users.value).set(userName, updatedUser)
                        }
                    } catch (err) {
                        debug(`Error processing commit for ${userName}:`, err)
                    }
                }
            }
        }

        status.value = `${removedUserName} removed from group successfully!`
    } catch (err) {
        status.value = `Error removing user: ${err instanceof Error ?
            err.message :
            String(err)
        }`
    }
}

// Decrypt a message for a specific user
State.decryptMessage = async function (
    state:ReturnType<typeof State>,
    userName:string,
    messageIndex:number
) {
    debug('decrypting message for', userName, 'at index', messageIndex)

    const {
        ciphersuite,
        status,
        users,
        messages,
        decryptedMessagesAlice,
        decryptedMessagesBob,
        decryptedMessagesCarl,
        messageQueueAlice,
        messageQueueBob,
        messageQueueCarl
    } = state

    if (!ciphersuite.value) {
        status.value = 'Error: Ciphersuite not initialized'
        return
    }

    const user = users.value.get(userName)
    if (!user?.state) {
        status.value = `Error: ${userName} not in group`
        return
    }

    const message = messages.value[messageIndex]
    if (!message) {
        status.value = 'Error: Message not found'
        return
    }

    debug('message', message)

    // Get the appropriate signal for this user
    let decryptedMessages:Signal<Record<number, string>>
    if (userName === 'Alice') {
        decryptedMessages = decryptedMessagesAlice
    } else if (userName === 'Bob') {
        decryptedMessages = decryptedMessagesBob
    } else if (userName === 'Carl') {
        decryptedMessages = decryptedMessagesCarl
    } else {
        status.value = `Error: Unknown user ${userName}`
        return
    }

    // Check if already decrypted
    if (decryptedMessages.value[messageIndex] !== undefined) {
        return  // Already decrypted
    }

    // Get the user's message queue
    let messageQueue:Signal<MessageQueue>

    if (userName === 'Alice') {
        messageQueue = messageQueueAlice
    } else if (userName === 'Bob') {
        messageQueue = messageQueueBob
    } else if (userName === 'Carl') {
        messageQueue = messageQueueCarl
    } else {
        status.value = `Error: Unknown user ${userName}`
        return
    }

    // Find the message in the queue
    const queueItem = messageQueue.value.find(item => {
        return item.messageIndex === messageIndex
    })
    if (!queueItem) {
        status.value = `Message not found in ${userName}'s queue`
        return
    }

    try {
        status.value = `Decrypting message for ${userName}...`

        // Decode and process the message from the queue
        const decoded = decodeMlsMessage(queueItem.ciphertext, 0)
        debug('decoded', decoded)

        if (decoded?.[0].wireformat === 'mls_private_message') {
            const privateMessage = decoded[0].privateMessage
            const messageEpoch = privateMessage.epoch
            const currentEpoch = user.state.groupContext.epoch

            debug('Message epoch:', messageEpoch, 'Current epoch:', currentEpoch)

            // Check if message is from a different epoch and if historical data exists
            if (messageEpoch < currentEpoch) {
                const hasHistoricalData = user.state.historicalReceiverData.has(messageEpoch)
                debug('Message from older epoch. Historical data exists:', hasHistoricalData)
                if (!hasHistoricalData) {
                    status.value = `Cannot decrypt: Message is from epoch ${messageEpoch} but user is at epoch ${currentEpoch} and historical receiver data is not available. Historical data is only saved when processing commits.`
                    return
                }
            }

            // Decrypt without updating state (for demo purposes - just decrypt to show the text)
            // We use unprotectPrivateMessage directly instead of processMessage
            // This allows decrypting even after the message was already processed

            let decryptedText = ''

            // Check if message is from current epoch or old epoch
            if (messageEpoch < currentEpoch) {
                // Use historical receiver data for old epoch
                const receiverData = user.state.historicalReceiverData.get(messageEpoch)
                if (!receiverData) {
                    status.value = `Cannot decrypt: Historical receiver data not available for epoch ${messageEpoch}`
                    return
                }

                const result = await unprotectPrivateMessage(
                    receiverData.senderDataSecret,
                    privateMessage,
                    receiverData.secretTree,
                    receiverData.ratchetTree,
                    receiverData.groupContext,
                    user.state.clientConfig.keyRetentionConfig,
                    ciphersuite.value
                )

                if (result.content.content.contentType === 'application') {
                    decryptedText = new TextDecoder().decode(result.content.content.applicationData)
                } else {
                    status.value = 'Error: Message is not an application message'
                    return
                }
            } else {
                // Use current state for current epoch
                // Note: This may fail if the state has already advanced past the message's generation
                try {
                    const result = await unprotectPrivateMessage(
                        user.state.keySchedule.senderDataSecret,
                        privateMessage,
                        user.state.secretTree,
                        user.state.ratchetTree,
                        user.state.groupContext,
                        user.state.clientConfig.keyRetentionConfig,
                        ciphersuite.value
                    )

                    if (result.content.content.contentType === 'application') {
                        decryptedText = new TextDecoder().decode(result.content.content.applicationData)
                    } else {
                        status.value = 'Error: Message is not an application message'
                        return
                    }
                } catch (err) {
                    // If decryption fails because generation is in the past, try to use processMessage
                    // which handles this case better
                    debug('Direct unprotect failed, trying processMessage:', err)
                    const processResult = await processMessage(
                        {
                            wireformat: 'mls_private_message',
                            privateMessage
                        },
                        user.state,
                        makePskIndex(user.state, {}),
                        acceptAll,
                        ciphersuite.value
                    )

                    if (processResult.kind === 'applicationMessage') {
                        decryptedText = new TextDecoder().decode(processResult.message)
                        // Update state since processMessage was used
                        users.value = new Map(users.value).set(userName, { ...user, state: processResult.newState })
                    } else {
                        status.value = 'Error: Message is not an application message'
                        return
                    }
                }
            }

            // Process message to update state (simulating processing on their machine)
            // Do this outside batch since we need await
            let updatedState = user.state
            if (messageEpoch === currentEpoch && user.state) {
                try {
                    // Process message to update state
                    const processResult = await processMessage(
                        {
                            wireformat: 'mls_private_message',
                            privateMessage
                        },
                        user.state,
                        makePskIndex(user.state, {}),
                        acceptAll,
                        ciphersuite.value
                    )

                    if (processResult.kind === 'applicationMessage') {
                        // Update user's state after processing
                        updatedState = processResult.newState
                    }
                } catch (err) {
                    debug('Error processing message for state update:', err)
                    // Continue anyway - we still want to show the decrypted text
                }
            }

            // Store decrypted message and remove from queue
            batch(() => {
                // Update user's state if it changed
                if (updatedState !== user.state) {
                    users.value = new Map(users.value).set(userName, { ...user, state: updatedState })
                }

                // Store decrypted text
                decryptedMessages.value = {
                    ...decryptedMessages.value,
                    [messageIndex]: decryptedText
                }

                // Remove message from queue (processed)
                const updatedQueue = messageQueue.value.filter(item => item.messageIndex !== messageIndex)
                messageQueue.value = updatedQueue

                status.value = `Message decrypted for ${userName}`
            })

            debug('Decrypted message', messageIndex, 'for', userName, ':',
                decryptedText)
            debug('Signal value after update:', decryptedMessages.value)
        } else {
            status.value = 'Error: Message is not a private message'
        }
    } catch (err) {
        debug('error decrypting...', err)
        const errorMessage = err instanceof Error ? err.message : String(err)

        // Provide more helpful error message for common cases
        if (errorMessage.includes('epoch too old') || errorMessage.includes('Cannot process message')) {
            status.value = `Cannot decrypt: ${errorMessage}. This usually means the message is from an older epoch and historical receiver data is not available. Historical data is only preserved when processing commits.`
        } else {
            status.value = `Error decrypting message: ${errorMessage}`
        }
    }
}
