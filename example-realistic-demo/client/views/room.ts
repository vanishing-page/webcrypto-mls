import type { FunctionComponent } from 'preact'
import { html } from 'htm/preact'
import type { PendingRequest, Standing } from '../../protocol.js'
import { roomUrl } from '../routing.js'
import { decodeKeyPackageB64, keyPackageBelongsTo } from
    '../mls-actions.js'
import {
    membersFromTree,
    nameFromCredential,
    type Member
} from '../membership.js'
import type { RealisticState, SentMessage } from '../state.js'
import {
    buildTimeline,
    type TimelineItem,
    type TimelinePlaceholder,
    type TimelineText
} from '../timeline.js'
import { EM_DASH } from '../../../example-shared/constants.js'
import { followNewest, jumpToNewest } from '../stick-to-bottom.js'
import { ShareRoomLink } from './room-link.js'
import { CopyValue } from './copy-value.js'

export interface RoomProps {
    state:RealisticState
    onApprove (request:PendingRequest):void
    onDeny (identity:string):void
    onRemove (member:Member):void
    onSend (text:string):void
}

/**
 * What the room's ledger already knows about a requester, in words. The
 * room keeps a status per identity, so a person who was admitted once
 * and a person who was removed are different decisions -- and the page
 * says which.
 */
const STANDING_TEXT:Record<Standing, string> = {
    stranger: 'Nobody you have let in before.',
    'pre-approved': 'You have let this identity in before.',
    'previously-removed': 'You removed this identity from the room.'
}

/**
 * Enough of a room to prove the connection: the invitation, the socket's
 * status, the epoch the group is at, who is in the group, who is
 * connected right now, and what has been said.
 *
 * No hooks here on purpose. Everything it shows already lives in signals,
 * and staying hook-free is what lets it be called as a plain function in
 * the Node suite.
 */
export const Room:FunctionComponent<RoomProps> = function (props) {
    const { state, onApprove, onDeny, onRemove, onSend } = props
    const roomId = state.roomId.value
    const group = state.group.value
    const draft = state.draft.value

    // Removed is a normal end, not a failure: the commit that removed
    // this client processed correctly, and what it says is that the
    // client is no longer a member. Nothing below this point would be
    // true any more -- the tree it holds is the one it was removed at --
    // so the page says what happened and stops.
    if (state.removed.value) {
        return html`
            <section class="removed">
                <div class="block">
                    <h1>You were removed from this room</h1>
                    <p>The creator committed a change that took your
                        leaf out of the group. Everything said from that
                        point on is encrypted to keys you do not
                        have.</p>
                    <p>Nothing went wrong. This is what removal looks
                        like from the inside.</p>
                    <p class="status" role="status">
                        ${state.status.value}
                    </p>
                </div>
            </section>
        `
    }

    // Derived on every render rather than stored, so it follows
    // `state.group` -- which is reassigned for every commit this client
    // processes, live or replayed.
    const members = group ? membersFromTree(group.ratchetTree) : []
    const ownLeaf = group ? group.privatePath.leafIndex : null

    // The paragraph below explains the "Away" badge, so it is shown on
    // the same condition the badge is: somebody in the tree has no
    // socket open.
    const anyAway = members.some(member => {
        return !state.live.value.includes(member.identity)
    })

    // The only place a wire identity becomes a name. The room never
    // holds one, so a sender whose leaf has since been blanked by a
    // Remove has no name left to find -- `buildTimeline` says "unknown"
    // for that rather than dropping the message.
    const names:Record<string, string> = {}
    for (const member of members) names[member.identity] = member.name

    const items:TimelineItem[] = buildTimeline({
        entries: state.entries.value,
        decrypted: state.decrypted.value,
        names,
        joinCursor: state.joinCursor.value,
        priorCount: state.priorCount.value
    })

    // Which of those messages this client said itself. The leaf index
    // is the only thing the group knows about which leaf is ours, so
    // the identity is read back out of the tree through it rather than
    // held separately, and it follows a Remove that renumbers nothing
    // for the same reason `members` does.
    const own = members.find(member => member.leafIndex === ownLeaf)
    const ownIdentity = own ? own.identity : null
    const ownName = own?.name ?? state.user.value?.name ?? ''

    const outbound = state.outbound.value
    const empty = items.length === 0 && outbound.length === 0

    return html`
        <section class="room">
            <h1>Room</h1>

            ${/* Two columns where there is room for two, and the
                  division is the page's own subject: what the room is
                  -- who is in it, how to get in, who is connected right
                  now -- stands apart from what has been said in it.
                  Stacked, the same two run in the same order, so
                  nothing lives only in a column that is not there.

                  Those columns belong to the page, not to this section.
                  `.room` is `display: contents`, so these two divs are
                  items in the page's own grid alongside the persistence
                  control and the explainer, and that is what lines all
                  four of them up. A third child added here would need
                  placing in the sheet; see "The page's two columns". */''}
            <div class="room-meta">
                <div class="block">
                    ${/* The socket's status and the group's epoch, side
                          by side as the labelled machine values they
                          are. The two come from different places -- the
                          room's roster and this client's own group --
                          and the strip is where every such value on
                          this page is read. */''}
                    <dl class="readout">
                        <div class="readout-item">
                            <dt>Connection</dt>
                            <dd
                                class="connection"
                                data-status=${state.connection.value}
                            >${state.connection.value}</dd>
                        </div>

                        ${group ? html`
                            <div class="readout-item">
                                <dt>Epoch</dt>
                                <dd><span class="epoch">${
                                    String(group.groupContext.epoch)
                                }</span></dd>
                            </div>
                        ` : null}
                    </dl>

                    ${roomId ? html`<${ShareRoomLink}
                        url=${roomUrl(location.origin, roomId)}
                        onError=${(err:unknown) => {
                            state.status.value =
                                `Could not copy the URL: ${err}`
                        }}
                    />` : null}
                </div>

                ${state.isCreator.value ? html`
                    <div class="block">
                        <h2>Asking to join</h2>
                        <ul class="pending">
                            ${state.pending.value.map(request => {
                                return requestItem(
                                    request,
                                    onApprove,
                                    onDeny
                                )
                            })}
                        </ul>
                    </div>
                ` : null}

                <div class="block">
                    <h2>In this group</h2>
                    <ul class="members">
                        ${members.map(member => {
                            return memberItem(
                                member,
                                state.live.value.includes(member.identity),
                                state.isCreator.value &&
                                    member.leafIndex !== ownLeaf,
                                member.leafIndex === ownLeaf,
                                onRemove
                            )
                        })}
                    </ul>

                    ${anyAway ? html`
                        <p class="presence-disclosure">
                            Away means nobody is holding a socket open
                            right now. The member is still in the group
                            and their leaf is still in the tree ${
                                EM_DASH} they will catch up on what they
                            missed when they come back.
                        </p>
                    ` : null}

                    <p class="removal-disclosure">
                        Only the room creator is offered a "Remove" control.
                        That is a rule enforced by application logic, not
                        the cryptography.
                    </p>
                </div>

                <div class="block">
                    <h2>Connected now</h2>

                    <p class="identity-disclosure">
                        The signature public key, base64url encoded.
                        That is what the room routes on, not a display
                        name.
                    </p>

                    <ul class="live">
                        ${state.live.value.map(identity => {
                            const own = identity === ownIdentity
                            return html`<li
                                key=${identity}
                                data-own=${own}
                            >${identity}${own ? html`
                                <span class="own-mark"> You</span>
                            ` : null}</li>`
                        })}
                    </ul>
                </div>

                ${youBlock(
                    ownName,
                    ownIdentity,
                    ownLeaf,
                    state.isCreator.value,
                    (err:unknown) => {
                        state.status.value =
                            `Could not copy the key: ${err}`
                    }
                )}
            </div>

            ${/* The log is read the way a chat is read: oldest at the
                  top, newest at the bottom, and the end of it in view.
                  So the log scrolls inside a panel of its own rather
                  than lengthening the page, which is what keeps the
                  composer where it can be reached without scrolling to
                  find it and what lets the newest message stay put as
                  entries arrive. `stick-to-bottom.js` does the
                  following, and says there why it is not a hook. */''}
            <div class="room-log">
                <div class="block chat">
                    <h2>Messages</h2>

                    ${/* `role="log"` is the transcript's own role: it
                          makes this a polite live region that announces
                          additions only, which is what an arriving
                          message is. It is on the scroll container
                          rather than on the list so the list keeps
                          being a list. `tabindex` because a scrollable
                          div is not otherwise reachable by keyboard in
                          every browser, and a log you cannot scroll
                          without a pointer is a log half the people
                          here cannot read. */''}
                    <div
                        class="log-scroll"
                        role="log"
                        aria-label="Messages"
                        tabindex="0"
                        ref=${followNewest}
                    >
                        ${/* Two zero-height rails, sticky to the top
                              and bottom edges of the scrollport. Each
                              draws a rule only while there is something
                              past that edge, so the panel says which of
                              its ends is the end of the log. First and
                              last in the DOM on purpose: a sticky
                              element is held inside the box it appears
                              in, so one placed after the list would
                              only reach the edge once you had scrolled
                              to it. */''}
                        <div class="log-edge" data-edge="top"></div>

                        <ul class="timeline">
                            ${items.map(item => {
                                return item.kind === 'text' ?
                                    messageItem(
                                        item,
                                        item.sender === ownIdentity
                                    ) :
                                    placeholderItem(item)
                            })}
                            ${outbound.map(outboundItem)}
                        </ul>

                        ${empty ? html`
                            <p class="log-empty">
                                Nothing has been said in this room yet.
                            </p>
                        ` : null}

                        <div class="log-edge" data-edge="bottom">
                            <button
                                type="button"
                                class="jump-newest"
                                onClick=${jumpToNewest}
                            >Jump to newest</button>
                        </div>
                    </div>

                    ${/* Under the log and outside it, so it holds still
                          while the log moves. What the placeholders
                          mean stands beside the panel instead of below
                          the composer -- it is worth reading, and it is
                          not worth spending the log's height on. */''}
                    <form
                        class="composer"
                        onSubmit=${(ev:{ preventDefault ():void }) => {
                            ev.preventDefault()
                            onSend(draft)
                        }}
                    >
                        <substrate-input
                            label="Say something"
                            placeholder="Say something"
                            class="draft"
                            value=${draft}
                            autocomplete="off"
                            onInput=${(ev:{
                                currentTarget:{ value:string }
                            }) => {
                                state.draft.value = ev.currentTarget.value
                            }}
                        />
                        <substrate-button
                            class="send"
                            type="submit"
                            disabled=${draft.trim() === ''}
                        >Send</substrate-button>
                    </form>
                </div>
            </div>
        </section>
    `
}

/**
 * One request. The name is read out of the key package, which is the
 * only place it exists -- the room never holds a display name.
 *
 * An undecodable key package is still listed. A request arriving off a
 * socket is untrusted, and hiding one the creator cannot act on would
 * leave them with no explanation for a person who says they asked.
 *
 * A plain function called by `Room` rather than a child component: a
 * component would render as an unexpanded vnode when `Room` is called
 * directly, which is how the node suite asserts on it.
 */
function requestItem (
    request:PendingRequest,
    onApprove:(request:PendingRequest) => void,
    onDeny:(identity:string) => void
) {
    const keyPackage = decodeKeyPackageB64(request.keyPackage)
    const name = keyPackage ?
        nameFromCredential(keyPackage.leafNode.credential) :
        'Unreadable request'

    // Two ways a request cannot be acted on, and they are different
    // things to say. One did not decode at all; the other decoded into
    // somebody else's key package, which is worth naming out loud
    // because it is the only sign the page can give that a request is
    // not what it claims. See `keyPackageBelongsTo`.
    const coherent = keyPackage !== null &&
        keyPackageBelongsTo(keyPackage, request.identity)

    return html`
        <li
            key=${request.identity}
            class="request"
            data-standing=${request.standing}
        >
            <span class="requester-name">${name}</span>
            <span class="standing">${STANDING_TEXT[request.standing]}</span>

            ${request.standing === 'previously-removed' ? html`
                <p class="standing-warning">
                    Letting them back in gives them the group's keys
                    from this point on.
                </p>
            ` : null}

            ${keyPackage !== null && !coherent ? html`
                <p class="mismatch-warning">
                    The key package attached to this request belongs to
                    a different identity than the one that asked. It
                    cannot be approved. Nothing here says who sent it.
                </p>
            ` : null}

            <substrate-button
                class="approve"
                disabled=${!coherent}
                onClick=${() => onApprove(request)}
            >Approve</substrate-button>
            <substrate-button
                class="deny"
                onClick=${() => onDeny(request.identity)}
            >Deny</substrate-button>
        </li>
    `
}

/**
 * Who this client is: the name and key that identify it, then its
 * standing in the group. Every value is already derived in `Room` --
 * this holds no state and looks nothing up.
 *
 * The name is a plain string rather than `Member|undefined` because the
 * fallback is `Room`'s to choose, not this function's; see the call.
 */
function youBlock (
    name:string,
    identity:string|null,
    leaf:number|null,
    isCreator:boolean,
    onCopyError:(err:unknown) => void
) {
    return html`
        <div class="block you">
            <h2>You</h2>

            ${/* `dt` above `dd` rather than the flex strip below: the
                  key is 43 characters and does not sit beside a
                  label. The disclosure cannot go between these two
                  items -- a `p` is not valid between the `dt`/`dd`
                  groups of a `dl` -- so it follows the list. */''}
            <dl class="you-identity">
                <div class="you-item">
                    <dt>Name</dt>
                    <dd><span class="own-name">${name}</span></dd>
                </div>

                ${identity !== null ? html`
                    <div class="you-item">
                        <dt>Signature public key</dt>
                        <dd>
                            <span class="own-identity">${identity}</span>
                            <${CopyValue}
                                value=${identity}
                                label="Copy your signature public key"
                                onError=${onCopyError}
                            />
                        </dd>
                    </div>
                ` : null}
            </dl>

            <p class="name-disclosure">
                Your chosen username is not a secret. The username rides in
                your key package as a credential, in plain text,
                and the server can read it.
            </p>

            ${/* The same shape as the Connection/Epoch strip at the top
                  of this column, and the same class, so it inherits
                  that rule's dividers and label register rather than
                  restating them. */''}
            <dl class="readout">
                ${leaf !== null ? html`
                    <div class="readout-item">
                        <dt>Leaf</dt>
                        <dd><span class="own-leaf">${
                            String(leaf)
                        }</span></dd>
                    </div>
                ` : null}

                <div class="readout-item">
                    <dt>Role</dt>
                    ${/* The word is for a person; `data-role` is what a
                          test reads, so no assertion depends on the
                          wording. */''}
                    <dd
                        class="own-role"
                        data-role=${isCreator ? 'creator' : 'member'}
                    >${isCreator ? 'Room creator' : 'Member'}</dd>
                </div>
            </dl>
        </div>
    `
}

/**
 * One member. Two different kinds of fact meet here and are kept
 * visibly apart: the name and the leaf index come from this client's own
 * ratchet tree, and the connected mark comes from the room's roster,
 * which knows nothing about the group. A member the roster does not
 * name is away, not gone -- their leaf is still in the tree, and the
 * disclosure beside the list says so.
 *
 * A plain function rather than a child component, for the same reason
 * `requestItem` is one.
 */
function memberItem (
    member:Member,
    connected:boolean,
    canRemove:boolean,
    own:boolean,
    onRemove:(member:Member) => void
) {
    return html`
        <li
            key=${member.identity}
            class="member"
            data-connected=${connected}
            data-own=${own}
        >
            ${/* The marker is a real element, not a `::after`:
                  generated content is not reliably announced, and a
                  mark only sighted readers get would answer this
                  question for some of the people asking it. It sits
                  inside the name cell so the row stays two grid
                  columns wide.

                  The leading space inside the span is load-bearing. htm
                  strips the whitespace-only text around the newline
                  above, so without it the name and the marker flatten
                  to one word -- "AliceYou" -- and that is what a screen
                  reader announces. No CSS can put the boundary back:
                  margin and padding are box-model, and the accessible
                  text run does not see them.

                  It is also not redundant with `.own-mark`'s
                  `margin-left`. That rule sets the visible gap; this
                  space sets the spoken one, and what you see is the two
                  together. Removing either because the other looks like
                  it covers the job breaks the half it does not. */''}
            <span class="member-name">${member.name}${own ? html`
                <span class="own-mark"> You</span>
            ` : null}</span>
            <span class="presence">
                ${connected ? 'Connected' : 'Away'}
            </span>

            ${canRemove ? html`
                <substrate-button
                    class="remove"
                    onClick=${() => onRemove(member)}
                >Remove ${member.name}</substrate-button>
            ` : null}
        </li>
    `
}

/**
 * One message this client could read. `from` is a display name out of
 * the ratchet tree, resolved by `buildTimeline` -- the room holds no
 * names, and the entry itself carries only a signature public key.
 *
 * `own` is decided on the sender's wire identity rather than on the
 * name shown, because a name is not a key: two members are free to
 * choose the same one, and marking somebody else's message as yours
 * would be a lie about who said it.
 *
 * Every row keeps its number and its attribution, including a run from
 * one person. Collapsing a run the way a messenger does would read as
 * more chat-like and say less: what this page is about is that each
 * entry is numbered and attributed, and the rows where that is missing
 * are the placeholders.
 *
 * A plain function rather than a child component, for the same reason
 * `requestItem` is one.
 */
function messageItem (item:TimelineText, own:boolean) {
    return html`
        <li
            key=${`text-${item.seq}`}
            class="message"
            data-seq=${item.seq}
            data-own=${own}
        >
            <span class="seq">${String(item.seq)}</span>
            <span class="message-from">${item.from}</span>
            <span class="message-text">${item.text}</span>
        </li>
    `
}

/**
 * A run of entries this client cannot read, as one row saying how many.
 * The count is the point: a wall of identical "cannot read this" rows
 * would say less, and hiding them altogether would misrepresent the
 * history as complete.
 */
function placeholderItem (item:TimelinePlaceholder) {
    return html`
        <li
            key=${`gap-${item.reason}-${item.seq}`}
            class="placeholder"
            data-reason=${item.reason}
            data-count=${item.count}
        >
            <span class="gap-text">${item.reason === 'before-join' ?
                `${item.count} message(s) sent before you were let in` :
                `${item.count} message(s) you do not hold the keys for`}</span>
        </li>
    `
}

/**
 * A message this client sent that the room has not numbered back to it
 * yet. Marked apart from a delivered one rather than hidden: it is on
 * its way, and it takes the place of the row the echo will bring back a
 * moment later, so what was typed is on the page immediately either way.
 */
function outboundItem (sent:SentMessage) {
    return html`
        <li key=${`outbound-${sent.payload}`} class="outbound-message">
            <span class="seq-pending" aria-hidden="true">--</span>
            <span class="message-from">You</span>
            <span class="message-text">${sent.text}</span>
        </li>
    `
}
