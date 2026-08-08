import type { FunctionComponent } from 'preact'
import { html } from 'htm/preact'
import { CardHeader } from '../example-shared/card-header.js'
import type { DeviceInfo } from './device-info.js'
import { EM_DASH, SPACE } from '../example-shared/constants.js'

export interface DeviceInfoPanelProps {
    info:DeviceInfo;
    onClear:() => void;

    // Rotate this one client's leaf key. Optional, and shown only for a
    // device that holds a leaf: a client with no group state has nothing
    // to rotate.
    onRotate?:() => void;

    // A rotation by this device is in flight -- one commit, so a second
    // click must not race it.
    rotating?:boolean;

    // Revoke this one client's leaf. Optional, and shown only for a
    // device that holds a leaf: a client with no group state is already
    // out.
    onRemove?:() => void;

    // A removal of this device is in flight.
    removing?:boolean;

    // No other client holds a leaf to commit the removal from, so the
    // control is shown disabled with an explanation rather than left to
    // fail on click. RFC 9420 does not let a member commit its own
    // removal.
    removeBlocked?:boolean;

    // Save this one client's state to storage. Optional, and shown only
    // for a device that holds a leaf: a client with no group state has
    // nothing to save.
    onPersist?:() => void;

    // A write for this device is in flight.
    persisting?:boolean;

    // This device's state is already in storage.
    persisted?:boolean;
}

/**
 * One device's MLS state, shown in the card the tree diagram otherwise
 * occupies. The card keeps its header -- same shell, different title --
 * so Clear stays where it was and the swap reads as the same card
 * showing something else.
 */
export const DeviceInfoPanel:FunctionComponent<
    DeviceInfoPanelProps
> = function ({
    info,
    onClear,
    onRotate,
    rotating,
    onRemove,
    removing,
    removeBlocked,
    onPersist,
    persisting,
    persisted
}) {
    return html`
        <div class="card device-info">
            <${CardHeader}
                title="Device Info"
                showClear=${true}
                onClear=${onClear}
            />

            <div class="device-info-body">
                <p class="who">
                    <span class="icon" aria-hidden="true">
                        ${info.device.icon}
                    </span>
                    <span class="label">${info.device.label}</span>
                    <span class="owner">${info.user}</span>
                </p>

                <p class="client-id"><code>${info.clientId}</code></p>

                <p class="membership ${info.inGroup ? 'in-group' : ''}">
                    ${info.inGroup ? 'in group' : 'not in group'}
                </p>

                ${info.inGroup ? html`
                    <dl class="device-state">
                        <dt>Leaf index</dt>
                        <dd class="leaf-index">${info.leafIndex}</dd>

                        <dt>Node index</dt>
                        <dd class="node-index">${info.nodeIndex}</dd>

                        <dt>Epoch</dt>
                        <dd class="epoch">${info.epoch}</dd>

                        <dt>HPKE public key</dt>
                        <dd class="pubkey">
                            ${info.hpkePublicKeyBase64 ??
                                'blank at this leaf'}
                        </dd>
                    </dl>

                    ${onRotate ? html`
                        <div class="device-actions">
                            <button
                                class="rotate"
                                onClick=${onRotate}
                                disabled=${!!rotating}
                            >
                                ${rotating ?
                                    'Rotating...' :
                                    'Rotate keys'}
                            </button>
                            <p class="hint">
                                A rotation is one commit by this client
                                alone: it replaces the key at this leaf
                                and at every node on its direct path. The
                                other devices keep their own leaf keys
                                and only follow the epoch.
                            </p>
                        </div>
                    ` : null}

                    ${onPersist ? html`
                        <div class="device-actions">
                            <button
                                class="persist"
                                onClick=${onPersist}
                                disabled=${!!persisting || !!persisted}
                            >
                                ${persisting ?
                                    'Persisting...' :
                                    persisted ? 'Persisted' : 'Persist'}
                            </button>
                            <p class="hint">
                                Each device stores its own
                                ${SPACE}<code>ClientState</code> under its
                                own key. A person is not a unit of storage
                                any more than they are a unit of
                                membership ${EM_DASH} persisting this device
                                says
                                nothing about the other two.
                            </p>
                        </div>
                    ` : null}

                    ${onRemove ? html`
                        <div class="device-actions">
                            <button
                                class="remove"
                                onClick=${onRemove}
                                disabled=${!!removing || !!removeBlocked}
                            >
                                ${removing ?
                                    'Removing...' :
                                    'Remove from group'}
                            </button>
                            ${removeBlocked ? html`
                                <p class="hint blocked">
                                    This is the only client left in the
                                    group, and MLS does not let a member
                                    commit its own removal. Some other
                                    device has to still hold a leaf.
                                </p>
                            ` : html`
                                <p class="hint">
                                    The lost phone case: one leaf is
                                    revoked by another client's commit,
                                    and this device keeps its key package
                                    but loses its group state. The
                                    person's other devices carry on at
                                    the new epoch.
                                </p>
                            `}
                        </div>
                    ` : null}
                ` : html`
                    <p class="no-state">
                        ${info.created ?
                            'This device has a key package but has not ' +
                            'joined the group, so it holds no leaf, no ' +
                            'epoch, and no key material yet.' :
                            'This device does not exist yet. Create ' +
                            "its owner's devices to give it a key " +
                            'package.'}
                    </p>
                `}
            </div>
        </div>
    `
}
