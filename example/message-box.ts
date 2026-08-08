import type { FunctionComponent } from 'preact'
import { html } from 'htm/preact'
import type {
    PersonMessageView,
    DeviceMessageView
} from './message-view.js'

/**
 * One message as one person holds it. A person does not hold a message:
 * their devices do, separately, each under its own key schedule. So the
 * box opens in two steps -- the first says "decrypt this", the second
 * asks which client is doing the decrypting -- and every device that
 * wants the plaintext has to ask for it, including the other two devices
 * belonging to whoever sent it.
 */

export interface PersonMessageBoxProps {
    view:PersonMessageView;

    // The sending client, already described for a reader.
    from:string;

    // The epoch the message was sent at, as text.
    epoch:string;

    // The ciphertext, already encoded and truncated for display.
    ciphertext:string;

    // The reader has asked to see which devices can decrypt this.
    expanded:boolean;
    onExpand:() => void;

    onDecrypt:(clientId:string) => void;

    // The client whose decrypt is in flight, if any.
    decrypting?:string|null;
}

function deviceSection (
    device:DeviceMessageView,
    onDecrypt:(clientId:string) => void,
    decrypting:string|null
) {
    return html`
        <div key=${device.clientId} class="device-section">
            <label class="device-heading">
                <span class="icon" aria-hidden="true">
                    ${device.device.icon}
                </span>
                ${device.device.label}
            </label>

            ${device.decrypted ? html`
                <div class="decrypted-section">
                    <label>Decrypted:</label>
                    <div class="decrypted-text">${device.text}</div>
                </div>
            ` : device.inGroup ? html`
                <button
                    class="decrypt-btn device"
                    onClick=${() => onDecrypt(device.clientId)}
                    disabled=${decrypting === device.clientId}
                >
                    ${decrypting === device.clientId ?
                        'Decrypting...' :
                        'Decrypt'}
                </button>
            ` : html`
                <p class="hint not-in-group">
                    Not in the group, so it holds no key schedule for
                    this epoch.
                </p>
            `}
        </div>
    `
}

export const PersonMessageBox:FunctionComponent<
    PersonMessageBoxProps
> = function ({
    view,
    from,
    epoch,
    ciphertext,
    expanded,
    onExpand,
    onDecrypt,
    decrypting
}) {
    return html`
        <div class="message-box">
            <div class="message-header">
                <span class="from-machine">from machine</span>
                <strong>${from}</strong>
                <small>Epoch ${epoch}</small>
            </div>

            <div class="ciphertext-section">
                <label>Ciphertext:</label>
                <code class="ciphertext">${ciphertext}...</code>
            </div>

            ${expanded ? html`
                <div class="decrypt-with">
                    <label>Decrypt with:</label>
                    ${view.devices.map((device) => {
                        return deviceSection(
                            device,
                            onDecrypt,
                            decrypting ?? null
                        )
                    })}
                </div>
            ` : html`
                <button class="decrypt-btn expand" onClick=${onExpand}>
                    Decrypt
                </button>
            `}
        </div>
    `
}
