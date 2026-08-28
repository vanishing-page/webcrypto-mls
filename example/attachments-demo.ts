import { type FunctionComponent } from 'preact'
import { useEffect, useRef } from 'preact/hooks'
import { useSignal } from '@preact/signals'
import { html } from 'htm/preact'
import {
    createAttachmentState,
    type AttachmentGroup,
    type AttachmentPhase,
    type AttachmentSignals,
    type AttachmentState
} from './attachment-state.js'
import { selectGroupUser } from './participants.js'
import type { DemoState } from './demo-state.js'
import type { CiphersuiteImpl } from '../src/index.js'

export type AttachmentsDemoProps = {
    readonly state:DemoState
}

export const AttachmentsDemo:FunctionComponent<AttachmentsDemoProps> =
    function ({ state: demoState }) {
        const status = useSignal('Ready')
        const segmentsTotal = useSignal(0)
        const segmentsDone = useSignal(0)
        const phase = useSignal<AttachmentPhase>('idle')
        const cipherSuite = useSignal<CiphersuiteImpl|null>(null)
        const group = useSignal<AttachmentGroup|null>(null)
        const scope = useSignal<AttachmentSignals['scope']['value']>(null)
        const hasAttachment = useSignal(false)

        const signals:AttachmentSignals = {
            status,
            segmentsTotal,
            segmentsDone,
            phase,
            cipherSuite,
            group,
            scope,
            hasAttachment
        }

        const stateRef = useRef<AttachmentState|null>(null)
        if (!stateRef.current) {
            stateRef.current = createAttachmentState({ signals })
        }
        const attachmentState = stateRef.current

        const groupId = demoState.groupId.value
        const groupUser = selectGroupUser(demoState.users.value)
        const currentGroup = groupId ? groupUser?.state ?? null : null
        const currentCipherSuite = demoState.ciphersuite.value

        useEffect(() => {
            attachmentState.setContext({
                cipherSuite: currentCipherSuite,
                group: currentGroup
            }).catch(() => {})
        }, [attachmentState, currentCipherSuite, currentGroup, groupId])

        useEffect(() => {
            return () => {
                attachmentState.cleanup().catch(() => {})
            }
        }, [attachmentState])

        return html`
        <div class="card attachment-panel">
            <p>Encrypt and progressively decrypt an audio attachment</p>

            <div class="attachment-controls">
                <button
                    onClick=${attachmentState.generate}
                    disabled=${!attachmentState.canGenerate.value}
                >
                    Generate
                </button>
                <button
                    onClick=${attachmentState.play}
                    disabled=${!attachmentState.canPlay.value}
                >
                    Play
                </button>
                <button
                    onClick=${attachmentState.seek}
                    disabled=${!attachmentState.canSeek.value}
                >
                    Seek to 0:08
                </button>
                <button
                    onClick=${attachmentState.stop}
                    disabled=${!attachmentState.canStop.value}
                >
                    Stop
                </button>
            </div>

            <p class="attachment-status" aria-live="polite">
                ${attachmentState.status.value}
            </p>
            <p class="attachment-progress" aria-live="polite">
                ${`Decrypted ${attachmentState.segmentsDone.value} / ` +
                    `${attachmentState.segmentsTotal.value} segments`}
            </p>
        </div>
        `
    }
