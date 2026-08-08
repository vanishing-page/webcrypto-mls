# Test plan: substrate form controls in the realistic demo

Read this cold. You did not do this work and you do not need to have.

All thirteen form controls in the realistic demo were swapped from plain
`<input>`, `<button>` and `<input type="checkbox">` to the
`substrate-system` web components `substrate-input`, `substrate-button`
and `check-box`. The demo's own CSS for those controls was deleted so
the packages' stylesheets take over. Nothing about how the demo behaves
was meant to change.

## Read this first, before you file anything

The controls are supposed to look different now. Buttons used to be
filled with the accent colour, uppercase and square. They are now
transparent with a hairline border and normal-case text, and they no
longer match the uppercase label register the rest of the page still
uses.

That mismatch is the design's stated and accepted consequence. Confirm
it happened. Do not report it as a regression -- reporting it would be
reversing the point of the work.

What *would* be a real defect is a control that has lost its behaviour:
a button that does nothing, a field you cannot type in, a label that has
vanished, or a control that has stopped being disabled when it used to
be.

## Prerequisites

1. `npm run test:node` passing. Takes over ten minutes. Measured at
   47653 pass, 0 fail.
2. `npm run build:realistic` and `npm run build-example` both exit 0.
3. Two known failures are pre-existing, are not this branch's doing, and
   must not be counted against it: three assertions in
   `example-realistic-demo/scripts/verify-phase8-gone.mjs` that expect
   `.intro` and `.guarantee-disclosure` in
   `example-realistic-demo/client/views/explainer.ts`, which has never
   contained them on this branch, and
   `test/test-vectors/key-schedule.ts(73,9) TS2769` in
   `npx tsc --noEmit`.
4. Run `npm run lint` only after `rm -rf example-realistic-demo/public`.
   The build writes minified bundles there that eslint does not ignore.
   Do not fix that by editing `eslint.config.js`.
5. Both dev servers bind port 1234. `npm run start:realistic` and
   `npm start` cannot run at the same time. Do Phase A, stop it, then do
   Phase B.

## Phase A: the realistic demo

Run `npm run start:realistic` and open `http://localhost:1234`.

| Step | Action | Expected |
|---|---|---|
| A1 | Look at the first screen before touching anything | A visible label reading "Your name" above or beside the name field. The component renders it now, not the view, so its absence is a real defect. |
| A2 | Look at the submit button with the name field empty | Present, visibly disabled, and clicking it does nothing. |
| A3 | Type three spaces into the name field | Button still disabled. A whitespace-only name must not be accepted. |
| A4 | Clear it and type `Alice` | Button becomes enabled. |
| A5 | Click the button and watch the moment right after the click | Both the button and the name field go disabled while the room is being created. This is brief; watch for it. A field that stays editable during creation is a defect. |
| A6 | Once the room screen appears, look at the room URL field | It holds the whole absolute URL, starting `http://localhost:1234/`, not a bare room id, and it is set in a monospaced face visibly different from the body text. Worth care: an `<input>` does not inherit its host element's font, so a font rule left on the wrong element would look right in the stylesheet and wrong on the page. If the URL is in the body face, that is a real defect. |
| A7 | Click into the room URL field and try to type | Nothing changes. It is readonly. |
| A8 | Click the Copy button, then paste somewhere | The clipboard holds the same URL the field shows, and a "Copied" confirmation appears next to the control. Before you clicked, there was no confirmation. |
| A9 | Widen and narrow the browser window across the room screen | The URL field and the Copy button stay on one line and the field grows and shrinks to fill. The field does not overflow its container or push the button off-screen. |
| A10 | Scroll to the message composer | A visible label reading "Say something". Same rule as A1: the component renders it, so an unlabelled field is a defect. |
| A11 | With the composer empty, look at Send | Disabled. Type three spaces: still disabled. Type `hi`: enabled. |
| A12 | Send a message | It appears in the timeline and the composer clears. |
| A13 | Resize narrow with the composer visible | The field keeps its own row and grows to fill. The label sits above the field rather than being clipped. |
| A14 | Go to the persistence section | A checkbox labelled "Remember this session in this browser", unchecked. Clicking the label *text* toggles the box, not just the box itself. |
| A15 | Check it, then reload the page | It comes back checked. |
| A16 | Look at the spacing between the checkbox and the paragraph below it | A clear gap. A collapsed gap means the outer spacing rule stopped matching. |
| A17 | Look at the "Delete stored data" button | A clear gap above it separating it from the storage panel. That spacing rule was deliberately kept while its neighbours were deleted. |
| A18 | Click "Delete stored data" | Stored data is cleared, same as before this work. |

### The member list

You need a second participant. Open a second browser profile or a
private window, paste the room URL, and ask to join as `Bob`.

| Step | Action | Expected |
|---|---|---|
| A19 | In Alice's window, look at the pending request | Approve and Deny both present. Approve enabled for a well-formed request. |
| A20 | In Bob's window, before being approved | No pending list and no Approve or Deny control at all. Those are the creator's controls. |
| A21 | Click Approve | Bob joins. Click Deny on a later request and it is refused. |
| A22 | With Bob in the room, look at the member list in Alice's window | A Remove button beside Bob's row and none beside Alice's own row. Nobody is offered a control to remove themselves. |
| A23 | Look at where the Remove button sits horizontally | In its own column at the right of the row, lined up with the Remove buttons on any other rows, not wrapped underneath the member's name. This is the layout check most likely to have broken silently, because it depends on a CSS class surviving onto the new component's host element. |
| A24 | Narrow the window until the layout reflows | Remove moves to its own line, left-aligned, spanning the row. It does not disappear, overlap the name, or overflow the card. |
| A25 | In Bob's window (not the creator), look at the member list | No Remove button anywhere. |
| A26 | Click Remove on Bob | Bob is removed and Bob's window says so plainly. |

### The gone view

| Step | Action | Expected |
|---|---|---|
| A27 | Navigate to a room id that does not exist, e.g. `http://localhost:1234/zzzzzzzzzz` | The "gone" page, with a "Start a new room" button. |
| A28 | Click it | You land back on the setup screen. |

## The storage panel label mutation

This is the single most important manual step in the plan. It is the one
behaviour with no automated check anywhere, and the one the conversion is
most likely to have broken.

`substrate-button` moves the button's text into an inner
`<span class="btn-content">`. Preact still holds a reference to the text
node it created. If that reference no longer points at the node the user
can see, the label will render its first value and then freeze forever,
and nothing in the test suite would notice.

In the persistence section of the realistic demo, in a browser where
storage is not already persistent:

1. Read the button. It says "Request persistent storage" and is enabled.
2. Click it and watch the label. It must change to "Requesting..." and
   the button must go disabled in the same instant.
3. If the label still reads "Request persistent storage" after the
   click, stop and report it. That is the conversion breaking, and it is
   the defect this step exists to catch.
4. When the browser grants persistence, the button ends up disabled.
5. On a browser with no storage API at all, no button is rendered.

Repeat steps 1 to 3 on the `example/` persistence page in Phase B, since
that page renders the same shared component through a different entry
point and a different stylesheet.

## Phase B: the two `example/` pages did not change

Stop `start:realistic` first, then run `npm start` and open
`http://localhost:1234`.

This work converted a shared component,
`example-shared/storage-panel.ts`, that two pages outside the realistic
demo also render. Those pages import the button package but keep their
own `example/style.css`, whose bare `button` rule now styles the inner
button the component renders. The intent is that those two pages look
exactly as they did before.

| Step | Action | Expected |
|---|---|---|
| B1 | Navigate to `/persistence` | The storage panel's "Request persistent storage" button looks the way `example/` buttons have always looked: the *old* filled style, not the new transparent hairline style from Phase A. This is the reverse of Phase A's expectation and it is deliberate. |
| B2 | Compare it side by side against any other button on the same page | Same fill, same border, same case, same size. A button visibly different from its neighbours on this page is the regression this step is looking for. |
| B3 | Click it and watch the label | "Requesting...", disabled, per the scenario above. |
| B4 | Navigate to `/multi-device` | Same two checks, B1 and B3. |
| B5 | Look for any control on either page that has become inert text | Nothing that used to be a button should now be a bare word with no border and no click behaviour. That is what an unregistered custom element looks like, and it would mean the registration import in `example/index.ts` is not reaching the page. |

## Optional: the Playwright harnesses

`example-realistic-demo/scripts/verify-phase7.mjs`,
`verify-phase8-chat.mjs`, `verify-phase8-e2e.mjs` and
`verify-phase8-gone.mjs` drive a real browser and had their selectors
updated for the new tags. They are **not** run by `npm run test:node`.

To run them you need `npm run worker:realistic` and `npm run dev:realistic`
both up, plus `mkdir -p example-realistic-demo/public` so wrangler's
`assets.directory` resolves. Current measured state: 22/0, 13/0, 7/0,
and 7 passed with 3 failures. Those three are the pre-existing
`.intro` / `.guarantee-disclosure` failures described in Prerequisites
item 3. Any *other* failure is worth reporting.

## Human verification required

| Criterion | Why manual | Steps |
|---|---|---|
| AC1.1 All three elements upgrade | Custom element registration is a browser fact and the node suite has no DOM | Any of A1 to A18. If registration failed, every control on the page would be inert text. |
| AC1.2 Storage panel button renders as a button on the two `example/` pages | Same, and on pages the suite never renders | B1, B4, B5 |
| AC2.2 No demo rule competes with a package rule | The project has no stylesheet test harness | A2, A5, A11. A control that looks enabled while behaving disabled, or that shows two competing borders, means a deleted rule came back |
| AC3.7 Request button reports clicks and disables | Knowingly uncovered by design, recorded at `test-requirements.md` lines 82 and 86-112 | The label mutation scenario above, plus B3 |
| AC5.1 Remove keeps its grid column | CSS | A23, A24 |
| AC5.2 Fields keep their flex sizing | CSS | A9, A13 |
| AC5.3 Room URL stays mono | CSS | A6, A7 |
| AC5.4 The two `example/` pages look unchanged | CSS, on pages this work is not about | B1, B2, B4 |

## Traceability

| Acceptance criterion | Automated test | Manual step |
|---|---|---|
| AC1.1 | none | A1-A18 |
| AC1.2 | none | B1, B4, B5 |
| AC1.3 | `npm run test:node` completing | none |
| AC2.1 | `npm run build:realistic` plus grep of built CSS | none |
| AC2.2 | none | A2, A5, A11 |
| AC3.1 | `views.ts:47-134` | A1-A5 |
| AC3.2 | `views.ts:145-188` | A6-A8 |
| AC3.3 | `views.ts:369-412, 426-483, 527-551, 741-796` | A19-A26 |
| AC3.4 | `views.ts:983-1070` | A10-A12 |
| AC3.5 | `views.ts:1098-1120, 1164-1173` | A14-A18 |
| AC3.6 | `views.ts:1181-1192` | A27, A28 |
| AC3.7 | none, by design | Label mutation scenario, B3 |
| AC4.1 | `views.ts:57-66` | A1 |
| AC4.2 | `views.ts:991-1000` | A10 |
| AC5.1 | class survival only, `views.ts:741-752` | A23, A24 |
| AC5.2 | none | A9, A13 |
| AC5.3 | none | A6, A7 |
| AC5.4 | none | B1, B2, B4 |
| AC6.1 | `npm run lint` after `rm -rf example-realistic-demo/public` | none |
| AC6.2 | `npm run test:node` | none |
| AC6.3 | `npm run build:realistic` | none |
