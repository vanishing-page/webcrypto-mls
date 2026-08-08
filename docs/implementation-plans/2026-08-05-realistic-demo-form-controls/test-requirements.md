# Test requirements: substrate form controls

Which acceptance criterion is covered by which check, and which are not
covered automatically and why. Check this file before assuming
something is tested.

This mirrors the convention in
`docs/implementation-plans/2026-07-27-realistic-demo/ac-coverage.md`,
which the realistic demo's `AGENTS.md` names as the standing record of
coverage for that phase.

All test line numbers are `test/example-realistic-demo/views.ts` as
read on 2026-08-05, before any edit in this plan. They shift as the
phases are executed; they are identifiers, not addresses.

## What this plan does and does not change

This is a conversion, not a feature. Every automated test below already
exists and already passes. The plan moves a dozen assertions from one
vnode type to another and replaces two label assertions; it adds no new
behaviour and therefore adds no new test. Where an AC has no automated
coverage, it had none before this work either, and the plan does not
add it -- adding coverage under cover of a refactor would make the
refactor unreviewable.

The two AC entries that change what is asserted rather than where are
AC4.1 and AC4.2. Both go from "a `<label>`'s `for` matches its input's
`id`" to "the field carries a non-empty `label` prop". That is a
deliberate weakening: the `for`/`id` pair is the component's business
now, and the root `AGENTS.md` forbids asserting on rendered copy, so
what survives is "it is labelled", not "it says this".

## Automated coverage

| AC | Check | Type | Where |
|---|---|---|---|
| AC1.3 | Suite runs with no DOM | operational | `npm run test:node` |
| AC2.1 | Package sheets resolve | operational | `npm run build:realistic` |
| AC3.1 | Setup field and button | unit | views.ts 47-77, 79-100, 102-115, 117-136 |
| AC3.2 | Room link field and copy | unit | views.ts 147-162, 164-177, 179-190 |
| AC3.3 | Approve, deny, remove | unit | views.ts 371-414, 428-444, 446-485, 529-553, 743-754, 756-776, 778-798, 802-825 |
| AC3.4 | Composer and send | unit | views.ts 985-1010, 1012-1050, 1052-1068 |
| AC3.5 | Persist toggle and reset | unit | views.ts 1096-1120, 1164-1173 |
| AC3.6 | Create-new control | unit | views.ts 1181-1192 |
| AC4.1 | Setup field is labelled | unit | views.ts 47-77, replacing the `for`/`id` assertion |
| AC4.2 | Composer field is labelled | unit | views.ts 985-1010, replacing the `for`/`id` assertion |
| AC6.1 | Lint clean | operational | `npm run lint`, after cleanup |
| AC6.2 | Suite passes | operational | `npm run test:node` |
| AC6.3 | Realistic demo builds | operational | `npm run build:realistic` |

### Notes on the automated set

**AC1.3** is verified by absence rather than by an assertion. A
registration import that leaked into a module the node suite reaches
would throw `ReferenceError: document is not defined` at bundle load,
before any test ran, because
`@substrate-system/web-component/util` binds `document.querySelector`
at module top level and `CheckBox extends HTMLElement`. So the suite
completing at all is the check.

**AC2.1** is likewise operational, and needs the second half of its
verification to mean anything: a dropped `@import` still exits 0, so
the build must be followed by a grep of
`example-realistic-demo/public/assets/*.css` for the package rules.

**AC3.3** carries both polarities in the existing tests, which is why
none of them needs an edit: who sees the pending list *and* who does
not, an approvable request *and* an unapprovable one, Remove offered to
the creator *and* to nobody else. A conversion that broke only the
negative case would still fail.

## Human verification

Six criteria have no automated check. Confirm each by hand with
`npm run start:realistic`, and for AC5.4 with `npm run build-example`.

| AC | What to confirm | Why not automated |
|---|---|---|
| AC1.1 | All three elements upgrade on a realistic-demo page | Registration is a browser fact; the suite has no DOM |
| AC1.2 | The storage panel's button renders as a button on the two `example/` pages | Same, and on pages the suite does not render |
| AC2.2 | No demo rule competes with a package rule | The project has no stylesheet test harness |
| AC3.7 | Request button reports clicks and disables when persistent or pending | **See below** |
| AC5.1-5.3 | Layout and mono survive | CSS, as AC2.2 |
| AC5.4 | The two `example/` pages look unchanged | CSS, and the regression is on pages this work is not about |

### AC3.7 is knowingly uncovered

`example-shared/storage-panel.ts`'s request button has **no automated
coverage, before or after this work**. No test renders `StoragePanel`
and reads its button: `test/example/storage-panel.ts` exercises
`persistOutcome` and `PERSIST_MESSAGES` only, and views.ts's
`Persistence reuses the shared storage panel` (1148-1160) asserts that
the panel is rendered and what `status` it was told, never what it
renders.

This plan does not add that coverage, because doing so would be new
work rather than a conversion. It is recorded here so the gap is a
decision rather than an oversight.

To check it by hand, on `npm run start:realistic` and on
`npm run build-example`'s persistence page:

1. With storage not yet persistent, the button reads "Request
   persistent storage" and is enabled.
2. Clicking it puts the label to "Requesting..." and disables it. This
   is the one that matters most for the conversion: it exercises
   Preact mutating a text node that `substrate-button` has moved into
   its inner `<span class="btn-content">`. If the label freezes at its
   first value, the conversion broke and no automated check would have
   said so.
3. Once storage reports persistent, the button is disabled.
4. On a browser with no storage API, no button is rendered at all.

### The visible change is intended

The design states it and it is worth confirming rather than being
surprised by: buttons go from filled accent uppercase to transparent
with a hairline border, and the demo's controls stop matching the
uppercase label register used elsewhere on the page. A reviewer seeing
that and filing it as a regression would be reversing the point of the
work.

Also confirm, in the same pass:

- The setup field and the composer field are visibly labelled, by a
  label the component renders rather than one the view writes.
- The setup name field disables while a room is being created.
- The room URL is still monospaced and still readonly. This is AC5.3,
  and it is the one that catches the easy mistake: an `<input>` does
  not inherit the host's font, so a rule left on the host would look
  right in the stylesheet and wrong on the page.
- The remove button still sits in its own grid column, at both wide and
  narrow viewports. This is AC5.1.

## Coverage of the design's own verification list

The design names three commands. All three are in the plan, and two
more are added:

| Command | Design | Plan | Why |
|---|---|---|---|
| `npm run lint` | yes | yes | AC6.1 |
| `npm run test:node` | yes | yes | AC6.2 |
| `npm run build:realistic` | yes | yes | AC6.3 |
| `npx tsc -p tsconfig.json --noEmit` | no | yes | esbuild only strips types, so a passing suite says nothing about typechecking. The realistic demo's `client/` is covered by the root config, not by `example-realistic-demo/tsconfig.json` |
| `npm run build-example` | no | yes | The shared storage panel reaches the two `example/` pages |

One operational hazard applies to all of them, and is written up in
`phase_01.md`: `npm run build:realistic` writes to
`example-realistic-demo/public/`, which eslint does not ignore, so
`npm run lint` must run after `rm -rf example-realistic-demo/public`.
Do not resolve that by editing `eslint.config.js`.
