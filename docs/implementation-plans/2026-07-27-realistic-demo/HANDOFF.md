# Realistic demo -- execution handoff

State of the work executing
`docs/implementation-plans/2026-07-27-realistic-demo/`. All eight phases
are now done. Kept as the record of what was learned, so a fresh agent
can pick up without re-deriving it.

Branch: `ralphing`, cut from `realistic-demo`, which carries Phases 1-5.
Base of this work: `4647c69`.
Plan directory: `docs/implementation-plans/2026-07-27-realistic-demo/`

---

## Where things stand

| Phase | State |
|---|---|
| 1 -- Extract shared example code | Done, reviewed, zero issues |
| 2 -- Worker scaffolding | Done, reviewed, zero issues. **Deployed** |
| 3 -- Wire contract and pure room logic | Done, reviewed, zero issues |
| 4 -- Room log, replay, liveness | Done, re-reviewed, zero issues |
| 5 -- Async join, ledger, expiry | Done, reviewed, zero issues remaining |
| 6 -- Client shell, user and room creation | Done, reviewed, zero issues |
| 7 -- Join, approval, membership, removal | Done, reviewed, zero issues |
| 8 -- Chat, persistence, gone state, explainer | Done, reviewed, zero issues |

After the phases: the project context files were refreshed, the whole
branch was reviewed against the design plan's scoped criteria with the
coverage matrix in `ac-coverage.md`, and the human test plan was written
to `docs/test-plans/2026-07-28-realistic-demo.md`.

The Worker is deployed and live at
**https://mls-realistic-demo.nichoth.workers.dev**
(`/api/health` answers, unmatched paths serve the page). Deploying was
explicitly approved by the repository owner. Do not redeploy without
asking again.

---

## The immediate next task

None. Every phase and every wrap-up step is done, and the branch is
waiting on the repository owner's integration decision -- see
"Finishing the branch" at the end of this file. Carry-forward finding 2b
is settled: the ledger gates `onMls`. Finding 2c is still open by
decision, not by oversight; see below.

---

## Phase 5, for the record

All six tasks are done. `isCreator` is now decided by the creator token,
compared once at `hello` and carried in the socket attachment, which is
server-side state a client cannot reach. The probe runs 19 checks, up
from 10, and the fast bundle 210, up from 202.

**Two real defects surfaced, both on paths Phase 4's suite never walked.**

1. *A client-initiated close never completed.* The server never sent its
   close frame, so a client closing its own socket stayed in `CLOSING`
   indefinitely -- measured at a flat `readyState === 2` across three
   seconds. Phase 4 only ever observed server-initiated closes, which do
   complete, so its check 8 passed throughout. `webSocketClose` now calls
   `ws.close()`, sanitising codes 1005 and 1006, which are receive-only
   and throw if echoed back.

   Worth recording because the Phase 4 re-review got this wrong: the
   Cloudflare docs describe a `web_socket_auto_reply_to_close` flag that
   makes the runtime answer close frames for you, and this Worker's
   compatibility date is past that flag's cutoff. **The flag does not
   exist in this workerd build** -- it appears nowhere in `node_modules`.
   The docs describe a newer runtime than the pinned wrangler ships.
   Measure this one rather than reasoning from the compatibility date.

2. *`deleteAll()` drops the tables, not just the rows.* After the expiry
   alarm, every `readMeta()` threw `no such table: meta`, so an expired
   room answered **500** and a `hello` to it got no answer at all, where
   AC8.3 requires `no-room`. `phase_05.md` Task 5 Step 3 states that no
   new code is needed for AC8.3; that is a plan defect. `alarm()` now
   calls `ensureSchema()` after `deleteAll()`, which also makes an expired
   room and a never-existed id the *same state* -- a present schema
   holding no rows -- rather than merely the same answer.

**Two checks beyond the plan.** Check 18 covers a hole the plan's own
token makes closable for the first time: `replaceExistingSocket` matched
on identity alone, so anyone could evict the creator's live socket by
saying `hello` as them, keeping the only person who can approve requests
permanently disconnected. Check 19 covers Task 4 Step 5's roster ledger,
which nothing else would have noticed the loss of -- every other roster
assertion concerns the creator, who is `known` either way.

**Mutation evidence.** Ten mutations of the Phase 5 code, each confirmed
applied and restored by file copy:

| Mutation | Checks killed |
|---|---|
| `requireCreator` always allows | 11 |
| `isCreator` by identity only (the Phase 4 bug) | 11 |
| `pending` uses `INSERT OR IGNORE` | 13, 15 |
| `deny` writes `removed` to the ledger | 14, 15 |
| mailbox never deleted after delivery | 15 |
| Welcome sent after the log batch | 15 |
| welcome cursor stamped `0` | 15 |
| `priorCount` counts every entry kind | 15 |
| roster `known` reverts to creator-only | 19 |
| pending list broadcast to every socket | 13, 15 |

Plus, on the alarm: removing the `ensureSchema()` restore reproduces the
500 exactly.

**How the alarm was verified, and how to redo it.** A three-day wait is
not a test. `ROOM_LIFETIME_MS` was temporarily cut to `5000` and a
temporary `debugAlarm()` RPC added behind an `/api/debug-alarm/:id`
route, so the handler could be fired on demand. Both were removed before
committing (`grep -n "TEMPORARY\|debugAlarm" example-realistic-demo/index.ts`
returns nothing). With them in place the checks were: the live socket is
closed by the server on expiry, `GET /api/room/:id` then answers 404, a
fresh `hello` answers `no-room`, and firing the handler twice more
against the already-empty room neither throws nor resurrects it.

---

## The Phase 5 review

Reviewed `6e4e759..ac8bbf2`: `index.ts`, `room-logic.ts`, `probe.mjs`
and `test/example-realistic-demo/room-logic.ts`. Three issues, all
fixed. The two defects and ten mutations recorded above were not
re-reported.

**1. Important -- re-approval left a member permanently off the
roster.** Nothing ever deleted a `removed` ledger row, and
`broadcastRoster` builds `known` as creator plus admitted *minus
removed*. So approving an identity the creator had previously removed
readmitted them to the group while leaving them invisible on the roster
for the room's whole life. Re-approval is not a corner: the
`previously-removed` standing exists precisely so the creator can weigh
letting someone back in. `onApprove` now deletes the removed row, which
makes the ledger a current status rather than an accumulated history.
Probe check 19 was extended to cover it, and watched fail first --
`timeout waiting for matching roster` -- against the unfixed code.

**2. Minor -- the creator-only handlers wrote without checking the room
existed.** `onMls` and `onJoinRequest` both answered `no-room`;
`approve`, `deny`, `removed` and `welcome` did not. The alarm closes
every socket before it deletes, but a close is not instantaneous and an
in-flight message still arrives, so a write could land in a room with no
meta and no alarm: rows nothing will ever expire, in a room that reports
itself gone. That breaks the invariant the `ensureSchema()` restore
exists to establish. A shared `requireRoom` now guards all six handlers.

Verified with a temporary harness rather than a three-day wait: a
`debugWipe()` RPC behind `/api/debug-wipe/:id` doing exactly what
`alarm()` does to storage but without closing sockets, which reproduces
the state an in-flight message arrives in. Guarded, all four control
messages answered `no-room`; with the guard stripped out, none did and
the room broadcast `pending` from its wiped storage. Harness removed
before committing -- `grep -n "TEMPORARY\|debugWipe"` returns nothing.

**3. Minor -- a Welcome could be consumed by a socket that was already
closing.** A closing socket stays in `getWebSockets()`, and `send()`
swallows failures on one by design, so `deliverMailbox` could hand the
Welcome to a corpse and delete the row having reached nobody. Reachable
on an ordinary reconnect: the socket `replaceExistingSocket` just closed
can still be closing when the replacement says `hello` and the mailbox
is read. It now skips any peer not `OPEN`. Partly verified -- inverting
the comparison fails check 15, which proves the predicate is live and
discriminating, but no check reproduces the corpse case itself.

Probe hygiene, same review: checks 13, 14, 16 and 19 closed their
sockets without awaiting the close. Check 14's is the one that bites --
a B socket still open when check 15 issues its Welcome takes delivery of
it, so check 15 fails for a reason that has nothing to do with check 15.
Two stale comments naming the old check counts were corrected.

---

## Phase 4, for the record

The first review returned 2 Critical, 3 Important and 5 Minor, all fixed
in `8bb5a6c`. The re-review of that commit found zero Critical and zero
Important, and three Minor confined to `probe.mjs`, fixed in `e086b92`:
the `socketA` guard had not been extended to `socketB`/`socketB2`, so a
failed `openSocket` in check 5 or 7 still ended the run in a TypeError
rather than the failure summary; and two stale comments still said eight
checks and "checks 5-9".

The re-review verified rather than trusted. Five mutations, each restored
by file copy, each confirmed to have applied:

| Mutation | Checks killed |
|---|---|
| `broadcastRoster` yields a constant `[]` | 3, 8, 9 |
| routing reverted to the single-segment pattern | 2 |
| `replaceExistingSocket` call removed | 8 |
| `onMls` echoes to the sender, and `hello` replays from 0 | 6, 7 |
| `setWebSocketAutoResponse` removed | 10 |

The guard fix was verified in both directions by forcing check 5's
`openSocket` to reject: guarded, the summary prints; unguarded, it does
not.

**One conclusion from this re-review was wrong, and Phase 5 caught it.**
The re-review cleared `webSocketClose` for not calling `ws.close()`, on
the grounds that `web_socket_auto_reply_to_close` makes the runtime
answer close frames and this Worker's compatibility date is past that
flag's cutoff. That reasoning came from the Cloudflare docs and was never
measured. The flag is absent from this workerd build, client-initiated
closes never completed, and Phase 5 fixed it -- see Phase 5 finding 1
above. The lesson generalises: the published docs track a newer runtime
than the pinned wrangler, so a claim about runtime behaviour needs a
measurement, not a compatibility date.

What the first review found and what was done about it:

- **Critical.** The probe's roster assertions could not fail. Replacing
  `broadcastRoster`'s result with a constant `[]` left all nine checks
  green -- both assertions were absences, and `assembleRoster` filters by
  `known`, which holds only the creator this phase, so the identity being
  asserted about could never appear. Checks 3, 8 and 9 now assert exact
  roster contents. Re-verified: the gutting mutation now fails 3 checks.
- **Critical.** `GET /api/room/a/b` answered 404 rather than the 400 the
  plan requires, because the route pattern only matched a single clean
  segment. The handler now hands everything after `/api/room/` to
  `isValidRoomId`. Note a literal `../../etc/passwd` is deliberately not
  tested: the URL parser strips dot segments before the request is sent,
  so that shape never reaches the route.
- **Important.** `send()` swallowed every failure. An oversize `log`
  replay would leave a client silently believing it was caught up. It now
  only swallows when the socket is closing.
- **Important.** Probe used fixed sleeps; now condition-based. A failed
  check 3 crashed the run outside the harness; now reports.
- **Minor.** `Upgrade` compared case-insensitively (RFC 6455);
  `SocketState` made a type alias; keepalive pair now exercised (check 10).

---

## Carry-forward findings -- read before Phase 5

**0. Resolved in Phase 5, kept for context.** Findings 1 and 1b below
described Phase 4 state. Finding 1 is fixed -- `isCreator` is now the
token comparison, and mutating it back to the identity comparison fails
probe check 11. Finding 1b still stands: see finding 2b.

**1. `isCreator` was spoofable in Phase 4, and Phase 5 fixed it.**
`index.ts` decides `isCreator` by `meta.creator_identity === identity` and
ignores `hello`'s `creatorToken` entirely. Any socket claiming the
creator's identity gets `isCreator: true`. This is plan-conformant for
Phase 4 and harmless because nothing server-side acts on it yet.
`phase_05.md` (around lines 304-311) replaces it with a real
`creatorToken === meta.creator_token` comparison. **That comparison must
not be carried forward unchanged -- it becomes a genuine authorization
hole the moment Phase 5's creator-only handlers land.**

**2b. `onMls` is now gated by the ledger. Settled -- decided to gate.**
Raised before Phase 5 and left open there, because `phase_05.md` does not
gate it. Until now the only check was that the socket carried an
attachment, so any identity at all could append to the log and have it
broadcast to every peer.

The decision was to close it. `mayWriteLog` in `room-logic.ts` is the
rule, `requireMember` in `index.ts` applies it, and a caller who fails it
gets a new `not-member` error reason. The creator always passes, on the
`isCreator` flag rather than a ledger lookup -- the creator never appears
in the ledger, because they do not approve themselves. Everyone else must
be admitted and not since removed, which is exactly the membership
`broadcastRoster` builds `known` from. The check runs after `requireRoom`,
deliberately: an expired room's ledger is empty, so the other order would
answer `not-member` to a member whose room had merely ended.

What this does and does not buy. It stops an identity that was never
admitted from filling the log, which is unbounded storage growth in a
room that anyone can open a socket to. It is not authentication: an
identity is a public signature key that anyone who has seen the log
knows, so a stranger who copies an admitted member's identity still gets
through. That residual is finding 2c, and it is unchanged by this.
Disclosure was never at stake either way -- payloads are opaque and
end-to-end encrypted.

Checked against the phases still to come: every `mls` send in
`phase_07.md` and `phase_08.md` is made either by the creator or by a
member who has already been admitted. Phase 7's approve path sends the
Add commit before the `approve`, but the sender there is the creator, so
the gate does not see it. Nothing in the plan needs a write from an
unadmitted identity.

Probe check 20 covers all four cases: a stranger refused and nothing
written, the creator still writing, an admitted member writing, and a
removed member refused. Three mutations kill it -- deleting the
`requireMember` call, deleting `mayWriteLog`'s `isCreator` clause, and
deleting its `removed` clause -- and the middle one also fails three of
the new unit tests.

**2c. Any socket may claim any non-creator identity, and two things
follow.** Raised by the Phase 5 review and left open, because closing it
needs per-identity authentication the room does not have and the plan
does not call for. An identity is a public signature key, so anyone who
has seen the log knows every member's. Claiming one in `hello`
(a) evicts that member's live socket through `replaceExistingSocket`,
which can be repeated indefinitely, and (b) takes delivery of any
Welcome waiting for them, which is then consumed -- the real member
never joins until the creator reissues it. The creator is protected from
both by the token; nobody else is. Neither is a disclosure: a Welcome is
HPKE-sealed to the joiner's key package, so the thief cannot open it.
Both are denial of service against a named person. Worth stating
plainly in the Phase 8 explainer whatever else is decided.

**2. Known defects in the plan documents themselves.** These are wrong in
the plan, not in the code. Do not "fix" the code to match them:

- Every phase file's typecheck command is broken. `--declaration false`
  conflicts with `declarationDir` in `tsconfig.json` and emits two
  spurious `TS5069` errors regardless of code state. Use plain
  `npx tsc -p <config> --noEmit` instead.
- `phase_02.md` Task 2 gives a `$schema` of
  `node_modules/wrangler/config-schema.json`,
  which resolves relative to the config file and therefore dangles. Fixed
  in the repo to `../node_modules/...`.
- `phase_04.md`'s `send()` listing swallows all errors. Fixed in the repo;
  the plan text still shows the original.
- `phase_04.md` Task 5 check 2 requires 400 for a slash id. That now
  holds, but only after the routing change above.

**3. One pre-existing type error, not ours.**
`test/test-vectors/key-schedule.ts:73` reports `TS2769` (a `reduce()`
overload issue). It is present at `4647c69` and is out of scope. The root
typecheck "passes" when that is the only error. The **Worker** typecheck
must be completely clean.

---

## How to run things (corrected)

```bash
# Typechecks -- grep, because raw output is thousands of listFiles lines
npx tsc -p tsconfig.json --noEmit 2>&1 | grep "error TS"
npx tsc -p example-realistic-demo/tsconfig.json --noEmit 2>&1 | grep "error TS"

# Lint -- check the EXIT CODE. Piping to tail masks failure, because the
# pipeline status comes from tail, not eslint.
npm run lint; echo "exit=$?"

# Full suite: passes, but takes well over 10 minutes. Run it in the
# background rather than blocking on it.
npm test
```

**Final numbers, at the tip of `ralphing`.** `npm test` reports
**47676 passing**, exit 0. The fast realistic-demo bundle below reports
**2259**, exit 0. `npm run lint` exits **0**. The root typecheck reports
only the known `key-schedule.ts:73` TS2769; the Worker typecheck prints
no error lines. The probe reports **23/23**, exit 0.

For comparison: 45469 tests at the base of this work, 45679 and a 19/19
probe at `ac8bbf2` where Phase 5 landed, 20/20 after the finding 2b gate.
Lint stays clean with `example-realistic-demo/.wrangler/` present,
re-confirmed after running the dev server.

**Fast test signal.** For the realistic-demo tests only, ~3 seconds
instead of 10+ minutes:

```bash
cat > .mut-index.ts <<'EOF'
import './test/example-realistic-demo/protocol.js'
import './test/example-realistic-demo/room-logic.js'
EOF
npx esbuild ./.mut-index.ts --bundle --platform=node --format=cjs \
  --loader:.json=json --keep-names --outfile=.mut-bundle.cjs \
  && node .mut-bundle.cjs
rm -f .mut-index.ts .mut-bundle.cjs
```

`.mut-index.ts` is checked in and already lists every realistic-demo
test file, so the `cat` above is only needed to narrow the run.
`.mut-bundle.cjs` is generated and gitignored.

**Mutation harness.** `.mut-run.mjs` takes a JSON file of
`[file, name, from, to]` mutations, and for each one copies the file
aside, applies the single replacement, confirms with `diff` that it
landed, rebuilds the fast bundle, runs it, and restores by file copy. It
scores a kill on failures, a non-zero exit *or* an assertion count below
the baseline, because a mutation that makes a test throw aborts the tap
run with no `not ok` line at all. `.mut-list.json` and `.mut-list2.json`
are the US-021 lists; twenty-one mutations re-run in about three
minutes. Write the list as you go rather than mutating by hand -- the
harness earns its keep the second time it runs.

**Never run two `npm test` invocations at once.** The suite builds and
then deletes a single shared `.test-bundle.cjs`, so whichever run
finishes second fails its own cleanup with `rm: .test-bundle.cjs: No
such file or directory` and exits **1 with every assertion green** --
`# tests 47676`, `# pass 47676`, zero `not ok`, `# ok`, then exit 1. A
non-zero exit whose tap output is entirely clean means the runs
overlapped, not that anything regressed. Re-run one at a time.

The standing-rule cleanup is safe to run beside the suite, contrary to
what it looks like: `pkill -f
"/Users/nick/code/webcrypto-mls/node_modules"` does *not* match the test
runner, whose command line carries no absolute repo path. For the same
reason `pgrep -fl "/Users/nick/code/webcrypto-mls"` finds nothing while
the suite is running -- absence there is not evidence the suite stopped.
Check for the `NPM TEST EXIT` line, not for a process.

**The operational probe.** This is the *only* verification of the Room --
no unit test covers `DurableObject` or `WebSocket` code, by design.

```bash
npm run worker:dev                              # port 8787
# 23 checks; exits non-zero on failure
node example-realistic-demo/scripts/probe.mjs
```

Check 23 fetches the page, so it needs `npm run build:realistic` to have
run at least once: wrangler serves the assets from
`example-realistic-demo/dist`, and a fresh checkout has none.

`scripts/.us023-mutate.mjs` is the Worker-side mutation harness, the
counterpart of `.mut-run.mjs`. It applies each mutation, restarts the
worker, runs the probe, and names the check that killed it.

---

## Process hygiene -- this matters

**Never use a bare `pkill -f wrangler` or `pkill -f workerd`.** This
machine runs Cloudflare dev servers for other repositories (`petpulse`,
`rebase.blog`, `focalrange`). Kill only by this repo's path:

```bash
pkill -f "/Users/nick/code/webcrypto-mls/node_modules"
pgrep -fl "/Users/nick/code/webcrypto-mls"   # confirm yours are gone
```

Running `wrangler dev` writes `example-realistic-demo/.wrangler/`. That is
gitignored and now also eslint-ignored (`c5aec49`); before that fix,
`npm run lint` went to 961 errors the moment anyone ran the dev server.

---

## What has repeatedly gone wrong -- please guard against it

The dominant failure mode across every phase has been **tests and checks
that pass for the wrong reason.** Phase 3 needed five review cycles for
this; Phase 4's probe had the same disease. Concrete instances:

- Assertions that hold no matter what the code does (`bCount <= 1` for an
  identity that can never appear; "no duplicates" on a function that
  returns a `Set`).
- Reserved-word tests satisfied by the length check, never reaching the
  reserved branch. Fixed by extracting `isReservedRoomId` so the rule can
  be called directly.
- A guard clause tested with `null`, where the mutant is *equivalent* for
  `null` -- only an array carrying valid-shaped fields distinguishes
  `!Array.isArray(v)` from a null-safe field read.
- A probe sending `kind` values that were not valid `EntryKind`s, so every
  frame was correctly rejected before reaching the code under test, and
  the failure was misdiagnosed as a broken Cloudflare API.

**Therefore: before claiming a check verifies something, break the code it
covers and confirm the check goes red.** Mutation testing found every one
of these. The pattern that works:

```bash
cp <file> /tmp/GOOD           # restore by file copy, NOT `git checkout --`,
<apply mutation>              # which reverts uncommitted work too
# always confirm the mutation actually applied
diff -q /tmp/GOOD <file> || echo "regex was a no-op"
<run the fast bundle or the probe>
cp /tmp/GOOD <file>
```

A documented coverage boundary already exists at the top of
`test/example-realistic-demo/protocol.ts`, listing five *equivalent*
mutants that no legitimate test can kill. Do not write tests chasing
those.

Subagent reports have been unreliable on exactly this kind of precision
work -- several claimed clean typechecks or verified mutations that did
not hold up. **Verify their claims independently before acting on them.**

---

## Remaining work

None in the plan. What is left is not implementation:

1. **The integration decision.** See "Finishing the branch" below.
2. **The human test plan.** `docs/test-plans/2026-07-28-realistic-demo.md`
   covers what no automated check reaches -- the two-profile join, the
   persistence toggle, and expiry. A person has to run it.
3. **Carry-forward finding 2c**, left open by decision. Any socket may
   claim any non-creator identity. Closing it needs per-identity
   authentication the plan does not call for.
4. **The deployed Worker is behind this branch.** It was last deployed at
   Phase 2. Redeploying needs the repository owner's approval, as it did
   the first time.

---

## Finishing the branch

Verified on the tip of `ralphing`, with a clean working tree and no dev
server left running for this repo:

| Check | Result |
|---|---|
| `npm test` | see the numbers above, exit 0 |
| `npm run lint` | exit 0 |
| Root typecheck | only the known `key-schedule.ts:73` TS2769 |
| Worker typecheck | no error lines |
| Probe | 23 passed, 0 failed, exit 0 |

The branch is 25 commits ahead of `realistic-demo`, which is where it was
cut from, and behind it by none. Three ways to take it from here:

1. Merge back to `realistic-demo` locally.
2. Push and open a pull request.
3. Leave the branch as it is, for review.

Nothing has been merged, pushed or deployed. That decision is the
repository owner's, and none of the three has been taken on their behalf.

---

## Commits through Phase 5 (oldest first, `4647c69..ac8bbf2`)

Phases 6-8 and the wrap-up are the commits after `ac8bbf2`; read them
with `git log --oneline ac8bbf2..ralphing`.

```
a6ec81e refactor: move constants, card-header, how-to-use to example-shared
5caf139 refactor: move storage-panel and storage-persistence to example-shared
f38b764 refactor: split DemoUser into example-shared/demo-user
b134afa refactor: move persistence-storage to example-shared
b64d573 fix: address code review feedback for Phase 1
2a6aca4 chore: add wrangler and realistic-demo scripts
9a4e76b feat: scaffold realistic-demo worker, client and config
cebe3b3 docs: record cloudflare dashboard settings for realistic demo
eab7cf1 fix: wrap long line in README to 80 columns
75d28c5 fix: correct schema path and README rationale for realistic demo
347bdaa docs: state the immediate reason the build root must be the repo root
8f2cc47 feat: add realistic-demo wire contract and pure room logic
429d6ec fix: address code review feedback for Phase 3
58a08bd fix: make the array-guard tests typecheck
08b42b9 test: close the remaining narrowing-helper coverage gaps
75ff933 test: cover the last narrowing-helper survivors
b37936a test: cover the Standing whitelist and the no-trim guarantee
79decd3 docs: record the mutation-testing coverage boundary
9f1049c feat: validate realistic-demo room ids
958c1f7 refactor: make the reserved-room-id rule verifiable
bbb189d feat: room log, replay and liveness over hibernating sockets
c6bc593 test: add realistic-demo room probe script
da3af15 fix: make the room probe actually exercise the room
c5aec49 fix: keep wrangler dev output out of lint
8bb5a6c fix: give the room probe teeth, and answer 400 for malformed ids
6f9525f docs: add execution handoff for the realistic demo plan
e086b92 fix: stop a failed socket open from swallowing the probe summary
3ed9c3d docs: record the phase 4 re-review and its mutation evidence
6e4e759 feat: count application entries at or below a cursor
769f9a9 feat: asynchronous join, identity ledger and room expiry
ac8bbf2 test: probe join, ledger, authorization and expiry
```
