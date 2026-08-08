import { signal, batch, useComputed } from '@preact/signals'
import { type FunctionComponent } from 'preact'
import { useEffect } from 'preact/hooks'
import { html } from 'htm/preact'
import { bytesToBase64url } from '../src/index.js'
import { toLeafIndex } from '../src/treemath.js'
import { createDemoState } from './demo-state.js'
import type { DemoUser } from '../example-shared/demo-user.js'
import {
    initCiphersuite,
    createUser,
    createMLSGroup,
    addUserToGroup,
    removeUserFromGroup,
    sendMessage,
    decryptMessage,
    rotateKeys
} from './demo-actions.js'
import {
    createMemberStore,
    partitionPersistedNames,
    partitionRestorableRecords,
    restoredUsersFromRecords
} from '../example-shared/persistence-storage.js'
import {
    type StorageStatus,
    checkPersisted,
    requestPersistentStorage
} from '../example-shared/storage-persistence.js'
import {
    type PersistRequest,
    StoragePanel,
    persistOutcome
} from '../example-shared/storage-panel.js'
import { selectParticipants, selectGroupUser } from './participants.js'
import {
    selectTreeLayout,
    directPathNodeIndices,
    rotationKeyChangeCount,
    selectNodeDetails,
} from './tree-view.js'
import { TreeDiagram, TreeNodeDetailPanel } from './tree-diagram.js'
import { EM_DASH, NBSP, SPACE } from '../example-shared/constants.js'
import { EXAMPLE_USERS } from './example-users.js'
import Debug from '@substrate-system/debug'
const debug = Debug('webcrypto-mls')

// This page's own indexedDB database. Every demo that persists owns one,
// because `loadAllMembers` returns the whole store and the restore path
// deletes what it cannot classify.
const {
    saveMember,
    deleteMember,
    loadAllMembers,
    deleteDatabase
} = createMemberStore({ dbName: 'mls-persistence-demo' })

const state = createDemoState()
const hoveredUser = signal<string | null>(null)
const selectedNodeIndex = signal<number | null>(null)

await initCiphersuite(state)

// Names of members whose keypair + ClientState are saved to indexedDB.
const persistedNames = signal<Set<string>>(new Set())

// Whether this page load restored any members from indexedDB.
const restoredFromStorage = signal(false)

// Whether the browser has granted persistent storage for this origin.
const storageStatus = signal<StorageStatus>(await checkPersisted())

// Outcome of the most recent `persist()` call.
const persistRequest = signal<PersistRequest>('idle')

async function requestStoragePersistence ():Promise<void> {
    persistRequest.value = 'pending'
    const status = await requestPersistentStorage()
    debug('status', status)

    batch(() => {
        storageStatus.value = status
        persistRequest.value = persistOutcome(status)
    })
}

function currentGroupIdB64 ():string | null {
    return state.groupId.value ? bytesToBase64url(state.groupId.value) : null
}

async function persistMember (name:string):Promise<void> {
    const groupIdB64 = currentGroupIdB64()
    const user = state.users.value.get(name)
    if (!groupIdB64 || !user?.state) return

    await saveMember(groupIdB64, name, user.state)
    persistedNames.value = new Set(persistedNames.value).add(name)
}

// Re-save every already-persisted member's current state -- called after
// each state advance (createCommit, createApplicationMessage,
// processMessage) so a persisted record always tracks the current epoch.
// A persisted member who no longer has state was removed from the group,
// so their record is dropped instead of re-saved.
async function syncPersistedMembers ():Promise<void> {
    const groupIdB64 = currentGroupIdB64()
    if (!groupIdB64) return

    const { save, remove } = partitionPersistedNames(
        persistedNames.value,
        state.users.value
    )

    for (const name of save) {
        const user = state.users.value.get(name)
        if (user?.state) await saveMember(groupIdB64, name, user.state)
    }

    for (const name of remove) {
        await deleteMember(groupIdB64, name)
    }

    if (remove.length > 0) {
        const remaining = new Set(persistedNames.value)
        for (const name of remove) remaining.delete(name)
        persistedNames.value = remaining
    }
}

async function resetDemo ():Promise<void> {
    await deleteDatabase()
    globalThis.location.reload()
}

// Runs under a top-level `await` below, in a module that is statically
// imported into the app's single entry bundle -- so any rejection that
// escapes this function would fail module evaluation and take down the
// whole app (including the Reset button, the only in-app way to clear
// indexedDB). Every failure is therefore caught here and reported to
// `state.status` instead of being allowed to propagate.
async function restoreFromStorage ():Promise<void> {
    try {
        const records = await loadAllMembers()
        if (records.length === 0) return

        const { restorable, stale } = partitionRestorableRecords(records)

        // A stale record describes someone who is no longer a member of
        // the current group (for example a member removed while an older
        // version of this page was running, before removed members'
        // records were deleted). Restoring it would show a zombie member,
        // so delete it instead. The record's own groupId reproduces the
        // key it was saved under.
        for (const record of stale) {
            await deleteMember(
                bytesToBase64url(record.state.groupContext.groupId),
                record.name
            )
        }

        if (restorable.length === 0) return

        const { users, groupId } = restoredUsersFromRecords(restorable)

        const droppedNote = stale.length > 0 ?
            ` (dropped ${stale.length} stale record(s): ` +
                stale.map((r) => r.name).join(', ') + ')' :
            ''

        batch(() => {
            state.users.value = new Map([...state.users.value, ...users])
            state.groupId.value = groupId
            state.status.value = 'Restored ' +
                `${restorable.length} member(s) from indexedDB` +
                droppedNote
            persistedNames.value = new Set(restorable.map((r) => r.name))
            restoredFromStorage.value = true
        })
    } catch (err) {
        debug('restoreFromStorage failed', err)
        const message = err instanceof Error ? err.message : String(err)
        state.status.value = 'Restore from indexedDB failed: ' +
            `${message} ${EM_DASH} use Reset to clear stored data.`
    }
}

await restoreFromStorage()

/**
 * Each member on this page gets their own non-extractable Ed25519
 * signature keypair (README's "Use with pre-existing keypairs" section),
 * generated here rather than by `cs.signature.keygen()` as the main demo
 * does -- a non-extractable private key is what a real persisted identity
 * would use, since its bytes are never readable, only usable via
 * `crypto.subtle`.
 */
async function createPersistentUser (name:string):Promise<void> {
    const signatureKeyPair = await globalThis.crypto.subtle.generateKey(
        { name: 'Ed25519' },
        false, // not extractable
        ['sign', 'verify']
    )
    await createUser(state, name, { signatureKeyPair })
}

/**
 * Rotating advances the epoch for every in-group member, so every
 * already-persisted record has to be re-saved or it would restore at a
 * dead epoch. A member who is not in the group yet gets their key
 * package regenerated by `createPersistentUser`, keeping the
 * non-extractable identity this page exists to demonstrate.
 */
async function rotateAndSync (name:string):Promise<void> {
    await rotateKeys(state, name, { createUser: createPersistentUser })
    await syncPersistedMembers()
}

export const PersistenceDemo:FunctionComponent = function () {
    const {
        users,
        groupId,
        status,
        messages,
        inputMessage,
        decryptedMessages,
        messageQueues,
        ciphersuite
    } = state

    const participants = selectParticipants(users.value)

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

    // Every in-group member derives the identical epoch authenticator,
    // so any member's copy stands in for the group's.
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

    const participantColumns = participants.map((participant) => {
        const participantDecrypted = decryptedMessages.value[participant] ||
            {}
        const participantQueue = messageQueues.value[participant] || []
        const participantMessageIndices = new Set([
            ...participantQueue.map(item => item.messageIndex),
            ...Object.keys(participantDecrypted).map(Number)
        ])
        const messageBoxes = messages.value.map((msg, idx) => {
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
                        onClick=${async () => {
                            await decryptMessage(state, participant, idx)
                            await syncPersistedMembers()
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
                        Members in group:${NBSP}${participants.length}
                    </p>
                    ${currentEpoch.value !== null ? html`
                        <p class="current-epoch">
                            Current epoch:${NBSP}${currentEpoch.value}
                        </p>
                    ` : null}
                    ${epochAuthenticator.value ? html`
                        <p class="epoch-secret">
                            <span class="label">
                                Epoch authenticator:
                            </span>${NBSP}
                            <span class="value">
                                ${epochAuthenticator.value}
                            </span>
                            <br />
                            <span>
                                (see <code>
                                    example/persistence-demo.ts
                                </code>).
                            </span>
                        </p>
                    ` : null}
                    <p>${status.value}</p>
                    <${TreeNodeDetailPanel} detail=${detail} />
                </div>
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
            <h1>Persistence Demo</h1>

            <p>
                This demo mirrors the main demo's group messaging, except
                each member's signature keypair here is${SPACE}
                <strong>non-extractable</strong>, generated on this page
                with <code>crypto.subtle.generateKey</code> and passed to${SPACE}
                <code>generateKeyPackage</code> via its${SPACE}
                <code>signatureKeyPair</code> option, so the private key
                bytes are never readable.
            </p>

            ${restoredFromStorage.value ? html`
                <p class="restored-notice">
                    Restored from indexedDB.
                </p>
            ` : null}

            <${StoragePanel}
                status=${storageStatus.value}
                request=${persistRequest.value}
                onRequest=${requestStoragePersistence}
            />

            <button
                class="reset-btn"
                onClick=${resetDemo}
            >
                Reset
            </button>

            ${treeDiagramCard ? html`
                <div class="grid status-row">
                    ${statusCard}
                    ${treeDiagramCard}
                </div>
            ` : statusCard}

            <div class="grid">
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
                                        onClick=${() => rotateAndSync(name)}
                                    >
                                        Rotate Keys
                                    </button>
                                </div>
                            ` : html`
                                <button
                                    key=${name}
                                    onClick=${() => createPersistentUser(name)}
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
                            ([name, user]:[string, DemoUser]) => {
                            const isPersisted = persistedNames.value.has(name)
                            return html`
                            <li key=${name}>
                                <strong>${name}</strong>
                                ${user.state ? html`
                                    <span>
                                        In group (Epoch:
                                        ${user.state.groupContext.epoch
                                            .toString()})
                                    </span>
                                ` : html`
                                    <span>Key package ready</span>
                                `}
                                ${user.state ? html`
                                    <button
                                        class="persist-btn"
                                        onClick=${() => persistMember(name)}
                                        disabled=${isPersisted}
                                    >
                                        ${isPersisted ? 'persisted' : 'persist'}
                                    </button>
                                ` : null}
                            </li>`
                            }
                        )}
                    </ul>
                </div>

                <div class="card groups">
                    <h3>Group Operations</h3>

                    ${!groupId.value ? html`
                        <h4>Create Group</h4>
                        <div class="controls groups">
                            ${Array.from(users.value.keys()).map((name) => {
                                return html`
                                    <button
                                        key=${name}
                                        onClick=${() => {
                                            createMLSGroup(state, name)
                                        }}
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
                                ${bytesToBase64url(groupId.value)
                                    .slice(0, 24)}...
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
                                                onClick=${async () => {
                                                    await addUserToGroup(
                                                        state,
                                                        adderName,
                                                        memberName
                                                    )
                                                    await syncPersistedMembers()
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

                            ${participants.length > 1 ? html`
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
                                                    onClick=${async () => {
                                                        await removeUserFromGroup(
                                                            state,
                                                            removerName,
                                                            removedName
                                                        )
                                                        await syncPersistedMembers()
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

            ${(groupId.value &&
                Array.from(users.value.values()).some((u) => u.state)) ?
                html`
                <div class="card messenger">
                    <h3>Send Message</h3>
                    <label for="persistence-message">Message</label>
                    <div class="flex">
                        <input
                            type="text"
                            name="persistence-message"
                            id="persistence-message"
                            value=${inputMessage.value}
                            onInput=${(event:any) => {
                                inputMessage.value = event.target.value
                            }}
                            placeholder="Type a message..."
                        />
                    </div>
                    <div class="controls">
                        ${Array.from(users.value.entries()).map(
                            ([name, user]:[string, DemoUser]) =>
                            user.state ? html`
                                <button
                                    key=${name}
                                    onClick=${async () => {
                                        if (inputMessage.value.trim()) {
                                            const text = inputMessage.value
                                            inputMessage.value = ''
                                            await sendMessage(state, name, text)
                                            await syncPersistedMembers()
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
        </div>
    `
}
