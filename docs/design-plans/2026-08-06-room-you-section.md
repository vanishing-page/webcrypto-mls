# A "You" section in the room

Add a block to the room page that says who this client is: the display
name, the base64url signature public key, the leaf index, and whether
this client created the room. Mark this client's own row in the two
lists that already name it.

Nothing is installed and no state is added. Every value the block shows
is already derived inside `Room`.

## Why

The room page shows a name in "In this group" and a signature public
key in "Connected now", and never says which of them is you. In a
single-browser session that is guessable. In the two-browser session
the demo is for, it is the first question a reader has, and the page
does not answer it.

The second reason is the disclosure. The paragraph under "Connected
now" carries two separate claims: that the room routes on a signature
public key rather than a name, and that a name is not hidden from the
server because a key package carries it in plain text. The first is
about the list it heads. The second is about the reader's own name,
which is nowhere on the page. Splitting them puts each sentence beside
the thing it describes.

## Scope

Four files:

| File | Change |
|------|--------|
| `example-realistic-demo/client/views/room.ts` | new block, marked rows, split disclosure |
| `example-realistic-demo/client/views/copy-value.ts` | new, a copy control for a plain string |
| `example-realistic-demo/client/style.css` | `.you`, `.own-mark` |
| `test/example-realistic-demo/views.ts` | new assertions |

Out of scope: `views/room-link.ts`. See "Why RoomLink is left alone".

**What actually happened to `room-link.ts`.** It was changed anyway,
twelve lines, and the reasoning above did not survive contact with code
review. `CopyValue` was written to mirror `ShareRoomLink`, so it
inherited two defects from it: a confirmation left standing after a
refusal that followed a success, and a `role="status"` region created at
the moment it gained content, which assistive technology was never
watching. Both were fixed in the new control. Leaving them in the old
one would have meant two copy controls in one column behaving
differently, so the same two fixes went to both. The section below is
kept as written because its argument is still the right default; this
note records where the default was overridden and why.

## The values

All four are already in scope at `room.ts:115`, where `Room` finds its
own member in the tree:

| Shown | Source |
|-------|--------|
| Name | `own.name`, falling back to `state.user.value.name` |
| Signature public key | `ownIdentity` |
| Leaf | `ownLeaf`, which is `group.privatePath.leafIndex` |
| Role | `state.isCreator.value` |

`own` is `undefined` only when this client's leaf is absent from its own
ratchet tree, which the `state.removed` early return at `room.ts:63`
already covers. Rather than assert that, the name falls back to the
session name and the key row renders only when `ownIdentity` is
non-null. A blanked leaf costs one row, not the block.

## Placement

A fifth `<div class="block">` at the end of `.room-meta`, after
"Connected now".

`.room-meta` is a plain flow container; only `.room`'s direct children
are placed in the page grid, and the warning at `room.ts:125` about
adding a third child applies there, not here. Persistence is a separate
page-grid child at `grid-row: 4`, so the new block lands between
"Connected now" and it with no change to the sheet's grid.

## Order within the block

Name, then the name disclosure, then the key, then a two-item strip of
leaf and role.

Name and key are the identity; leaf and role are this client's standing
in the group, and they read as the machine values they are. The strip
goes last for that reason, though it could open the block and mirror
the Connection/Epoch strip at the top of the same column.

The leaf and role strip is `dl.readout`, reused verbatim from
`room.ts:146`. It is the same shape -- two labelled short values, side
by side -- so it inherits the rules, the dividers and the label
register at `style.css:565` without a new rule. Name and key go in a
separate `dl` with `dt` above `dd`: the key is 43 characters and does
not sit in a flex strip.

## The split disclosure

`identity-disclosure` under "Connected now" loses its second half and
becomes:

> The signature public key, base64url encoded. That is what the room
> routes on, never a display name.

The new block gains, as `name-disclosure`:

> Your name is not a secret. It rides in your key package as a
> credential, in plain text, and the server can read it.

Same register as every other caveat on the page: `name-disclosure`
joins the selector list at `style.css:261`, which sets
`line-height: var(--leading-loose)` and `padding-top: 1rem`.

## Marking the rows

`data-own` on the `<li>`, which is the attribute `.message` already
uses at `room.ts:473`, plus a `<span class="own-mark">You</span>`.

A real span rather than a CSS `::after`. Generated content is not
reliably announced, and a marker that only sighted readers get would
answer the question for some of the people asking it.

In `.members` the span goes inside the name cell, grid column 2. That
leaves `grid-template-columns` untouched in both the base rule at
`style.css:698` and the narrow-viewport override at `style.css:1224`.
`memberItem` takes a fourth parameter, `own:boolean`.

In `.live` the bare `<li>${identity}</li>` at `room.ts:233` becomes the
key plus the same span.

## The copy control

`views/copy-value.ts`, following the presentational and wired split
that `room-link.ts` uses: `CopyValue` holds the `copied` signal, calls
the clipboard and reports a refusal through `onError`; `CopyControl` is
the button and the `role="status"` confirmation.

`Room` renders the key text itself and passes only the value to
`CopyValue`. That boundary is load-bearing for the tests. The node
suite calls `Room` as a plain function with no renderer, so a child
component appears as an unexpanded vnode -- at
`test/example-realistic-demo/views.ts:219` the suite can assert that
`ShareRoomLink` is present by type and nothing more. A key rendered
inside `CopyValue` would be equally unassertable.

`aria-label="Copy your signature public key"`. There are two copy
buttons in the column once this lands, and "Copy" alone does not
distinguish them.

### Why RoomLink is left alone

`RoomLink` could render `CopyValue` instead of its own button, which
would drop about twelve duplicated lines. It should not. Three passing
tests assert on that button directly -- one at
`test/example-realistic-demo/views.ts:162` counts it, one at :177
checks the confirmation appears only after a copy. Moving it into a
child component turns all three into unexpanded vnodes. The duplication
is cheaper than the tests.

## CSS

New rules for `.you` and `.own-mark` only. The `dl.readout` and
disclosure rules are reused by selector, not copied.

The key joins the machine-value list at `style.css:182` -- the same
declaration block that sets `.epoch`, `.live li` and `.seq` -- and adds
`overflow-wrap: anywhere`, as `ul.live li` does at `style.css:1054`.

Existing variables only: `--font-mono`, `--font-display`,
`--color-ink-muted`, `--color-rule`, `--hairline`, `--tracking-label`,
`--leading-loose`. No new colour. Spacing and any heading size as
literal rems, matching the sheet.

## Implementation phases

<!-- START_PHASE_1 -->
### Phase 1: The copy control

**Goal:** A copy control that works on a plain string, testable without
a browser.

**Components:**
- `example-realistic-demo/client/views/copy-value.ts` -- `CopyControl`,
  presentational, renders the button and the confirmation;
  `CopyValue`, wired, holds the `copied` signal and calls the
  clipboard. Same split and the same `onError` contract as
  `ShareRoomLink` in `views/room-link.ts`.

**Dependencies:** none.

**Covers:** `room-you-section.AC3.1`, `.AC3.2`, `.AC3.3`

**Done when:** `test/example-realistic-demo/views.ts` asserts
`CopyControl` renders one button, and that the confirmation is absent
until `copied` is true. `npm run test:node` passes.
<!-- END_PHASE_1 -->

<!-- START_PHASE_2 -->
### Phase 2: The block

**Goal:** The "You" block renders, with the four values and the copy
control, as the last child of `.room-meta`.

**Components:**
- `example-realistic-demo/client/views/room.ts` -- a `youBlock` plain
  function, called by `Room` rather than rendered as a child component,
  which is the convention `requestItem`, `memberItem` and
  `messageItem` already follow and what keeps its content assertable.
  `Room` renders the key text and passes the value to `CopyValue`.

**Dependencies:** Phase 1.

**Covers:** `room-you-section.AC1.1` through `.AC1.6`

**Done when:** tests assert the block renders with name, key, leaf and
role, that the role text follows `state.isCreator`, and that the key
row is absent when the tree holds no leaf for this client.
<!-- END_PHASE_2 -->

<!-- START_PHASE_3 -->
### Phase 3: Marked rows and the split disclosure

**Goal:** This client's row is marked in both lists, and the name
disclosure sits with the name.

**Components:**
- `example-realistic-demo/client/views/room.ts` -- `memberItem` takes
  `own:boolean` and sets `data-own`; the `.live` item gains the same
  marker; `identity-disclosure` loses its second half and
  `name-disclosure` appears in the new block.

**Dependencies:** Phase 2.

**Covers:** `room-you-section.AC2.1` through `.AC2.4`

**Done when:** tests assert exactly one `.member` and one `.live` item
carry `data-own="true"`, that both hold an `.own-mark`, and that
`data-own` follows the leaf index rather than the name when two members
share one.
<!-- END_PHASE_3 -->

<!-- START_PHASE_4 -->
### Phase 4: Style

**Goal:** The block reads as part of the page.

**Components:**
- `example-realistic-demo/client/style.css` -- `.you` and `.own-mark`
  rules; `name-disclosure` added to the disclosure selector list; the
  key added to the machine-value selector list.

**Dependencies:** Phase 3.

**Done when:** `npm run lint` and `npm run build:realistic` pass, and
the block is checked in the browser at both widths against the
two-column and stacked layouts.
<!-- END_PHASE_4 -->

## Acceptance criteria

### room-you-section.AC1: The block says who this client is

- **room-you-section.AC1.1 Success:** the room renders exactly one
  `.you` block
- **room-you-section.AC1.2 Success:** it shows the name from this
  client's own leaf in the ratchet tree
- **room-you-section.AC1.3 Success:** it shows `ownIdentity`, the
  base64url signature public key, in full
- **room-you-section.AC1.4 Success:** it shows the leaf index from
  `group.privatePath.leafIndex`
- **room-you-section.AC1.5 Success:** the role reads "Room creator"
  when `state.isCreator` is true and "Member" when it is false
- **room-you-section.AC1.6 Edge:** when this client's leaf is not in
  the tree, the name falls back to `state.user.value.name` and the key
  row is not rendered

### room-you-section.AC2: The lists say which row is this client

- **room-you-section.AC2.1 Success:** exactly one `.member` carries
  `data-own="true"`, and it holds an `.own-mark`
- **room-you-section.AC2.2 Success:** exactly one `.live` item carries
  `data-own="true"` when this client's key is in `state.live`
- **room-you-section.AC2.3 Edge:** when two members share a display
  name, `data-own` is on the one whose leaf index matches `ownLeaf`
- **room-you-section.AC2.4 Edge:** no `.live` item is marked when this
  client's key is absent from `state.live`

### room-you-section.AC3: The key can be copied

- **room-you-section.AC3.1 Success:** the block renders one copy
  control, labelled for the key rather than "Copy"
- **room-you-section.AC3.2 Success:** the confirmation appears only
  after a copy has happened
- **room-you-section.AC3.3 Failure:** a clipboard refusal goes to
  `state.status` and the confirmation does not appear

### room-you-section.AC4: The disclosure is said once

- **room-you-section.AC4.1 Success:** `identity-disclosure` states the
  routing claim and no longer states the naming claim
- **room-you-section.AC4.2 Success:** `name-disclosure` renders inside
  the `.you` block

## Verification

1. `npm run lint`
2. `npm run test:node`
3. `npm run build:realistic`
4. Two browsers in one room, checked at both widths: each says a
   different key under "You", each marks a different row in the two
   lists, and the key each shows is the one the other sees in
   "Connected now".

Step 4 is the load-bearing one. Everything above it can pass with the
same client rendered twice.
