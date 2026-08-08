import { type FunctionComponent, render } from 'preact'
import { useCallback, useEffect } from 'preact/hooks'
import { useComputed, signal } from '@preact/signals'
import { html } from 'htm/preact'

/**
 * Registration only, and not optional. `example-shared/storage-panel.ts`
 * renders `<substrate-button>`, and both pages this entry loads render
 * that panel. An undefined custom element does not render: without
 * this, the button's label would be inert inline text and the control
 * would be gone.
 */
import '@substrate-system/button'

import {
    State,
    type User,
    type Message
} from './state.js'
import {
    selectTreeLayout,
    directPathNodeIndices,
    rotationKeyChangeCount,
    selectNodeDetails,
} from './tree-view.js'
import { TreeDiagram, TreeNodeDetailPanel } from './tree-diagram.js'
import { selectParticipants, selectGroupUser } from './participants.js'
import { PersistenceDemo } from './persistence-demo.js'
import { MultiDeviceDemo } from './multi-device-demo.js'
import { Nav } from './nav.js'
import { isPersistencePath, isMultiDevicePath } from './routing.js'
import { toLeafIndex } from '../src/treemath.js'
import {
    addUserToGroup,
    sendMessage,
    createMLSGroup
} from './demo-actions.js'
import { bytesToBase64url } from '../src/index.js'
import { NBSP, SPACE } from '../example-shared/constants.js'
import { EXAMPLE_USERS } from './example-users.js'

const state = State()
const basePath = import.meta.env.BASE_URL

const hoveredUser = signal<string | null>(null)
const selectedNodeIndex = signal<number | null>(null)

window.localStorage.setItem('DEBUG', 'mls,mls:*')

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
    decryptedMessages,
    messageQueues
} = state

// Initialize ciphersuite
await State.init(state)

const Example:FunctionComponent = function () {
    const usersInGroup = useComputed<[string, User][]>(() => {
        const participants = selectParticipants(state.users.value)
        return participants.map((name) => {
            return [name, state.users.value.get(name)!] as [string, User]
        })
    })

    const treeLayout = useComputed(() => {
        // Read groupId so this recomputes as soon as a group is created,
        // even before `users` reflects any post-creation change.
        const groupUser = selectGroupUser(users.value)

        const leafNames = new Map(
            Array.from(users.value.entries())
                .filter(([, user]) => user.state)
                .map(([name, user]) => {
                    return [
                        toLeafIndex(user.state!.privatePath.leafIndex),
                        name,
                    ] as const
                })
        )

        return selectTreeLayout(
            !!groupId.value,
            groupUser?.state?.ratchetTree,
            leafNames
        )
    })

    // Every in-group member shares the same epoch, so any member's copy
    // stands in for the group's current epoch.
    const currentEpoch = useComputed(() => {
        const groupUser = selectGroupUser(users.value)
        const epoch = groupUser?.state?.groupContext.epoch
        if (epoch === undefined) return null
        return epoch.toString()
    })

    // Every in-group member derives the identical epoch authenticator, so
    // any member's copy stands in for the group's epoch authenticator.
    const epochAuthenticator = useComputed(() => {
        const groupUser = selectGroupUser(users.value)
        const ks = groupUser?.state?.keySchedule
        if (!ks) return null
        return bytesToBase64url(ks.epochAuthenticator)
    })

    const hoveredPath = useComputed(() => {
        const name = hoveredUser.value
        if (!name) return new Set<number>()

        const user = users.value.get(name)
        const path = user?.state?.privatePath
        const tree = user?.state?.ratchetTree
        if (!path || !tree) return new Set<number>()

        return directPathNodeIndices(tree, toLeafIndex(path.leafIndex))
    })

    const panelDetail = useComputed(() => {
        // Peek (hover/focus) takes precedence over a pinned selection.
        const hovered = hoveredUser.value
        if (hovered) {
            const user = users.value.get(hovered)
            const path = user?.state?.privatePath
            const tree = user?.state?.ratchetTree
            if (path && tree) {
                const count = rotationKeyChangeCount(
                    tree,
                    toLeafIndex(path.leafIndex)
                )
                return { kind: 'peek' as const, count }
            }
        }

        const index = selectedNodeIndex.value
        if (index !== null) {
            const groupUser = selectGroupUser(users.value)
            const tree = groupUser?.state?.ratchetTree
            if (tree) {
                return {
                    kind: 'node' as const,
                    details: selectNodeDetails(tree, index),
                }
            }
        }

        return { kind: 'none' as const }
    })

    useEffect(() => {
        const onKeyDown = (ev:KeyboardEvent) => {
            if (ev.key === 'Escape') {
                selectedNodeIndex.value = null
            }
        }
        document.addEventListener('keydown', onKeyDown)
        return () => document.removeEventListener('keydown', onKeyDown)
    }, [])

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
                `Init Key: ${bytesToBase64url(kp.leafNode.hpkePublicKey)}`

            keyPackageInfo.value = info
        }
    }, [])

    // Read signals here so Preact tracks them for reactivity.
    const _messages = messages.value
    const _decrypted = decryptedMessages.value
    const _queues = messageQueues.value
    const removeUserFromGroup = State.removeUserFromGroup
    const participants = selectParticipants(users.value)

    const participantColumns = participants.map((participant) => {
        const participantDecrypted =
            decryptedMessages.value[participant] || {}
        const participantQueue = messageQueues.value[participant] || []
        const participantMessageIndices = new Set([
            ...participantQueue.map(item => item.messageIndex),
            ...Object.keys(participantDecrypted).map(Number)
        ])
        const messageBoxes = messages.value.map((msg:Message, idx:number) => {
            if (!participantMessageIndices.has(idx)) return null

            const isDecrypted = participantDecrypted[idx] !== undefined
            const decryptedText = participantDecrypted[idx] || ''
            const ciphertext = bytesToBase64url(msg.ciphertext).slice(0, 64)
            const timestamp = new Date(msg.timestamp).toLocaleTimeString()
            const canDecrypt = Boolean(users.value.get(participant)?.state)

            return html`<div key=${idx} class="message-box">
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
                ` : html`<button
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
                    </button>`}
            </div>`
        })

        return html`
            <div key=${participant} class="message-column">
                <h4 class="column-header">${participant}</h4>
                <div class="message-boxes">${messageBoxes}</div>
            </div>
        `
    })

    const detail = panelDetail.value

    const statusCard = html`
        <div class="card status">
            <div class="status-layout">
                <div class="status-content">
                    <h3>Status</h3>
                    <p class="member-count">
                        Members in group:${NBSP}${usersInGroup.value.length}
                    </p>
                    ${currentEpoch.value !== null ? html`
                        <p class="current-epoch">
                            Current epoch:${NBSP}${currentEpoch.value}
                        </p>
                    ` : null}
                    ${epochAuthenticator.value ? html`
                        <p class="epoch-secret">
                            <span class="label">Epoch authenticator:</span>${NBSP}
                            <span class="value">
                                ${epochAuthenticator.value}
                            </span>
                            <br />
                            <span>
                                (see <code>example/index.ts:108-116</code>).
                            </span>
                        </p>
                    ` : null}
                    <p>${status.value}</p>
                    <${TreeNodeDetailPanel} detail=${detail} />
                </div>
                ${keyPackageInfo.value ? html`
                    <div class="kpinfo">
                        <h3>Key Package Info</h3>
                        <pre>${keyPackageInfo.value}</pre>
                    </div>
                ` : null}
            </div>
        </div>
    `

    const treeDiagramCard = treeLayout.value ? html`
        <${TreeDiagram}
            layout=${treeLayout.value}
            hoveredPath=${hoveredPath.value}
            selectedNodeIndex=${selectedNodeIndex.value}
            onSelectNode=${(nodeIndex:number) => {
                selectedNodeIndex.value = nodeIndex
            }}
            onClear=${() => {
                selectedNodeIndex.value = null
            }}
        />
    ` : null

    return html`
        <div class="container">
            <h1>WebCrypto MLS Browser Example</h1>

            <p>
                This example demonstrates end-to-end encrypted group
                messaging with MLS. All cryptographic operations happen
                in the browser with WebCrypto APIs.
            </p>

            <p>
                MLS encrypts content with a single shared
                symmetric key. Each group member also has an asymmeteric keypair.
                The per-member asymmetric keys aren't used to
                encrypt application messages though. They exist to establish
                and rotate the shared symmetric key efficiently and securely. 
            </p>

            <p>
                If you hover a "rotate keys" button below, you will see
                "rotating keys would change n keys." Regardless of how
                many keys need to change for a rotation, the application code
                always broadcasts a single <a href="https://github.com/vanishing-page/webcrypto-mls#commit">
                commit message</a> to everyone. One message goes to all group
                participants.
            </p>

            <h2 id="epochs">Epochs</h2>
            <p>
                Each "epoch" (a stable membership state) of an MLS group has a
                single epoch secret that every member can derive. The${SPACE}
                <a href="https://github.com/vanishing-page/webcrypto-mls#key-schedule">
                <strong>key schedule</strong></a>${SPACE}
                uses it to produce the symmetric keys used for encrypting
                application messages. When Alice sends to the group, she
                encrypts under a symmetric key that Bob, Carol, etc. can all
                derive.
            </p>


            <h2 id="key-rotation">Key Rotation</h2>
            <p>
                How does everyone arrive at that shared secret,
                and why go through all the per-member-key
                machinery to get it? Why not just distribute one static
                shared key? Two scenarios:
            </p>

            <ol>
                <li>
                    <strong>Removing a member</strong>. With a static shared key,
                    once Bob has seen it, he can decrypt everything
                    encrypted under it forever. "Removing" Bob means picking a
                    new key and getting it to everyone except Bob.
                </li>

                <li>
                    <strong>
                        Forward secrecy and post-compromise security.
                    </strong> A static key is a single point of catastrophic
                    failure: compromise it once and every message, past and
                    future, is exposed. MLS instead ratchets. Every epoch
                    derives a fresh secret, and old key material is deleted
                    (forward secrecy). A compromised member can rotate their
                    leaf to make the group secure again
                    (post-compromise "healing").  A static key, by definition,
                    never heals.
                </li>
            </ol>

            <p>
                Both of these are about the cost of re-keying.
                Every add, remove, or key rotation operation forces you to
                re-key the group.
            </p>

            <p>
                The most naive approach is to encrypt the new group key
                separately to each of the N members' public keys. That's O(N)
                per change.
            </p>

            <h3 id="tree-kem">Tree KEM</h3>
            <p>
                A better option is ${SPACE}
                <strong><code>
                    <a href="https://eprint.iacr.org/2025/410">TreeKEM</a>
                </code></strong> (Tree Key-Encapsulation-Mechanism).
                In this model, users are arranged in a binary tree structure.
                For a key change, a node needs to deliver its new secret
                just to the sibling subtree (<code>O(log N)</code>, not <code>
                O(N)</code>).
            </p>

            <p>
                In a group of 1,000, that's roughly 10 operations instead of
                1,000. This happens on every membership change and key
                refresh, so the efficiency gain is magnified when people
                join or leave the group.
            </p>

            ${treeDiagramCard ? html`
                <div class="grid status-row">
                    ${statusCard}
                    ${treeDiagramCard}
                </div>
            ` : statusCard}

            <div class="grid">
                <!-- User Management -->
                <div class="card users">
                    <h3>👤 User Management</h3>

                    <div class="controls user">
                        ${EXAMPLE_USERS.map((name) => {
                            const user = users.value.get(name)
                            return user ? html`
                                <div key=${name} class="rotate-control">
                                    <span class="rotate-label">${name}</span>
                                    <button
                                        onMouseEnter=${() => {
                                            hoveredUser.value = name
                                        }}
                                        onMouseLeave=${() => {
                                            hoveredUser.value = null
                                        }}
                                        onFocus=${() => {
                                            hoveredUser.value = name
                                        }}
                                        onBlur=${() => {
                                            hoveredUser.value = null
                                        }}
                                        onClick=${() => {
                                            State.rotateKeys(state, name)
                                        }}
                                    >
                                        Rotate Keys
                                    </button>
                                </div>
                            ` : html`
                                <button
                                    key=${name}
                                    data-name=${name}
                                    onClick=${createUser}
                                    disabled=${!ciphersuite.value}
                                >
                                    Create ${name}
                                </button>
                            `
                        })}
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
                                        onClick=${() =>
                                            createMLSGroup(state, name)}
                                    >
                                        Start group as ${name}
                                    </button>
                                `
                            })}
                        </div>
                    ` : html`
                        <div>
                            <h4>Group Active</h4>
                            <p>
                                ID:${NBSP}
                                ${bytesToBase64url(groupId.value).slice(0, 24)}...
                            </p>

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
                                                        state,
                                                        adderName,
                                                        memberName
                                                    )
                                                }}
                                            >
                                                ${adderName} adds ${memberName}
                                            </button>
                                        ` : null
                                        }
                                    ) : null
                                    }
                                )}
                            </div>

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
                                                    ${removerName} removes${SPACE}
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
                                                state,
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

const App:FunctionComponent = function () {
    const showPersistence = useComputed(() => {
        return isPersistencePath(state.route.value, basePath)
    })

    const showMultiDevice = useComputed(() => {
        return isMultiDevicePath(state.route.value, basePath)
    })

    const page = showPersistence.value ?
        html`<${PersistenceDemo} />` :
        (showMultiDevice.value ?
            html`<${MultiDeviceDemo} />` :
            html`<${Example} />`)

    return html`
        <${Nav} route=${state.route.value} basePath=${basePath} />
        ${page}
    `
}

const root = document.getElementById('root')!
let currentRender = () => {}

const rerender = () => {
    currentRender = () => {
        render(html`<${App} />`, root)
    }
    currentRender()
}

// Initial render
rerender()

// Re-render when any decrypted message signal changes
decryptedMessages.subscribe(() => rerender())
messageQueues.subscribe(() => rerender())
