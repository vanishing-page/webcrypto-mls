# example-realistic-demo

The Worker behind the realistic demo: a Durable Object room, its wire
contract, and its pure rules.

## Where a decision belongs

`room-logic.ts` holds every rule that touches no storage, no globals and
no network, so it can be unit tested in Node. `index.ts` holds the
storage and socket work and calls those rules. A new authorization or
ordering rule goes in `room-logic.ts` as a pure function, applied by a
small `requireX` helper in `index.ts` that sends the refusal. See
`mayWriteLog` and `requireMember`.

Guard order inside a handler is part of the behavior. `requireRoom` runs
before `requireMember`, because an expired room's ledger is empty and the
reverse order would tell a member they are not one.

## The client

`client/` follows the same split as the Worker. It is not covered by
this directory's `tsconfig.json`, whose `include` names four files and
stops at the Worker; the root config is what typechecks `client/`, and
running only the Worker one over a client change checks nothing. Confirm
with `npx tsc -p ../tsconfig.json --noEmit --listFiles | grep client`.

 `delivery-cursor.ts` and
`entry-queue.ts` are pure -- no DOM, no `WebSocket`, no signals -- so they
are unit tested in Node from `test/example-realistic-demo/`. The socket
that obeys those rules lives in `delivery-client.ts`. Anything that needs
a browser to run belongs on the I/O side of that line, or it stops being
testable.

The entry queue takes its apply function as an argument for the same
reason: that is what makes "a live entry arriving mid-replay is applied
after the batch" a Node test rather than a browser step.

`delivery-client.ts` is unit tested even though it is the I/O side: Node
gets a fake `WebSocket` constructor and a fake `location` on
`globalThis`, in the same shape as `installFakeIndexedDB`. The fake's
`close()` must fire its close event from a microtask, never
synchronously. `connect()` closes the previous socket before it adopts
the new one, so a synchronous close runs the old socket's listener while
that socket is still the current one -- the retirement check cannot see
it, and a deliberate replacement reads as a dropped connection. A
synchronous fake would pass against code that reconnect-loops in a real
browser.

Do not fake the clock for the reconnect backoff. Poll for the outcome
against a deadline derived from `RECONNECT_BASE_MS`, and return the
predicate rather than throwing, so a reconnect that never arrives fails
an assertion instead of passing as a timeout. And close the client in a
`finally` in every test: a leaked keepalive interval or reconnect timer
keeps the bundled suite's process alive past its last assertion.

`state.ts` holds one client, not a map of them, and `view` is a
`computed` -- derived from `roomMissing`, `user`, `roomId` and `group`,
never assigned. Adding a screen means extending that derivation, not
adding a writable signal beside it, or the two can disagree. Guard order
inside it is behavior, the same as in the Worker: `roomMissing` is
checked first, so a room that has expired reads as gone rather than as
whatever the other three signals still say.

`connection.ts` is the only dispatcher for inbound `RoomMessage`s and
the only owner of the open hook. Extend `applyEntry` and `onControl`
through `ConnectionDeps`; do not add a second switch over `msg.type`
somewhere else, and do not call `deps.onControl` more than once per
message. The cursor moves in exactly two places -- here after a
successful apply, and in `delivery-client.ts`'s `onError` for an
undecryptable `application` entry -- and never from a control message.

Entries with no group are not simply dropped. `pushEntries` has three
states, not two: group present (queue it), a Welcome in flight (hold,
then flush when the join resolves), and neither (drop, because the
post-`welcome-you` replay re-delivers it). Collapsing the middle state
into a plain null check throws away the entire replay of a joiner who
was offline when approved, which is the demo's headline scenario, and
nothing re-requests it because the keepalive prevents the reconnect.

Everything the client says on a fresh socket goes in `onOpen`, not in
the handler that decided to connect. `connect()` returns while the
socket is still CONNECTING, so a submit handler has nothing to send on;
and a message sent from `onOpen` is re-sent on every reconnect for free,
which is what makes a join request outlive a dropped connection. The
page supplies the *decision* through `ConnectionDeps` -- `isCreating()`,
`joinRequest()` -- and `onOpen` owns the order the messages go in.
`hello` comes first either way: the room attaches a socket to an
identity there, and an unattached socket has nobody to answer.

`mls-actions.ts` is the only place the client calls the MLS library.
Base64 is split: the two encoders come from `../../src/index.js`, and
the decoders `base64ToBytes`/`base64urlToBytes` are not re-exported
there, so they come from `../../src/util/byte-array.js`. All four
already exist -- never write a fifth.

`state.ts` and `mls-actions.ts` are unit tested in Node too. `state.ts`
imports `@preact/signals`, which bundles and runs under
`--platform=node` without a DOM, so a derived-view test needs no browser.

In those tests, never reach through a `!` on a value the test is itself
asserting is present -- `decoded![0]` throws when the assertion above it
has just failed, and the throw aborts the rest of the file rather than
failing one assertion. Guard with a ternary so the following tests still
report. This masked a mutation until it was fixed.

## Membership comes from the tree, never from the room

`membership.ts` derives the member list from the client's own
`RatchetTree`. The room never parses a commit, so it cannot know the
roster; the `roster` message supplies only the connected and
disconnected marks, joined against this list by `identity`. `identity`
is the base64url of the leaf's `signaturePublicKey`, which is what the
room uses on the wire -- not the credential name, which is a display
label and is not unique.

The list is not compacted. A removed member's leaf is blanked, and the
survivors keep their original leaf indices, because a leaf index is
what a later Remove proposal names. Renumbering would silently retarget
a removal at the wrong person. Leaf index math is `nodeToLeafIndex` from
`src/treemath.js`, not an inline `/ 2`.

## Approving is serial, and its send order is a rule

`approvals.ts` owns letting someone in, kept out of both the page and
the view because its ordering rules are the behavior worth testing and a
rule that can only be checked in a browser is a rule nothing checks.

Three frames go out per approval, in one order: the commit, then the
Welcome, then the `approve`. The commit is first so it is already in the
log when the room stamps the Welcome's cursor at the current high-water
seq; the `approve` is last so the ledger only records an admission that
actually happened. They are chained with `&&`, and a `send` that returns
false throws rather than advancing the local group -- a creator at an
epoch nobody else reached is worse than an approval made twice.

Approvals are committed one at a time, through a promise chain. Two Adds
committed from the same group state are both at the same epoch; everyone
else applies the first and rejects the second, and the second joiner is
welcomed into a group nobody is in. A pending list therefore gets walked
with `await` in the loop, never fanned out -- and the dispatcher does not
await one control message before handing over the next, so two lists
really can overlap.

A re-broadcast pending list still holds a row whose approval is in
flight. The in-flight set by identity is what stops a second Add for a
key package already in the tree; without it the creator is shown a
failure for somebody who was in fact let in.

Only `pre-approved` commits unprompted. `stranger` and
`previously-removed` always wait for a decision, and the second is
called out in the view -- re-admitting someone you removed is the choice
that should never be automatic.

A request from an identity already in the ratchet tree is answered with a
bare `approve` and no commit. This is not defensive tidying: a joiner
whose socket drops before its Welcome arrives still has no group, so its
next `hello` re-publishes the request, and the room -- which admitted
that identity already -- calls the second ask `pre-approved`. The library
refuses an Add for a leaf that is already there, so committing anyway
leaves the creator with a permanent row and a `ValidationError` on
screen, retried on every re-broadcast of the list. The lone `approve` is
what deletes the pending row; a request that has been answered has to
stop being asked.

## One lock over `state.group`, shared by all three writers

`chat.ts`, `approvals.ts` and `apply-entry.ts` each read `state.group`,
await an MLS call, and assign what it returned. Any two of them
overlapping throws one of those writes away, and which one is lost
decides how bad it is: a commit lost leaves this client at an epoch
nobody else is at, permanently, after the room was already told about
the new one; a send lost makes a spent generation live again, and the
next message encrypts a second plaintext under the same key and nonce.

So the ordering is not any one module's. `createGroupLock()` is built on
the page and passed to all three, and each module's own serialisation --
the chain in `approvals.ts`, the serial drain in `entry-queue.ts` --
orders only its own work against itself. A new module that reads the
group and writes it back has to take the same lock, and the read has to
be *inside* the job: a read taken before `lock.run` sees the state as it
was before whatever the lock is holding writes to it, which is the whole
of what the lock prevents.

The lock's tail deliberately never rejects. Chaining onto a rejected
promise would skip every job behind a failure -- one refused send would
silence the page for the rest of the session.

## A join request is the one write a stranger can cause

`onJoinRequest` asks only that the room exist, deliberately -- the join
flow is open. That makes it the only handler whose limits are about
volume rather than authority, and they live in `classifyJoinRequest` in
`room-logic.ts`: a size ceiling on the key package, a cap on distinct
pending identities, and a per-socket interval. A refusal writes nothing,
including the throttle, so a refused request can never be the storage
growth the limits exist to stop.

The throttle is socket-scoped and rides `SocketState`, not a table.
Identities are free to mint, so a per-identity limit throttles nobody;
opening a socket is the cost a flooder actually pays. Because it lives
in the attachment, `attach` has to carry it across every rewrite --
otherwise `hello` clears it and one `hello` per request is the reset.
Any future field with that property gets the same treatment.

The cap counts rows, not requests: `pending` is keyed by identity, so a
repeat request from an identity already queued replaces its own row and
is allowed through a full queue. Probe checks 24 and 25 prove the Worker
consults the rule; the cap itself is proved in Node, where sixty-five
requests cost nothing.

## Nothing binds the two halves of a join request but the creator

A `join-request` carries `identity` and `keyPackage` as separate fields
and the room stores both verbatim -- it holds key packages as opaque
strings and could not check them. The creator is the only party that
decodes one, so the creator is the only party that can check they agree,
and `keyPackageBelongsTo` in `mls-actions.ts` is where that happens.
Committing a request whose halves disagree adds a leaf nobody who asked
can open, addresses the Welcome to somebody who cannot read it, and has
the room record the claimant as admitted -- which is what `mayWriteLog`
reads to let an identity write to the log.

The check is applied in three places on purpose: `approvals.commit`
throws, because it is the only path that commits; `onPending` skips the
request *silently*, because that list is re-broadcast and a refusal
written to `state.status` there is rewritten on every broadcast for
ever; and `requestItem` disables Approve and renders a
`.mismatch-warning`, because a control nobody can use needs a reason
beside it. Any new field a socket sends alongside another gets the same
question asked of it: who bound these two?

## A terminal client state guards the applier, not the socket

Being removed closes the socket, and that is not enough. The entry queue
still holds whatever was pushed before the close, and the creator can
commit again immediately -- so `applyEntry` gets entries this client has
no key for. `processEntry` throws on them, and a throw out of
`applyEntry` is a failed commit: the queue stops and writes "Reload to
resynchronise" over the removed page's own explanation of what happened.
The guard is the first line of `applyEntry`, before the group check. Any
future state where this client stops being able to process entries goes
in the same place.

## The views

Every view splits into a presentational half driven entirely by props
and a stateful half that holds the hooks -- `SetupForm` beside `Setup`,
`RoomLink` beside `ShareRoomLink`. The reason is mechanical, not
aesthetic: the Node suite asserts on components by calling them as plain
functions, and a component that calls `useSignal` throws when invoked
outside a render. So the half worth asserting on must not call hooks. A
view with no local state at all -- `Room` -- stays hook-free and is
testable whole; keep it that way.

Component-local state is `useSignal`, never `useState`.

The sentences a view renders are part of what this demo teaches, and no
test asserts on them -- testing HTML text is forbidden here, so copy is
reviewed by reading it. For every claim a view makes about what the
demo does, name the line of code that makes it true. The waiting view
told people they could close the tab and pick the invitation up later,
which was false for the whole of Phase 7: the request survives in the
room, the private key that opens the Welcome does not survive anywhere.
Phase 8 made that sentence conditional rather than fixing it once --
with the session kept, the key does survive -- so `Waiting` takes
`persist` and says the matching thing. A claim that depends on a
setting has to be a function of that setting.

When copy does branch on a signal, mark the branch in a `data-`
attribute as well, so the node suite can assert which one rendered
without reading the words. Assert both: the mark, and that the two
renderings are not the same paragraph. A test that checks only the mark
passes against a page showing the wrong sentence with the right mark on
it, which is worse than not branching at all.

A `role="status"` region is rendered always, empty when it has nothing
to say, with its state in a `data-` attribute. Assistive technology
watches a live region for changes to its *contents*, so a region added
to the page at the moment it gains text announces nothing -- there was
nothing there to watch. `CopyControl` and `RoomLink` both confirm a copy
this way, and the empty flex item it leaves behind is deliberate.

A mark that annotates a value -- the "You" beside this client's own row
in the member list and the live list -- is a real element, not a
`::after`. Generated content is not reliably announced, and a mark only
sighted readers get answers this question for some of the people asking
it. Two things follow from it being an element. The space between the
mark and what it annotates goes *inside* the mark's own text, for the
reason in the root file's note on htm; margin cannot stand in for it.
And a browser harness reading that cell takes its own text nodes rather
than its `textContent`, or the marker joins the name it is comparing --
`membersOf` in `verify-phase7.mjs` and `memberNames` in
`verify-phase8-e2e.mjs` are the shape to copy.

`Setup` serves both arrivals: someone starting a room, and someone who
opened an invitation link. It tells them apart by `state.roomId.value`,
which the route has already set for the second. Only the joiner's half
may not call `createOwnGroup` -- a locally made group puts that page in
a room of its own that nobody else can ever see, and the `view`
computed would send it straight to the room screen instead of the
waiting one.

A view that reads `location` needs a fake installed on `globalThis` in
its test, same as `delivery-client.ts`'s. Better still, take the varying
part as a pure function -- `roomUrl(origin, roomId)` in `routing.ts` --
so the interesting half needs no fake.

`routing.ts` is pure and holds the one decision that turns a URL into a
screen. An id that fails `isValidRoomId` routes to `gone`, never to
`setup`: a mistyped invitation must not look like it worked, and a bad
id must never reach the socket.

`client/index.ts` is wiring only -- no rules, no decisions. It reads the
route, renders the view the `view` computed names, and catches anything
thrown so a failure never leaves the page blank. It is not unit tested,
which is only acceptable while it stays that thin.

`client/style.css` copies the custom-property block from
`example/style.css` rather than importing it, so the two applications
share a palette without sharing a ruleset. Never edit `example/style.css`
to change how this demo looks.

## The controls are web components that rewrite themselves

Every form control here is a `substrate-input`, a `substrate-button` or
a `check-box`, and the demo styles none of them itself. They are
registered in `client/index.ts` and nowhere else. That placement is a
constraint rather than tidiness: the Node suite calls views as plain
functions, and both `@substrate-system/web-component/util` (it binds
`document.querySelector` at module top level) and `check-box` (its class
extends `HTMLElement`) throw under Node. A registration import moved
into a view module crashes the bundle before the first test runs.

What each component then does to the DOM is invisible to the Node suite,
to `tsc`, to the build and to lint. It is only observable in a browser,
through the `scripts/` harnesses, and the three components do not agree
with each other. `substrate-input` copies the author's `class` onto the
host, the wrapper and the inner input alike, so an unscoped `.foo`
matches three elements; and it moves `id` and `aria-*` off the host
onto the inner input, so `#foo` resolves to the input rather than to
the element this demo wrote. That relocation is not what broke the
harnesses' `#display-name`: the id survives on the inner input, and
the selector died because converting the setup field dropped the
hand-written `id` in favour of the component's generated one.
`substrate-button` keeps `class` on the host and copies it to the inner
button, so `substrate-button.foo button` still resolves uniquely.

A browser check therefore targets the inner element rather than the
host, and for a submit button it has no choice: the host is taller than
its button, a centre click lands outside it, and a control relying on
native form submission gets nothing at all. Clicking a host only works
where Preact bound an `onClick` to that host. `SETUP_NAME_FIELD` and
`SETUP_SUBMIT_BTN` at the top of the harnesses are the shapes to copy.

`check-box` reads its `textContent` once, at `connectedCallback`, and
then calls `replaceChildren()` over whatever Preact put inside it. Its
label copy has to stay static: branching it on a prop or a signal
renders nothing at all. It is the one control where the rule above about
marking a branch in a `data-` attribute cannot be followed.

In the Node suite `findByType` names the custom-element tag
(`'substrate-input'`, `'substrate-button'`, `'check-box'`), and a
field's label is a prop on that tag rather than a sibling `<label>`.
`findByClass` is unaffected, since all three keep the author's `class`
on the host.

## Adding an error reason

Three edits, and missing any one of them is silent. `ErrorReason` in
`protocol.ts`, the `ERROR_REASONS` array just below it (the narrowing
predicate reads the array, not the type), and a case in
`test/example-realistic-demo/protocol.ts` for both `isErrorReason` and
`isRoomMessage`.

## Adding a wire field that carries a string

Every string on this socket is length-bounded, and the bound lives with
the narrowing predicate in `protocol.ts`, not in the handler. Use
`isIdentity` for anything that is a signature public key and `isPayload`
for anything base64 the room forwards without decoding; reach for the
raw `isStr` only for a field neither describes, and then give it its own
exported `MAX_*` constant. A new field added with a bare `isStr` is the
regression the M1 finding described, and nothing fails to warn you.

The frame wall in `index.ts` (`MAX_WIRE_MESSAGE_LENGTH`, checked before
`JSON.parse`) has to stay above `MAX_PAYLOAD_LENGTH`, or a legal
maximum-size payload can never fit inside a legal frame.

A join request's key package is deliberately bounded twice: loosely in
`protocol.ts` and tightly by `MAX_KEY_PACKAGE_LENGTH` in `room-logic.ts`.
Tightening the structural bound to match would turn
`key-package-too-large` into a bare `bad-message` and break probe check
24.

## The ledger

Two rows per identity at most, `admitted` and `removed`, keyed together.
It reads like history but is consumed as current status: approving an
identity deletes its `removed` row. Anything that subtracts removed from
admitted -- the roster's `known` set, `mayWriteLog` -- depends on that
delete, so a code path that adds a status without clearing its opposite
silently breaks the undo case.

## Testing

`scripts/` holds five verification executables and they check different
halves; see "Five harnesses, not one" below for which covers what. The
sixth file there, the hidden `.us023-mutate.mjs`, verifies nothing on its
own: it is the mutation harness that proves a probe check load bearing.

Which acceptance criterion is covered by which test, probe check or
browser check is written down once, in
`docs/implementation-plans/2026-07-27-realistic-demo/ac-coverage.md`,
including the three that are not fully covered and why. Add a row when
you add a criterion, and check that file before assuming something is
tested.

The Worker's `DurableObject` and its server-side `WebSocket` code have no
unit coverage by design. `scripts/probe.mjs` against a live
`npm run worker:realistic` is the only verification of the room, so a change to
`index.ts` needs a probe check or it is untested. This does not extend to
the client's socket: `delivery-client.ts` is covered in Node, as above.

Run `npm run build:realistic` before starting the dev server for a probe
run. The last check fetches the page, and wrangler serves it from `dist/`,
which is gitignored -- so on a fresh tree that check fails for a reason
that has nothing to do with the Room.

Write a probe check that asserts both polarities of a rule: who is
refused, and who still gets through. A check that only asserts the
refusal passes just as happily against a gate that refuses everyone.
Assert the refusal's effect too, not only its reply -- "no entry reached
a peer" and "no error came back" are different failures.

After `ws.close()`, always `await waitForClose(ws)`. A socket left
closing still appears in `getWebSockets()`, so a later check's Welcome or
roster can be answered by the previous check's corpse.

## Connection status is two signals, not one

`state.connection` is the machine-readable state
(`connecting`/`open`/`reconnecting`/`closed`) and `state.status` is the
human sentence. They are written in different places, so a transition
that updates one and forgets the other renders as a contradiction --
the page read "Connection: open" and "Connection lost. Reconnecting..."
at the same time until the reconnect path cleared the notice it wrote.
When adding a state transition, write both, in one `batch()`.

The same defect appeared twice, so treat the notice as owed rather than
optional: whoever writes an in-flight sentence (`index.ts` writes
"Opening room ...", `delivery-client.ts` writes "Connection lost.")
owns nothing, because the message that ends the wait is handled
somewhere else entirely -- in the `connection.ts` dispatcher. A notice
with no handler to retire it stays on screen for the life of the page.
When adding a message that ends a wait, clear the sentence that
announced it.

## A terminal state has to be written, not awaited

`state.connection` is only ever advanced by something that actually
happens, which breaks down for the transitions where nothing will. A
deliberate `close()` while a reconnect is pending has no socket left to
emit a close event, so leaving `'closed'` to the event handler leaves
the page reading `reconnecting` for good. Where the event that would
report a transition may already have fired, write the state at the
point of decision as well; the handler setting the same value again is
harmless.

The reconnect timer is the other half of this. `connect()` and
`close()` both make a pending attempt redundant, and a timer nobody
cancels fires later into a state it was not written for -- replacing a
socket that is already open. Any path that opens or retires a socket
cancels the timer first.

## Nothing may escape the entry queue's drain

`push()` starts `drain()` and never awaits it, so a throw inside the
drain is an unhandled rejection, `draining` stays `true`, and every
later push is swallowed in silence because `push` believes a drain is
already running -- a wedge with no symptom. The `apply` call is
guarded; so is the `onError` handler, which writes signals and can
therefore throw. A handler that fails is treated as `'stop'`, since an
entry whose failure nobody handled is exactly the case where advancing
past it would corrupt the epoch. Adding a call inside `drain` means
guarding it too.

## A failed entry is two different failures

`onError` in `delivery-client.ts` decides between them and the room's
survival depends on getting it right. An entry whose payload is not an
MLS message at all is skipped: the cursor advances and the queue carries
on, because no group state could have moved. An entry that decodes and
then fails to process stops the queue, because an epoch really did pass
that this client could not follow.

Nothing on `LogEntry` distinguishes them. `kind` is asserted by the
sender and the room stores it verbatim beside a payload it holds as an
opaque string, so any admitted member can write `{kind:'commit',
payload:'AAAA'}`. Read as a failed commit it stops every other member's
queue at that seq permanently -- `hello` resends the same cursor, the
replay serves the same entry, and it fails identically for ever. This
was security-audit.md H2.

The answer is `MalformedEntryError` in `malformed-entry.ts`, thrown by
`processEntry` from the decode step only and recognised by
`isMalformedEntry`. Anything that widens where it is thrown -- wrapping
the `processMessage` call, say -- turns a real desync into a silent skip
and is the more dangerous of the two mistakes. The base64 decode is
inside that step deliberately: `atob` throws on a payload that is not
base64 in a browser while node's `Buffer` quietly drops the bad
characters, so a catch that looks unreachable in the Node suite is the
path a browser actually takes.

## `processMessage` refuses nothing on your behalf

`src/process-messages.ts` dispatches on one wireformat and treats
everything else as private: `if (wireformat === 'mls_public_message')
... else return processPrivateMessage(state, message.privateMessage,
...)`. Hand it a Welcome or a key package and it reads
`.privateMessage` off a message that has none, so the failure arrives as
a `TypeError` from inside the library rather than as a refusal. Anything
decoding a payload off a socket -- `processEntry` in `mls-actions.ts` --
checks the wireformat itself before calling in. A test asserting only
"it threw" cannot tell the two apart, because the crash throws too;
assert which error arrives.

## A replay carries entries this client cannot read

`applyEntry` skips anything that is not a `commit`, and that guard is
load bearing rather than tidy. A joiner's replay includes application
messages sent before it joined, encrypted at epochs it holds no keys
for; `processMessage` throws on those, and a throw out of `applyEntry`
is what the entry queue reads as a failed commit -- so the queue stops
and the page asks the person to reload, over a message that was never
theirs. The same applies to this client's own entries, which arrive both
live and on replay; see the next section.

Testing this needs the payload the client *cannot* decrypt. An
application entry it can decrypt leaves `state.group` alone either way,
because `processMessage` returns an application message's plaintext
without a `newState` and nothing gets reassigned.

## The room echoes an entry to its sender

`onMls` broadcasts to every socket, the sender's included, and that is a
consequence of the cursor rule rather than a convenience. A cursor may
advance by exactly one and may never skip a gap, so a client that is
never told the `seq` of its own write is stuck below it for good: the
next entry from anybody else reads as a gap, which stops the queue for a
`commit` and is dropped for an `application`. Withholding the sender's
copy therefore wedges any client that writes -- invisible through Phase
7, where only the creator ever wrote to the log, and immediate as soon as
two clients chat. Probe check 6 is the check that says so; restoring the
`if (peer === ws) continue` it replaced makes that check fail.

The sender cannot read its own copy -- MLS cannot decrypt a message it
produced -- so `chat.ts` records the plaintext at send time and
`apply-entry.ts` matches it to the echo. The match is **on the
ciphertext**, not on order: `state.outbound` holds `{ payload, text }`
pairs, and `recordOwn` finds the pair whose `payload` equals the echoed
entry's. The room stores a payload verbatim and hands back the same
bytes -- probe check 5 is what says so -- and two sends never share a
payload, because each reads a fresh generation out of the sender's secret
tree.

A positional FIFO looks equivalent and is not. `send()` returning true
means only that the socket was open; a frame handed to a socket that dies
before it flushes is discarded, and nothing tells the page. The list can
therefore hold a send the room never logged, and a positional match would
file that message's text against the next echo's seq -- the wrong words
under a real message for the rest of the session, and the right ones
stuck in flight for ever. `test/example-realistic-demo/apply-entry.ts`
has the check; making the index positional makes it fail.

No match at all is the ordinary case after a reload: nothing persists the
plaintexts, so those messages become placeholders, which is honest.

## Persistence is a preference plus an effect

`session.ts` decides *when* a record is written; the record's shape and
its pure helpers are `createSessionStore` in
`example-shared/persistence-storage.ts`. Turning the toggle on writes
whatever exists at that moment, including nothing at all -- the control
is offered before there is a user, so "no user yet" is a normal state
that records the preference and writes as soon as there is something to
write.

`watch()` is what keeps the record current, and it is an `effect`, so
what it re-saves on is exactly the set of signals `sessionInputFrom`
reads. Read them all before any early return, or a field left behind a
guard silently stops triggering a re-save. This also makes the explicit
save inside `setPersist(true)` redundant end to end while `watch()` is
running -- the browser harness cannot distinguish it, and the Node test
for `setPersist` is what covers it.

`createSessionStore` holds one connection and closes it in
`deleteDatabase`. An IndexedDB delete is *blocked*, not failed, while any
connection is open, and a blocked delete resolves nothing -- so a store
that opened a fresh connection per operation would have the Delete
control report success and remove nothing until the tab closed. Only the
browser can show this; no Node fake models `blocked`.

`client/timeline.ts` is the rendering half of the same fact, and it is
pure for the same reason `delivery-cursor.ts` is. An entry this client
cannot read is a counted placeholder, never an error: forward secrecy
means an absent member genuinely cannot read some of what they missed,
and `retainKeysForEpochs` is 4, so this happens to members who were
present at the time. Two rules there are easy to get wrong. The count of
what came before the join is the room's, from
`countApplicationsAtOrBelow` -- never a local count, because the client
is not sent those entries at all. And an entry the client sent itself
renders from plaintext it recorded when it sent it, so its own past
messages are not a wall of placeholders on replay.

## What a restore has to derive rather than read

A record holds the `ClientState` and the room-level facts, and nothing
else. Every other signal the page reads has to be *derived* from those on
the way back in, and `state.removed` is the one that bites:
`groupActiveState.kind === 'removedFromGroup'` is in the stored state,
`state.removed` is not, so restoring the group alone brings a removed
client back as a member of a group it is not in -- full room, member list
from the tree it held at the removal, composer and all -- and then the
first replayed entry past the removal throws in `processEntry` and reads
as a fatal commit. `restore` derives it, and `restoreSession` opens no
socket for a removed client, since a `hello` would put it back on the
roster the removal took it off. `partitionRestorableRecords` in the
member store treats a non-active record the same way, for the same
reason.

`storedRoomIsWanted` takes the whole `Route`, not a room id. As a
`string|null` the bare origin and an id that cannot name a room arrive
identically, so a mistyped invitation drew the gone view and then had it
replaced -- by this page, address bar included -- with whatever room the
browser had a session for.

## Five harnesses, not one

Five of the six files in `scripts/` verify something, and they are
complementary, not alternatives. `probe.mjs` drives the Worker over raw
sockets with opaque payloads and no browser; it is the room's only
verification, and it needs only `npm run worker:realistic`.

The other four drive the *pages* with Playwright and need
`npm run dev:realistic` as well. `verify-phase7.mjs` is the join
choreography end to end -- join, approve, welcome, membership, liveness,
removal, replay. The three Phase 8 scripts divide that phase's Task 6
between them: `verify-phase8-chat.mjs` covers steps 2, 3 and most of 7,
`verify-phase8-gone.mjs` covers steps 9 and 10, and
`verify-phase8-e2e.mjs` covers steps 4, 5, 6, 7.5 and 8.

Before writing another, read the headers -- each one says what it
declines to check and which script has it. Read `verify-phase7.mjs`'s
first whatever you are extending: how it drops a socket, and why it
filters sockets by URL, are both load bearing and are explained only
there. Each client is its own `chromium.launchPersistentContext`
directory: a second tab of one browser shares the database, so every
persistence check would pass for the wrong reason.

## A restored client's history is empty, by design

Persistence stores the cursor but not the log and not the plaintexts, so
a client that reloads resumes above everything it already saw and is
never re-sent it. What is on the page after a reload is what arrives
*next* -- no history, and no placeholder standing in for it either,
because `state.entries` never held those entries. The place a client's
own entry is genuinely re-delivered is the room's echo of a live send,
and that is where the plaintext recorded by `chat.ts` is observably what
renders. Any check written as "reload and confirm the old messages are
still there" is checking something this design does not do.

## Two origins to run the pages on, and which to pick

`npm run dev:realistic` (Vite, :1234) proxies `/api` to
`npm run worker:realistic` (wrangler, :8787) and is what the four Playwright
harnesses default to. It costs an HMR WebSocket on the page, which any
socket-level check has to filter out by URL, and it serves the client
from source rather than from the Worker.

The other way is `npm run build:realistic` then `npm run worker:realistic`
alone, and browse :8787. Wrangler then serves `dist` itself, so the page
and the room socket share one origin and the SPA fallback under test is
the Worker's own `not_found_handling`. Use this for anything about
origins, routing or the unmatched-path fallback -- and for hand testing,
which is what `docs/test-plans/2026-07-28-realistic-demo.md` says to do.

That test plan is the standing record of what neither harness reaches:
the alarm handler, a real clipboard paste, the deployed origin, and the
wording of the page's disclosures. Its coverage map is
`docs/implementation-plans/2026-07-27-realistic-demo/ac-coverage.md`. If
you add a criterion or a check, add the row there too.

## Security headers, and the one exit the Worker has

The default export's `fetch` is two lines: call `route`, then hand what
comes back to `withSecurityHeaders`. Add a reply by adding a branch to
`route`, never by returning from `fetch`, or that reply is the one that
ships without a policy. The policy itself is `securityHeaders` in
`room-logic.ts`, pure and unit tested like every other rule there.

Because the headers come from the Worker, `run_worker_first` is `true`
and the Worker serves the client itself through the `ASSETS` binding.
A page served without touching the Worker would carry no headers, so
scoping `run_worker_first` back to `/api/*` silently drops the policy
from the SPA shell and every asset while leaving the API looking fine.

`Content-Security-Policy` is `default-src 'none'` with `'self'` for
scripts and styles, which holds only while the client has no inline
script and no `style=` attribute. Adding either breaks the page in a
browser and in nothing else -- the Node suite and `probe.mjs` both still
pass -- so a change that touches how the client is rendered wants a load
of :8787 with the console open.

Any edit to `wrangler.jsonc` needs `npm run types:realistic` rerun and
the regenerated `worker-configuration.d.ts` committed, or the new binding
does not exist as far as the Worker typecheck is concerned.
