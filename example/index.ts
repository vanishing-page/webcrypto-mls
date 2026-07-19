import { type FunctionComponent, render } from 'preact'
import { useCallback } from 'preact/hooks'
import { useComputed } from '@preact/signals'
import { html } from 'htm/preact'
import {
    State,
    type User,
    type Message
} from './state.js'
import {
    createGroup,
    createCommit,
    createApplicationMessage,
    processPublicMessage,
    encodeMlsMessage,
    decodeMlsMessage,
    makePskIndex,
    bytesToBase64,
    joinGroup,
} from '../src/index.js'
import Debug from '@substrate-system/debug'
const debug = Debug(import.meta.env.DEV)

const state = State()

// @ts-expect-error dev
window.state = state

const {
    users,
    messages,
    ciphersuite,
    groupId,
    status,
    inputMessage,
    keyPackageInfo,
    decryptedMessagesAlice,
    decryptedMessagesBob,
    decryptedMessagesCarl,
    messageQueueAlice,
    messageQueueBob,
    messageQueueCarl
} = state

// Initialize ciphersuite
await State.init(state)

const Example:FunctionComponent = function () {
    const usersInGroup = useComputed<[string, User][]>(() => {
        const data = Array.from(state.users.value.entries())
        return data.filter(([_name, user]) => {
            return user.state
        })
    })

    const createUser = useCallback((ev:MouseEvent) => {
        const btn = ev.target as HTMLButtonElement
        const name = btn.dataset.name!
        State.createUser(state, name)
    }, [])

    const showKeyPackage = useCallback((name:string) => {
        const user = users.value.get(name)
        if (user?.keyPackage) {
            const kp = user.keyPackage
            const info = `Key Package for ${name}:\n` +
                `Protocol Version: ${kp.version}\n` +
                `Cipher Suite: ${kp.cipherSuite}\n` +
                `Init Key: ${bytesToBase64(kp.leafNode.hpkePublicKey)}`

            keyPackageInfo.value = info
        }
    }, [])

    // Add a user to the group
    const addUserToGroup = async (adderName:string, newMemberName:string) => {
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

            // Create commit with Add proposal
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

            // Update adder's state
            users.value = new Map(users.value).set(adderName, {
                ...adder,
                state: result.newState
            })

            // Process the Welcome message for the new member
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

            // Process commit for existing members
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
                                const processResult =
                                    await processPublicMessage(
                                        user.state,
                                        decodedMessage.publicMessage,
                                        makePskIndex(user.state, {}),
                                        ciphersuite.value
                                    )
                                const updatedUser = {
                                    ...user,
                                    state: processResult.newState
                                }
                                users.value = new Map(users.value).set(
                                    userName,
                                    updatedUser
                                )
                            }
                        } catch (err) {
                            debug(
                                `Error processing commit for ${userName}:`,
                                err
                            )
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
    const sendMessage = async (senderName:string, text:string) => {
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

            // Update sender's state
            users.value = new Map(users.value).set(senderName, {
                ...sender,
                state: result.newState
            })

            // Add message to display (store ciphertext)
            const messageIndex = messages.value.length
            messages.value = [...messages.value, {
                from: senderName,
                text,
                ciphertext: encoded, // Store the encrypted message bytes
                epoch: result.newState.groupContext.epoch,
                timestamp: Date.now()
            }]

            // Queue the message separately for each recipient.
            for (const [userName, user] of users.value.entries()) {
                if (user.state) {
                    if (userName === senderName) {
                        // The sender already knows the plaintext.
                        if (senderName === 'Alice') {
                            decryptedMessagesAlice.value = {
                                ...decryptedMessagesAlice.value,
                                [messageIndex]: text
                            }
                        } else if (senderName === 'Bob') {
                            decryptedMessagesBob.value = {
                                ...decryptedMessagesBob.value,
                                [messageIndex]: text
                            }
                        } else if (senderName === 'Carl') {
                            decryptedMessagesCarl.value = {
                                ...decryptedMessagesCarl.value,
                                [messageIndex]: text
                            }
                        }
                    } else {
                        // For recipients, add to their queue
                        const queueItem = {
                            messageIndex,
                            ciphertext: encoded,
                            epoch: result.newState.groupContext.epoch
                        }

                        if (userName === 'Alice') {
                            messageQueueAlice.value = [
                                ...messageQueueAlice.value,
                                queueItem
                            ]
                        } else if (userName === 'Bob') {
                            messageQueueBob.value = [
                                ...messageQueueBob.value,
                                queueItem
                            ]
                        } else if (userName === 'Carl') {
                            messageQueueCarl.value = [
                                ...messageQueueCarl.value,
                                queueItem
                            ]
                        }
                    }
                }
            }

            status.value = `Message sent from ${senderName}`
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            status.value = `Error sending message: ${message}`
        }
    }

    // Read signals here so Preact tracks them for reactivity.
    const _messages = messages.value
    const _aliceDecrypted = decryptedMessagesAlice.value
    const _bobDecrypted = decryptedMessagesBob.value
    const _carlDecrypted = decryptedMessagesCarl.value
    const removeUserFromGroup = State.removeUserFromGroup
    const participantMessages = [
        {
            name: 'Alice',
            decrypted: decryptedMessagesAlice,
            queue: messageQueueAlice
        },
        {
            name: 'Bob',
            decrypted: decryptedMessagesBob,
            queue: messageQueueBob
        },
        {
            name: 'Carl',
            decrypted: decryptedMessagesCarl,
            queue: messageQueueCarl
        }
    ]

    const participantColumns = participantMessages.map(({
        name: participant,
        decrypted: participantDecrypted,
        queue: participantQueue
    }) => {
        // Force reads for reactivity tracking.
        const _decrypted = participantDecrypted.value
        const _queue = participantQueue.value
        const participantMessageIndices = new Set([
            ...participantQueue.value.map(item => item.messageIndex),
            ...Object.keys(participantDecrypted.value).map(Number)
        ])
        const messageBoxes = messages.value.map((msg:Message, idx:number) => {
            if (!participantMessageIndices.has(idx)) return null

            const decryptedObj = participantDecrypted.value
            const isDecrypted = decryptedObj[idx] !== undefined
            const decryptedText = decryptedObj[idx] || ''
            const ciphertext = bytesToBase64(msg.ciphertext).slice(0, 64)
            const timestamp = new Date(msg.timestamp).toLocaleTimeString()
            const canDecrypt = Boolean(users.value.get(participant)?.state)

            return html`
                <div key=${idx} class="message-box">
                    <div class="message-header">
                        <strong>${msg.from}</strong>
                        <small>Epoch ${msg.epoch.toString()}</small>
                        <small class="timestamp">${timestamp}</small>
                    </div>
                    <div class="ciphertext-section">
                        <label>Ciphertext:</label>
                        <code class="ciphertext">${ciphertext}...</code>
                    </div>
                    ${isDecrypted ? html`
                        <div class="decrypted-section">
                            <label>Decrypted:</label>
                            <div class="decrypted-text">
                                ${decryptedText}
                            </div>
                        </div>
                    ` : html`
                        <button
                            class="decrypt-btn"
                            onClick=${() => {
                                State.decryptMessage(
                                    state,
                                    participant,
                                    idx
                                )
                            }}
                            disabled=${!canDecrypt}
                        >
                            Decrypt
                        </button>
                    `}
                </div>
            `
        })

        return html`
            <div key=${participant} class="message-column">
                <h4 class="column-header">${participant}</h4>
                <div class="message-boxes">${messageBoxes}</div>
            </div>
        `
    })

    return html`
        <div class="container">
            <h1>WebCrypto MLS Browser Example</h1>

            <p>
                This example demonstrates end-to-end encrypted group
                messaging with MLS. All cryptographic operations happen
                in the browser with WebCrypto APIs.
            </p>

            <div class="card status">
                <div class="status-layout">
                    <div class="status-content">
                        <h3>Status</h3>
                        <p>${status.value}</p>
                    </div>
                    ${keyPackageInfo.value ? html`
                        <div class="kpinfo">
                            <h3>Key Package Info</h3>
                            <pre>${keyPackageInfo.value}</pre>
                        </div>
                    ` : null}
                </div>
            </div>

            <div class="grid">
                <!-- User Management -->
                <div class="card users">
                    <h3>👤 User Management</h3>

                    <div class="controls user">
                        <button
                            data-name="Alice"
                            onClick=${createUser}
                            disabled=${!ciphersuite.value}
                        >
                            Create Alice
                        </button>
                        <button
                            data-name="Bob"
                            onClick=${createUser}
                            disabled=${!ciphersuite.value}
                        >
                            Create Bob
                        </button>
                        <button
                            data-name="Carl"
                            onClick=${createUser}
                            disabled=${!ciphersuite.value}
                        >
                            Create Carl
                        </button>
                    </div>

                    <h4>Users (${users.value.size})</h4>
                    <ul class="list users">
                        ${Array.from(users.value.entries()).map(
                            ([name, user]) => {
                            return html`<li key=${name}>
                                <strong>${name}</strong>
                                ${user.state ? html`
                                    <span>
                                        In group (Epoch:
                                        ${user.state.groupContext.epoch
                                            .toString()})
                                    </span>
                                ` : html`
                                    <span>
                                        <button
                                            onClick=${() => {
                                                showKeyPackage(name)
                                            }}
                                        >
                                            🔑 Key package ready
                                        </button>
                                    </span>
                                `}
                            </li>`
                            }
                        )}
                    </ul>
                </div>

                <!-- Group Operations -->
                <div class="card groups">
                    <h3>Group Operations</h3>

                    ${!groupId.value ? html`
                        <h4>Create Group</h4>
                        <div class="controls groups">
                            ${Array.from(users.value.keys()).map((name) => {
                                return html`
                                    <button
                                        key=${name}
                                        onClick=${() => createMLSGroup(name)}
                                    >
                                        Start group as ${name}
                                    </button>
                                    `
                                })
                            }
                        </div>
                    ` : html`
                        <div>
                            <h4>Group Active</h4>
                            <p>
                                ID:
                                ${bytesToBase64(groupId.value).slice(0, 24)}...
                            </p>

                            ${usersInGroup.value.length < 3 ? html`
                                <h4>Add Member</h4>
                                <div class="controls members">
                                    ${Array.from(users.value.entries()).map(
                                        ([adderName, adder]) => {
                                        return adder.state ? Array.from(
                                            users.value.entries()
                                        ).map(([memberName, member]) => {
                                            const canAdd = !member.state &&
                                                member.keyPackage
                                            return canAdd ? html`
                                                <button
                                                    key=${adderName + '-' +
                                                        memberName}
                                                    onClick=${() => {
                                                        addUserToGroup(
                                                            adderName,
                                                            memberName
                                                        )
                                                    }}
                                                >
                                                    ${adderName} adds
                                                    ${memberName}
                                                </button>
                                            ` : null
                                            }
                                        ) : null
                                        }
                                    )}
                                </div>
                            ` : null}

                            ${usersInGroup.value.length > 1 ? html`
                                <h4>Remove Member</h4>
                                <div class="controls members">
                                    ${Array.from(users.value.entries()).map(
                                        ([removerName, remover]) => {
                                        return remover.state ? Array.from(
                                            users.value.entries()
                                        ).map(([removedName, removed]) => {
                                            const canRemove = removed.state &&
                                                removedName !== removerName
                                            return canRemove ? html`
                                                <button
                                                    key=${removerName + '-' +
                                                        removedName}
                                                    onClick=${() => {
                                                        removeUserFromGroup(
                                                            state,
                                                            removerName,
                                                            removedName
                                                        )
                                                    }}
                                                >
                                                    ${removerName} removes
                                                    ${removedName}
                                                </button>
                                            ` : null
                                            }
                                        ) : null
                                        }
                                    )}
                                </div>
                            ` : null}
                        </div>
                    `}
                </div>
            </div>

            <!-- Messaging -->
            ${(groupId.value &&
                Array.from(users.value.values()).some((u:User) => u.state)) ?
                html`
                <div class="card messenger">
                    <h3>Send Message</h3>
                    <label for="message">Message</label>
                    <div class="flex">
                        <input
                            type="text"
                            name="message"
                            id="message"
                            value=${inputMessage.value}
                            onInput=${(event:any) => {
                                inputMessage.value = event.target.value
                            }}
                            placeholder="Type a message..."
                        />
                    </div>
                    <div class="controls">
                        ${Array.from(users.value.entries()).map(
                            ([name, user]:[string, User]) =>
                            user.state ? html`
                                <button
                                    key=${name}
                                    onClick=${() => {
                                        if (inputMessage.value.trim()) {
                                            sendMessage(
                                                name,
                                                inputMessage.value
                                            )
                                            inputMessage.value = ''
                                        }
                                    }}
                                    disabled=${!inputMessage.value.trim()}
                                >
                                    Send as ${name}
                                </button>
                            ` : null
                        )}
                    </div>
                </div>

                <!-- Message History -->
                <div class="card message-history">
                    <h3>Message History</h3>
                    ${messages.value.length === 0 ? html`
                        <p>No messages yet</p>
                    ` : html`
                        <div class="message-columns">
                            ${participantColumns}
                        </div>
                    `}
                </div>
            ` : null}

            <!-- Instructions -->
            <div class="card instructions">
                <h3>How to use</h3>
                <ol>
                    <li>
                        <strong>Create users</strong> with the Alice, Bob,
                        and Carl buttons.
                    </li>
                    <li>
                        <strong>Start a group</strong> as one user, then add
                        or remove members.
                    </li>
                    <li>
                        <strong>Send messages</strong> as any active member.
                    </li>
                    <li>
                        <strong>Decrypt messages</strong> independently in
                        each participant's history column.
                    </li>
                </ol>
            </div>
        </div>
    `
}

const root = document.getElementById('root')!
let currentRender = () => {}

const rerender = () => {
    currentRender = () => {
        render(html`<${Example} />`, root)
    }
    currentRender()
}

// Initial render
rerender()

// Re-render when any decrypted message signal changes
decryptedMessagesAlice.subscribe(() => rerender())
decryptedMessagesBob.subscribe(() => rerender())
decryptedMessagesCarl.subscribe(() => rerender())

// Create a new MLS group with the first user
async function createMLSGroup (creatorName:string) {
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
        const state = await createGroup(
            newGroupId,
            creator.keyPackage,
            creator.privateKeys,
            [],
            ciphersuite.value
        )

        users.value = new Map(users.value).set(creatorName, {
            ...creator,
            state
        })
        groupId.value = newGroupId
        status.value = 'MLS group created. Group ID:' +
            `${bytesToBase64(newGroupId).slice(0, 16)}...`
    } catch (err) {
        status.value = 'Error creating group: ' +
            `${err instanceof Error ? err.message : String(err)}`
    }
}
