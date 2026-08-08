# Human test plan: the room "You" section

What a person has to check for
`docs/design-plans/2026-08-06-room-you-section.md`, and nothing else.

Fifteen criteria, `room-you-section.AC1.1` through `.AC4.2`. All fifteen
have standing automated coverage; the map is in
`docs/implementation-plans/2026-07-27-realistic-demo/ac-coverage.md`.
This document covers only what an automated test cannot see.

## What is already written down elsewhere

Three human checks for this feature live in
`docs/test-plans/2026-07-28-realistic-demo.md`, because they belong to
that document's run rather than to a one-off. Do not duplicate them
here, and do not skip them:

- **Step 1.15** -- the key copies to the real system clipboard.
- **Step 1.16** -- a refused copy says so and takes the confirmation
  back. This is the only check on AC3.3's failure half, and the only
  thing that exercises `copied.value = false` in either copy control.
- **Part 4 steps 1 and 2** -- the wording of the two split disclosures,
  read against each other.

Everything below is the appearance check, which had no standing record
before this document. `phase_04.md` Task 3 describes it, but a phase
plan is a build-time artifact nobody reruns.

## Before you start

Per `example-realistic-demo/AGENTS.md` lines 591-596:

```sh
npm run build:realistic
npm run worker:realistic
```

Then browse `http://localhost:8787`. `build:realistic` must run first --
wrangler serves from `dist/`, which is gitignored, so a fresh tree
serves nothing.

Use **two browser profiles that share no storage**. Not two tabs: a
second tab shares the database, so both clients are the same client and
every check below passes for the wrong reason. Profile A creates the
room; B joins and A approves.

For the AC2.3 pass, type **the same display name in both profiles**. A
name is a credential, not an identifier, and the marker has to follow
the leaf index rather than the name.

## The block

| # | Check | Expected |
|---|---|---|
| Y1 | Scroll A's left column to the bottom | The "You" block is the last block, after "Connected now" |
| Y2 | Read the four values in A, then in B | The two disagree about the key, the leaf and the role |
| Y3 | Take the key A shows under "You" | That exact string is in B's "Connected now" list, and B's key is in A's. This is what proves the block reads this client's own leaf |
| Y4 | Compare the roles | A is the creator, B is a member |
| Y5 | Look at the key in A | All 43 characters visible, wrapped if it must be. No ellipsis, no clipping, no horizontal scrollbar. `.own-identity` leans on `overflow-wrap: anywhere` and no test can see it |
| Y6 | Look at the leaf and role | Side by side in a divided strip |
| Y7 | Look at the Connection / Epoch strip above | Unchanged by this feature. Phase 4 hoisted the shared label register out of `.readout`, so this is the check on a change to shared CSS |

## The marker

| # | Check | Expected |
|---|---|---|
| M1 | Read the member list in each profile | Exactly one row marked, and it is that profile's own row |
| M2 | Read "Connected now" in each profile | Exactly one key marked, and it is the key that profile shows under "You" |
| M3 | Narrow the window below 52rem, repeat M1 | The marker stays on the name's line. It does not push the presence badge or the Remove control onto a new line. The member row changes to three grid columns at this breakpoint, which is why this needs an eye |
| M4 | With a screen reader, or by selecting the name cell and copying it | Two words -- "Alice You", not "AliceYou". A test pins the leading space in the vnode; this confirms it survives into the rendered accessible text. `.own-mark`'s `margin-left` does not affect the spoken run, so it cannot substitute |
| M5 | With the same name in both profiles, repeat M1 | Still exactly one marked row per profile, and still the right one. This is AC2.3 in the browser |

## The two copy controls

| # | Check | Expected |
|---|---|---|
| C1 | Tab through the left column, or open the accessibility tree | Two copy buttons with two different accessible names -- one for the room URL, one for the signature public key. Neither is bare "Copy" |

The automated test proves the two names differ without asserting either
string. This step is what confirms the strings a person actually hears
are the right ones.

## Regression: the two Playwright harnesses

Both `.member-name` readers were rewritten, because that cell can now
hold the marker element as well as the name. Run both, and **compare
against the baseline, not against zero**:

```sh
npm run dev:realistic          # vite, :1234, in another shell
node example-realistic-demo/scripts/verify-phase8-e2e.mjs
node example-realistic-demo/scripts/verify-phase7.mjs
```

- `verify-phase8-e2e.mjs` -- 7 passed, 0 failed.
- `verify-phase7.mjs` -- 19 passed, **3 failed**. Those three are
  byte-identical to the same harness at the pre-feature commit
  `43b23f2`, verified by running it there in a worktree against its own
  server. Three failures is the pass condition here. A fourth is yours.

The one to watch in `verify-phase7.mjs` is its first member check,
`expected Alice, got ...`. That is the assertion that fails loudest if
the marker ever leaks back into a read display name.

Stop both dev servers when you are done.

## Known gaps, so nobody records them as passes

- **`copied.value = false` in `CopyValue`'s catch**, and the identical
  line in `ShareRoomLink`, is executed by no automated test and no
  harness. `CopyValue` calls `useSignal`, and this suite tests views by
  calling them as plain functions. Step 1.16 of the realistic-demo test
  plan is the only thing that reaches it.
- **AC4.1's wording** is not asserted anywhere, by house rule. Part 4
  step 2 is the check.
- **The real OS clipboard** is reachable by neither harness, for either
  copy control.

## The standing checks were wrong, and are now fixed

Writing this plan turned up three false expectations in
`docs/test-plans/2026-07-28-realistic-demo.md`. Each would have stopped
a tester on the first page with a regression report for something that
had been red all along. All three are corrected there now, with numbers
measured on this branch and again at `43b23f2` in a worktree:

1. Standing check 1 said `npm test` exits 0. It exits 1, and always
   has -- two pre-existing failures.
2. Standing check 2 said `npm run lint` exits 0. True only on a tree
   that has never been built; standing check 5 builds, after which it
   reports about 62000 problems from generated bundles.
3. Standing check 6 said every check in each of the four harnesses
   passes. Two of the four are red: `verify-phase7.mjs` at 19/3 and
   `verify-phase8-gone.mjs` at 7/3.

Checks 3, 4 and 5 were accurate and are unchanged. `probe.mjs` really
does report 23 of 23.
