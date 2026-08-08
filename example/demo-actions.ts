import { batch } from '@preact/signals'
import {
    type ClientState,
    generateKeyPackage,
    defaultCapabilities,
    defaultLifetime,
    getCipherSuite,
    processMessage,
    decodeMlsMessage,
    encodeMlsMessage,
    makePskIndex,
    acceptAll,
    createGroup,
    createCommit,
    createApplicationMessage,
    processPublicMessage,
    joinGroup,
    bytesToBase64url,
    DEFAULT_CIPHERSUITE
} from '../src/index.js'
import { unprotectPrivateMessage } from '../src/message-protection.js'
import type { DemoState } from './demo-state.js'
import type { DemoUser } from '../example-shared/demo-user.js'

/**
 * Group-messaging actions (create user, start group, add member, send
 * message, decrypt) shared by the main demo (example/state.ts) and the
 * persistence demo (example/persistence-demo.ts), operating on any
 * `DemoState` rather than a specific page's signals.
 */

export async function initCiphersuite (state:DemoState):Promise<void> {
    const cs = await getCipherSuite()

    batch(() => {
        state.ciphersuite.value = cs
        state.status.value = 'Initialized with the default ciphersuite ' +
            `(${DEFAULT_CIPHERSUITE.name})`
    })
}

export async function createUser (
    state:DemoState,
    name:string,
    options?:{ signatureKeyPair?:CryptoKeyPair }
):Promise<void> {
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
            defaultLifetime(),
            [],
            ciphersuite.value,
            options
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

// Create a new MLS group with the first user
export async function createMLSGroup (
    state:DemoState,
    creatorName:string
):Promise<void> {
    const { ciphersuite, status, users, groupId } = state

    if (!ciphersuite.value) {
        status.value = 'Error: Ciphersuite not initialized'
        return
    }

    const creator = users.value.get(creatorName)
    if (!creator?.keyPackage || !creator?.privateKeys) {
        status.value = 'Error: User not found or incomplete'
        return
    }

    try {
        status.value = `Creating MLS group for ${creatorName}...`

        const newGroupId = ciphersuite.value.rng.randomBytes(32)
        const groupState = await createGroup(
            newGroupId,
            creator.keyPackage,
            creator.privateKeys,
            [],
            ciphersuite.value
        )

        batch(() => {
            users.value = new Map(users.value).set(creatorName, {
                ...creator,
                state: groupState
            })
            groupId.value = newGroupId
        })
        status.value = 'MLS group created. Group ID:' +
            `${bytesToBase64url(newGroupId).slice(0, 16)}...`
    } catch (err) {
        status.value = 'Error creating group: ' +
            `${err instanceof Error ? err.message : String(err)}`
    }
}

// Add a user to the group
export async function addUserToGroup (
    state:DemoState,
    adderName:string,
    newMemberName:string
):Promise<void> {
    const { ciphersuite, status, users } = state

    if (!ciphersuite.value) {
        status.value = 'Error: Ciphersuite not initialized'
        return
    }

    const adder = users.value.get(adderName)
    const newMember = users.value.get(newMemberName)

    if (!adder?.state || !newMember?.keyPackage) {
        status.value = 'Error: Users not ready'
        return
    }

    try {
        status.value = `Adding ${newMemberName} to group...`

        const result = await createCommit(
            { state: adder.state, cipherSuite: ciphersuite.value },
            {
                extraProposals: [
                    {
                        proposalType: 'add',
                        add: { keyPackage: newMember.keyPackage }
                    }
                ],
                wireAsPublicMessage: true,
                ratchetTreeExtension: true
            }
        )

        users.value = new Map(users.value).set(adderName, {
            ...adder,
            state: result.newState
        })

        if (result.welcome && newMember.privateKeys) {
            const newMemberState = await joinGroup(
                result.welcome,
                newMember.keyPackage,
                newMember.privateKeys,
                makePskIndex(undefined, {}),
                ciphersuite.value
            )
            users.value = new Map(users.value).set(newMemberName, {
                ...newMember,
                state: newMemberState
            })
        }

        if (result.commit) {
            const commitBytes = encodeMlsMessage(result.commit)

            for (const [userName, user] of users.value.entries()) {
                if (
                    userName !== adderName &&
                    userName !== newMemberName &&
                    user.state
                ) {
                    try {
                        const decoded = decodeMlsMessage(commitBytes, 0)
                        const decodedMessage = decoded?.[0]
                        if (
                            decodedMessage?.wireformat ===
                            'mls_public_message'
                        ) {
                            const processResult = await processPublicMessage(
                                user.state,
                                decodedMessage.publicMessage,
                                makePskIndex(user.state, {}),
                                ciphersuite.value
                            )
                            users.value = new Map(users.value).set(
                                userName,
                                { ...user, state: processResult.newState }
                            )
                        }
                    } catch {
                        // Best-effort: simulates each member's own machine
                        // independently processing the commit.
                    }
                }
            }
        }

        status.value = `${newMemberName} added to group successfully!`
    } catch (err) {
        status.value = 'Error adding user: ' +
            `${err instanceof Error ? err.message : String(err)}`
    }
}

// Send an application message
export async function sendMessage (
    state:DemoState,
    senderName:string,
    text:string
):Promise<void> {
    const {
        ciphersuite, status, users, messages,
        decryptedMessages, messageQueues
    } = state

    if (!ciphersuite.value) {
        status.value = 'Error: Ciphersuite not initialized'
        return
    }

    const sender = users.value.get(senderName)
    if (!sender?.state) {
        status.value = 'Error: Sender not in group'
        return
    }

    try {
        const messageBytes = new TextEncoder().encode(text)
        const result = await createApplicationMessage(
            sender.state,
            messageBytes,
            ciphersuite.value,
            new Uint8Array(0)  // authenticated data
        )

        const encoded = encodeMlsMessage({
            wireformat: 'mls_private_message',
            version: 'mls10',
            privateMessage: result.privateMessage
        })

        users.value = new Map(users.value).set(senderName, {
            ...sender,
            state: result.newState
        })

        const messageIndex = messages.value.length
        messages.value = [...messages.value, {
            from: senderName,
            text,
            ciphertext: encoded,
            epoch: result.newState.groupContext.epoch,
            timestamp: Date.now()
        }]

        let nextDecrypted = decryptedMessages.value
        let nextQueues = messageQueues.value

        for (const [userName, user] of users.value.entries()) {
            if (!user.state) continue

            if (userName === senderName) {
                nextDecrypted = {
                    ...nextDecrypted,
                    [userName]: {
                        ...(nextDecrypted[userName] || {}),
                        [messageIndex]: text
                    }
                }
            } else {
                const queueItem = {
                    messageIndex,
                    ciphertext: encoded,
                    epoch: result.newState.groupContext.epoch
                }
                nextQueues = {
                    ...nextQueues,
                    [userName]: [
                        ...(nextQueues[userName] || []),
                        queueItem
                    ]
                }
            }
        }

        batch(() => {
            decryptedMessages.value = nextDecrypted
            messageQueues.value = nextQueues
        })

        status.value = `Message sent from ${senderName}`
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        status.value = `Error sending message: ${message}`
    }
}

// Remove a user from the group
export async function removeUserFromGroup (
    state:DemoState,
    removerName:string,
    removedUserName:string
):Promise<void> {
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
        status.value = `${removerName} removing ${removedUserName} ` +
            'from group...'

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
                            let updatedUser
                            if (userName === removedUserName &&
                                processResult.newState.groupActiveState
                                    .kind === 'removedFromGroup') {
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

                            users.value = new Map(users.value)
                                .set(userName, updatedUser)
                        }
                    } catch {
                        // Best-effort: simulates each member's own machine
                        // independently processing the commit.
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

/**
 * Deliver one commit to every member that did not issue it. `skip`
 * names the clients already updated by the committer's own path
 * (the committer, and any joiner that processed the Welcome instead).
 *
 * Returns a new users map. Processing is best-effort per member, which
 * simulates each machine handling the commit on its own.
 */
async function deliverCommit (
    state:DemoState,
    users:Map<string, DemoUser>,
    commitBytes:Uint8Array,
    skip:Set<string>
):Promise<Map<string, DemoUser>> {
    const { ciphersuite } = state
    if (!ciphersuite.value) return users

    let next = users

    for (const [name, user] of users.entries()) {
        if (skip.has(name) || !user.state) continue

        try {
            const decoded = decodeMlsMessage(commitBytes, 0)
            const message = decoded?.[0]
            if (message?.wireformat !== 'mls_public_message') continue

            const result = await processPublicMessage(
                user.state,
                message.publicMessage,
                makePskIndex(user.state, {}),
                ciphersuite.value
            )

            // A member removed by this commit keeps its key package but
            // loses its leaf, so it drops back to "created, not in the
            // group" -- the same shape createUser leaves behind.
            const removed = result.newState.groupActiveState.kind ===
                'removedFromGroup'

            next = new Map(next).set(name, removed ?
                {
                    name: user.name,
                    keyPackage: user.keyPackage,
                    privateKeys: user.privateKeys
                } :
                { ...user, state: result.newState })
        } catch {
            // Best-effort: simulates each member's own machine
            // independently processing the commit.
        }
    }

    return next
}

/**
 * Add several clients to the group with a *single* commit carrying one
 * add proposal each, so the epoch advances once no matter how many
 * clients arrive. The multi-device demo uses this to seat a person's
 * whole set of devices -- three separate MLS clients -- in one step.
 */
export async function addUsersToGroup (
    state:DemoState,
    adderName:string,
    newMemberNames:string[]
):Promise<boolean> {
    const { ciphersuite, status, users } = state

    if (!ciphersuite.value) {
        status.value = 'Error: Ciphersuite not initialized'
        return false
    }

    const adder = users.value.get(adderName)

    const targets = newMemberNames.flatMap((name) => {
        const user = users.value.get(name)
        if (!user?.keyPackage) return []
        return [{ name, user, keyPackage: user.keyPackage }]
    })

    if (
        !adder?.state ||
        targets.length === 0 ||
        targets.length !== newMemberNames.length
    ) {
        status.value = 'Error: Users not ready'
        return false
    }

    try {
        status.value = `Adding ${targets.length} clients to group...`

        const result = await createCommit(
            { state: adder.state, cipherSuite: ciphersuite.value },
            {
                extraProposals: targets.map(target => ({
                    proposalType: 'add' as const,
                    add: { keyPackage: target.keyPackage }
                })),
                wireAsPublicMessage: true,
                ratchetTreeExtension: true
            }
        )

        let next = new Map(users.value).set(adderName, {
            ...adder,
            state: result.newState
        })

        // One Welcome covers every joiner: each decrypts its own group
        // secrets with its own key package reference.
        const joined = new Set<string>([adderName])

        if (result.welcome) {
            for (const target of targets) {
                const { privateKeys } = target.user
                if (!privateKeys) continue

                const joinedState = await joinGroup(
                    result.welcome,
                    target.keyPackage,
                    privateKeys,
                    makePskIndex(undefined, {}),
                    ciphersuite.value
                )

                next = new Map(next).set(target.name, {
                    ...target.user,
                    state: joinedState
                })
                joined.add(target.name)
            }
        }

        if (result.commit) {
            next = await deliverCommit(
                state,
                next,
                encodeMlsMessage(result.commit),
                joined
            )
        }

        users.value = next
        status.value = `${targets.length} clients added in one commit`
        return true
    } catch (err) {
        status.value = 'Error adding clients: ' +
            `${err instanceof Error ? err.message : String(err)}`
        return false
    }
}

/**
 * Remove several clients from the group with a *single* commit carrying
 * one remove proposal each, so the epoch advances once. The committer
 * must not be among the removed clients -- RFC 9420 forbids a commit
 * that removes its own sender.
 */
export async function removeUsersFromGroup (
    state:DemoState,
    removerName:string,
    removedNames:string[]
):Promise<boolean> {
    const { ciphersuite, status, users } = state

    if (!ciphersuite.value) {
        status.value = 'Error: Ciphersuite not initialized'
        return false
    }

    const remover = users.value.get(removerName)

    const targets = removedNames.flatMap((name) => {
        const user = users.value.get(name)
        if (!user?.state) return []
        return [{ name, leafIndex: user.state.privatePath.leafIndex }]
    })

    if (
        !remover?.state ||
        targets.length === 0 ||
        targets.length !== removedNames.length ||
        removedNames.includes(removerName)
    ) {
        status.value = 'Error: Users not in group'
        return false
    }

    try {
        status.value = `${removerName} removing ` +
            `${targets.length} clients from group...`

        const result = await createCommit(
            { state: remover.state, cipherSuite: ciphersuite.value },
            {
                extraProposals: targets.map(target => ({
                    proposalType: 'remove' as const,
                    remove: { removed: target.leafIndex }
                })),
                wireAsPublicMessage: true,
                ratchetTreeExtension: true
            }
        )

        let next = new Map(users.value).set(removerName, {
            ...remover,
            state: result.newState
        })

        if (result.commit) {
            next = await deliverCommit(
                state,
                next,
                encodeMlsMessage(result.commit),
                new Set([removerName])
            )
        }

        users.value = next
        status.value = `${targets.length} clients removed in one commit`
        return true
    } catch (err) {
        status.value = `Error removing clients: ${err instanceof Error ?
            err.message :
            String(err)
        }`
        return false
    }
}

/**
 * Rotate a member's own keys (MLS self-update via an empty commit).
 *
 * A member who is not yet in the group has no leaf to rotate, so their
 * key package is regenerated instead. `options.createUser` supplies
 * that regeneration -- the persistence demo passes its non-extractable
 * keypair generator, so a rotation there never downgrades a member to
 * an extractable identity.
 */
export async function rotateKeys (
    state:DemoState,
    rotatorName:string,
    options?:{ createUser?:(name:string) => Promise<void> }
):Promise<void> {
    const { ciphersuite, status, users } = state

    if (!ciphersuite.value) {
        status.value = 'Error: Ciphersuite not initialized'
        return
    }

    const rotator = users.value.get(rotatorName)

    if (!rotator) {
        status.value = `Error: ${rotatorName} not created`
        return
    }

    if (!rotator.state) {
        const create = options?.createUser ??
            ((name:string) => createUser(state, name))

        try {
            await create(rotatorName)
        } catch (err) {
            status.value = `Error rotating key package: ${err instanceof Error ?
                err.message :
                String(err)
            }`
            return
        }

        // A replaced map entry means regeneration succeeded. On
        // failure the creator reports into `status` and leaves the
        // entry alone, so do not overwrite that message.
        if (users.value.get(rotatorName) !== rotator) {
            status.value = `${rotatorName} rotated key package`
        }

        return
    }

    try {
        status.value = `${rotatorName} rotating keys...`

        // Empty proposal list -> createCommit forces an UpdatePath,
        // rotating the committer's leaf key and advancing the epoch.
        const result = await createCommit(
            { state: rotator.state, cipherSuite: ciphersuite.value },
            {
                extraProposals: [],
                wireAsPublicMessage: true,
                ratchetTreeExtension: true
            }
        )

        users.value = new Map(users.value).set(rotatorName, {
            ...rotator,
            state: result.newState
        })

        // Broadcast the commit to every other in-group member
        if (result.commit) {
            const commitBytes = encodeMlsMessage(result.commit)

            for (const [userName, user] of users.value.entries()) {
                if (userName === rotatorName || !user.state) continue

                try {
                    const decoded = decodeMlsMessage(commitBytes, 0)
                    if (decoded?.[0].wireformat === 'mls_public_message') {
                        const processResult = await processPublicMessage(
                            user.state,
                            decoded[0].publicMessage,
                            makePskIndex(user.state, {}),
                            ciphersuite.value
                        )
                        users.value = new Map(users.value).set(userName, {
                            ...user,
                            state: processResult.newState
                        })
                    }
                } catch {
                    // Best-effort: simulates each member's own machine
                    // independently processing the commit. On persistence
                    // pages, a silent failure here means the member's saved
                    // record stays at the old epoch, then
                    // syncPersistedMembers() immediately writes it again,
                    // creating a stale indexedDB record.
                }
            }
        }

        const newEpoch = result.newState.groupContext.epoch
        status.value = `${rotatorName} rotated keys ` +
            `(now Epoch ${newEpoch.toString()})`
    } catch (err) {
        status.value = `Error rotating keys: ${err instanceof Error ?
            err.message :
            String(err)
        }`
    }
}

// Decrypt a message for a specific user
export async function decryptMessage (
    state:DemoState,
    userName:string,
    messageIndex:number
):Promise<void> {
    const {
        ciphersuite,
        status,
        users,
        messages,
        decryptedMessages,
        messageQueues
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

    const userDecrypted = decryptedMessages.value[userName] || {}
    if (userDecrypted[messageIndex] !== undefined) {
        return  // Already decrypted
    }

    const userQueue = messageQueues.value[userName] || []
    const queueItem = userQueue.find(item => {
        return item.messageIndex === messageIndex
    })
    if (!queueItem) {
        status.value = `Message not found in ${userName}'s queue`
        return
    }

    try {
        status.value = `Decrypting message for ${userName}...`

        const decoded = decodeMlsMessage(queueItem.ciphertext, 0)

        if (decoded?.[0].wireformat === 'mls_private_message') {
            const privateMessage = decoded[0].privateMessage
            const messageEpoch = privateMessage.epoch
            const currentEpoch = user.state.groupContext.epoch

            if (messageEpoch < currentEpoch) {
                const hasHistoricalData =
                    user.state.historicalReceiverData.has(messageEpoch)
                if (!hasHistoricalData) {
                    status.value = 'Cannot decrypt: Message is from epoch ' +
                        `${messageEpoch} but user is at epoch ` +
                        `${currentEpoch} and historical receiver data is ` +
                        'not available. Historical data is only saved ' +
                        'when processing commits.'
                    return
                }
            }

            let decryptedText = ''

            if (messageEpoch < currentEpoch) {
                const receiverData =
                    user.state.historicalReceiverData.get(messageEpoch)
                if (!receiverData) {
                    status.value = 'Cannot decrypt: Historical receiver ' +
                        `data not available for epoch ${messageEpoch}`
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
                    decryptedText = new TextDecoder()
                        .decode(result.content.content.applicationData)
                } else {
                    status.value = 'Error: Message is not an application ' +
                        'message'
                    return
                }
            } else {
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

                    if (result.content.content.contentType ===
                        'application') {
                        decryptedText = new TextDecoder()
                            .decode(result.content.content.applicationData)
                    } else {
                        status.value = 'Error: Message is not an ' +
                            'application message'
                        return
                    }
                } catch {
                    // Falls back to processMessage, which tolerates a
                    // generation that has already advanced past this
                    // message.
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
                        decryptedText = new TextDecoder()
                            .decode(processResult.message)
                        users.value = new Map(users.value).set(
                            userName,
                            { ...user, state: processResult.newState }
                        )
                    } else {
                        status.value = 'Error: Message is not an ' +
                            'application message'
                        return
                    }
                }
            }

            let updatedState:ClientState | undefined = user.state
            if (messageEpoch === currentEpoch && user.state) {
                try {
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
                        updatedState = processResult.newState
                    }
                } catch {
                    // Still show the decrypted text even if the state
                    // update fails.
                }
            }

            batch(() => {
                if (updatedState !== user.state) {
                    users.value = new Map(users.value)
                        .set(userName, { ...user, state: updatedState })
                }

                decryptedMessages.value = {
                    ...decryptedMessages.value,
                    [userName]: {
                        ...(decryptedMessages.value[userName] || {}),
                        [messageIndex]: decryptedText
                    }
                }

                const updatedQueue = userQueue.filter(item => {
                    return item.messageIndex !== messageIndex
                })
                messageQueues.value = {
                    ...messageQueues.value,
                    [userName]: updatedQueue
                }

                status.value = `Message decrypted for ${userName}`
            })
        } else {
            status.value = 'Error: Message is not a private message'
        }
    } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err)

        if (errorMessage.includes('epoch too old') ||
            errorMessage.includes('Cannot process message')) {
            status.value = `Cannot decrypt: ${errorMessage}. This usually ` +
                'means the message is from an older epoch and historical ' +
                'receiver data is not available. Historical data is only ' +
                'preserved when processing commits.'
        } else {
            status.value = `Error decrypting message: ${errorMessage}`
        }
    }
}
