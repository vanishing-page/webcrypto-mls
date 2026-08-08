# Acceptance-criteria coverage, realistic demo

Every `realistic-demo.AC*` criterion in
`docs/design-plans/2026-07-27-realistic-demo.md`, against the thing that
would notice it breaking. Written for US-023, the whole-branch review.

Four kinds of evidence, and they are not equal:

- **Node** -- a test under `test/example-realistic-demo/` or
  `test/example/`, run by `npm test` and by the fast bundle. Standing:
  it runs on every change.
- **Probe** -- a numbered check in `example-realistic-demo/scripts/probe.mjs`
  against a live `npm run worker:dev`. Standing, but only when someone
  runs it. It is the only verification the Worker has.
- **Browser** -- a check in one of the four Playwright harnesses in
  `example-realistic-demo/scripts/`. Standing, same caveat.
- **Recorded** -- a step done once by hand and written down in
  `progress.log`. This verifies that the behaviour was right on the day
  and cannot notice it breaking afterwards. Treated here as the weakest
  kind, and only used where the first three cannot reach.

## AC1: The Worker serves the page and the API

| Criterion | Evidence |
| --- | --- |
| AC1.1 unmatched path is 200 with the page | Probe 23 |
| AC1.2 loads from the origin, `wss://` on that origin, no configured endpoint | Node `delivery-client - the socket url comes from where the page loaded` and `- a plain-http page gets a ws socket`; browser step, US-008. Deployed origin: see gaps below |
| AC1.3 `GET /api/room/:id` returns the times | Probe 4 |
| AC1.4 unknown id is 404 | Probe 1 |
| AC1.5 bad or reserved id is rejected | Probe 2; Node `isValidRoomId` and `isReservedRoomId`, 25 cases |

## AC2: A visitor creates one user and one room

| Criterion | Evidence |
| --- | --- |
| AC2.1 one key package, one non-extractable signature keypair | Node `createUser makes one key package`, `the signature key is a non-extractable CryptoKey` |
| AC2.2 group of one, navigates to `/<roomId>`, group id independent | Node `createOwnGroup makes a group of one at epoch zero`, `the group id is random, not derived`, `routeFromPath - a valid room id routes to that room`; browser, US-008 |
| AC2.3 the full URL is shown and can be copied | Node `RoomLink shows the whole absolute URL`, `RoomLink has a copy control that reports the copy`; browser, US-008, a real OS-clipboard paste |
| AC2.4 a second `create` is `room-exists` | Probe 21 |

## AC3: Asking to join works across absence

| Criterion | Evidence |
| --- | --- |
| AC3.1 name field, then a `join-request` and the waiting state | Node `connection - a joiner follows hello with a join-request`, `Waiting shows the room it is waiting on and the name given`; browser `B opens the link and is asked for a name`, `B asks to join and waits` |
| AC3.2 `welcome-you` joins and adopts `cursor` and `priorCount` | Node `joinFromWelcome joins the group the Welcome names`; browser `B joins from the Welcome`, `a late joiner is told how many messages it missed` |
| AC3.3 a request survives its requester leaving | Probe 12; browser `a request made while the creator is away survives` |
| AC3.4 a Welcome issued during absence is delivered on connect | Probe 15; browser `a Welcome issued while F is away is delivered on connect` |

## AC4: Approval, denial, and the identity ledger

| Criterion | Evidence |
| --- | --- |
| AC4.1 commit, Welcome, approve, in that order, and the newcomer joins | Node `approvals - approve sends the commit, the Welcome, then the ok`, `- the frames carry a commit and a joinable Welcome`; browser `approve sends commit, welcome, approve in that order` |
| AC4.2 a pre-approved request is committed with no prompt | Node `approvals - a pre-approved request is committed with no prompt`; browser `a pre-approved request is committed with no prompt` |
| AC4.3 denial discards and records no admission | Probe 14; Node `approvals - deny sends a deny and nothing else` |
| AC4.4 a repeat request replaces the stored one | Probe 13 |
| AC4.5 neither set is `stranger` | Node `classifyStanding`, three cases |
| AC4.6 admitted and not removed is `pre-approved` | Node `classifyStanding`, two cases |
| AC4.7 removed is `previously-removed`, including in both sets | Node `classifyStanding`, three cases; probe 16 |
| AC4.8 the four control messages need the creator token | Probe 11 |

## AC5: Membership, liveness, and removal

| Criterion | Evidence |
| --- | --- |
| AC5.1 members and epoch from this client's own tree, live or replayed | Node `membersFromTree` and `leafIndexOf`, 12 tests; `Room lists every member of its own tree, by name`; `connection - a log batch applies in order and moves the cursor`; browser `A and B agree on the members and the epoch` |
| AC5.2 a dropped socket marks disconnected and stays in the group | Probe 9; Node `Room marks who is connected without unlisting anyone`; browser `a dropped socket marks Away and touches no group state`, `the Away mark clears when the socket comes back` |
| AC5.3 only the creator renders Remove | Node `Room offers Remove to the creator and to nobody else`, `Room never offers Remove against the person looking at it`; browser `B is offered no Remove control, for anybody` |
| AC5.4 Remove commits, sends `removed`, epoch advances, leaf blanks | Node `approvals - remove advances the epoch and drops the leaf`, `- remove sends the commit before telling the room`; probe 19; browser `A removes B: epoch advances by one, the leaf goes` |
| AC5.5 the removed member's page reports it rather than failing | Node `applyEntry - being removed is reported, not thrown`, `Room says plainly when this client was removed` |

## AC6: Chat, replay, and undecryptable history

| Criterion | Evidence |
| --- | --- |
| AC6.1 encrypted to the group, decrypted by other members | Node `chat - a message is encrypted and sent as an application entry`, `- what was sent is what the group decrypts`, `the ciphertext does not carry the plaintext`; browser, a message each way with no plaintext in any frame |
| AC6.2 returning replays what was missed, in order | Browser `a returning client replays what it missed, in order`; Node `entry-queue - applies a batch in order` |
| AC6.3 pre-join entries are one counted placeholder | Node `buildTimeline`, five tests on the leading mark |
| AC6.4 consecutive undecryptable entries collapse into one count | Node `buildTimeline - three misses in a row are one counted mark`, `- a readable message breaks the run`, `- two separate runs keep separate counts` |
| AC6.5 own past entries render from recorded plaintext | Node `buildTimeline - an own entry with recorded plaintext is text`, `applyEntry - this client's own message comes from what it sent`; live only, not across a reload: see gaps below |
| AC6.6 joining at epoch zero shows no leading placeholder | Node `buildTimeline - joining at the start gives no leading mark`, `Room shows no leading placeholder for a founding member` |

## AC7: Persistence is a standing control

| Criterion | Evidence |
| --- | --- |
| AC7.1 present before any user and throughout | Browser `the persist control is there before any user exists`; Node `Persistence offers a toggle that reflects and reports its state` |
| AC7.2 on writes whatever state exists | Node `sessionInputFrom`, three tests, and `setPersist - on with a user writes the session`, `watch - re-saves when the group, cursor or token changes` |
| AC7.3 off deletes the stored state | Node `setPersist - off clears the stored session`; browser `persist off deletes the stored session` |
| AC7.4 a reload restores the group and the cursor | Node `restore - a record with group state comes back as a member`, `- a record from after a removal comes back removed`; browser `a reload restores the group at the epoch it was at`, `chat still works after the restore` |
| AC7.5 a waiting joiner is persisted and returns to waiting | Node `sessionInputFrom - a waiting joiner is written without a group`, `restore - a record with no group comes back to waiting`; browser `a waiting joiner persists and returns to waiting` |
| AC7.6 Reset takes only this demo, leaves the room and the other demos | Node `reset - deletes this demo's database and turns persistence off`; browser `delete takes only this demo's database`, `reset deletes only this demo and leaves the room standing` |

## AC8: Rooms expire and say so

| Criterion | Evidence |
| --- | --- |
| AC8.1 an alarm three days out, and the room reports its expiry | Probe 17; Node `Explainer shows the expiry only once the room has given one` |
| AC8.2 the alarm handler deletes, clears, closes, and is safe twice | No standing check: see gaps below |
| AC8.3 `hello` with no metadata is `no-room`, identically either way | Probe 22 for the never-existed half; the expired half is the same code path and is covered by that check plus the recorded expiry run, see gaps |
| AC8.4 the gone view says both cases and offers a new room | Node `Gone says both cases at once, having no way to tell them apart`, `Gone offers a way to start a new room`; browser `an id with no room behind it renders the gone view` and the two after it |

## AC9: Ordering integrity

| Criterion | Evidence |
| --- | --- |
| AC9.1 monotonic `seq`, and a replay returns only entries after the cursor | Probe 5, 7; Node `nextSeq`, five tests, and `entriesAfter`, six |
| AC9.2 a second socket for an identity replaces the first | Probe 8 |
| AC9.3 a live `entry` during a `log` batch is applied after it | Node `entry-queue - a mid-drain push is applied after the batch`, `- a push during a drain starts no second drain`, `connection - a live entry after a batch keeps the order` |

## AC10: Cross-cutting behaviors

| Criterion | Evidence |
| --- | --- |
| AC10.1 a valid frame of each message type is accepted | Node `isClientMessage` and `isRoomMessage`, one test per variant |
| AC10.2 unknown type, missing field, non-object are rejected | Node, 30-odd rejection tests in the same file |
| AC10.3 `payload` and `kind` stored and forwarded verbatim, never decoded | Node `entryFromMls`, seven tests including padding, empty and no-trim; probe 5 |
| AC10.4 the cursor never moves backward and never skips a gap | Node `advanceCursor`, six tests, and `entryPosition`, four |
| AC10.5 backoff grows and is capped | Node `reconnectDelay`, six tests; browser, US-008, gaps of 1012, 2004, 4005, 8006, 16006 then 30009 ms |
| AC10.6 the page states the three disclosures | Node `Room says creator-only removal is interface, not cryptography`, `Room says a disconnected member is still in the group`, `Room says what a placeholder stands for` |

## room-you-section: The "You" block marking this client

| Criterion | Evidence |
| --- | --- |
| room-you-section.AC1.1 one `.you` block | Node `Room says who this client is` |
| room-you-section.AC1.2 name from own leaf | Node `Room says who this client is`, `the You block follows the leaf, not the first member` |
| room-you-section.AC1.3 full base64url key | Node `Room says who this client is`, `the You block follows the leaf, not the first member` |
| room-you-section.AC1.4 leaf index | Node `Room says who this client is`, `the You block follows the leaf, not the first member` |
| room-you-section.AC1.5 role creator vs member | Node `the You block says which of the two roles this client has` |
| room-you-section.AC1.6 leaf not in tree | Node `the You block survives a leaf that is not in the tree` |
| room-you-section.AC2.1 one `.member` marked | Node `Room marks which member is the person looking at it` |
| room-you-section.AC2.2 one `.live` item marked | Node `Room marks this client in the connected list, when it is in it` |
| room-you-section.AC2.3 two members share a name | Node `the mark follows the leaf when two members share a name` |
| room-you-section.AC2.4 nobody marked when absent | Node `Room marks nobody live when this client is not connected` |
| room-you-section.AC3.1 one copy control, named for the key | Node `CopyControl has one copy button, named for its value`, `the You block offers to copy the key, named for the key` |
| room-you-section.AC3.2 confirmation only after a copy | Node `CopyControl confirms a copy only once one has happened` |
| room-you-section.AC3.3 refusal reaches state.status | Node `a refused copy of the key is reported to the person`; a real clipboard refusal is not reachable by any harness, see AC2.3 pattern |
| room-you-section.AC4.1 disclosure states the routing claim only | Node `Room says what the room routes on, beside the keys` for the paragraph still rendering; Recorded for the wording, Part 4 step 2 of the test plan. No test asserts the words, by house rule |
| room-you-section.AC4.2 name-disclosure inside `.you` | Node `the You block says a name is not hidden from the server` |

## Criteria without full coverage

Five, each recorded rather than quietly counted as covered. Three are
the realistic demo's own; two came in with the "You" section.

**AC1.2, the deployed half.** That the page loads from the *deployed*
Worker origin is not verified, because standing rule 6 makes redeploying
the repository owner's call and this branch has not deployed. What is
verified is everything that would differ: the socket URL is derived from
`location` and not from any configured endpoint, in Node in both
polarities, and the whole demo runs against `localhost:8787` with the
socket on the page's own host. Deploying is the last step of
`phase_08.md` Task 6 and is the one item its checklist leaves open.

**AC6.5, across a reload.** Own messages render from recorded plaintext
while the page is up, which is what the Node tests cover. The stored
session record holds no plaintexts, so after a reload a client's own past
entries come back as placeholders rather than as text. This is a design
consequence, not a defect in the fold: MLS cannot decrypt a message it
produced, so the only source is the local record, and persisting message
plaintexts would be a different privacy decision than the one this demo
made. Recorded first in US-018 and again in US-020; the page says so, in
the placeholder disclosure. Covering it would mean storing plaintexts,
which is a design change and is out of this branch's scope.

**AC8.2, the alarm handler.** `alarm()` cannot be reached from either
harness: the probe cannot make a Durable Object alarm fire, and the
handler is platform code with no pure part to unit test. It has been run
once, in Phase 5, by adding a temporary RPC method and route that do to
storage exactly what `alarm()` does, which is recorded in `HANDOFF.md`
along with why that is not the same thing as running `alarm()` itself.
What is covered standing: that the alarm is *set*, three days out
(probe 17), and that a room with no metadata answers `no-room` from a
socket that is already attached (probe 22), which is the state the
handler leaves behind. The uncovered part is the handler's own four
steps and its second run. This is the strongest candidate for the human
test plan in US-024.

**room-you-section.AC3.3, the refusal itself.** That a clipboard refusal
reaches `state.status` is covered standing, in Node. What is not covered
is the other half of the same sentence, that the confirmation does not
appear: `CopyValue` calls `useSignal`, so the Node suite can only reach
it as an unexpanded component vnode, and a search of that tree for a
confirmation finds nothing whatever the code does. So the
`copied.value = false` in its `catch` -- and the identical line in
`ShareRoomLink` -- is executed by no test and by no harness. Verified,
not assumed: deleting either line leaves the full suite and both
Playwright harnesses green. The presentational half is properly covered
by `CopyControl confirms a copy only once one has happened`, which
asserts both polarities of `data-copied` against a component that takes
`copied` as a prop. Closing the gap needs a browser step that provokes a
real refusal, which is Part 1 step 1.16 of the test plan.

**room-you-section.AC4.1, the wording.** That the paragraph still
renders is covered in Node. That it makes the routing claim and no
longer makes the naming claim is a statement about words, and the house
rule forbids asserting on rendered text. Recorded, at Part 4 step 2.
