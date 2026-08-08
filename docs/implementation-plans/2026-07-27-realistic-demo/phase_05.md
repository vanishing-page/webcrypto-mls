# Realistic Demo Implementation Plan -- Phase 5: Asynchronous join, ledger, and expiry

**Goal:** The room holds both halves of a join across absence, remembers
who it admitted and removed, and deletes itself on schedule.

**Architecture:** Three more tables turn the room from a log into
something that survives either party being away. A join request outlives
its requester's tab; a Welcome outlives its recipient's absence. The room
records who was admitted and removed, entirely on the creator's say-so and
verifying none of it, because it never parses a commit. An alarm deletes
the whole room three days after creation.

**Tech Stack:** Cloudflare Durable Objects (SQLite backend), Durable
Object alarms, WebSocket Hibernation API.

**Scope:** Phase 5 of 8 from `docs/design-plans/2026-07-27-realistic-demo.md`

**Codebase verified:** 2026-07-27

---

## Acceptance Criteria Coverage

This phase implements and tests:

### realistic-demo.AC3: Asking to join works across absence
- **realistic-demo.AC3.3 Success:** A join request survives its requester
  closing the tab, and is still pending on the creator's next visit

### realistic-demo.AC4: Approval, denial, and the identity ledger
- **realistic-demo.AC4.3 Success:** Denying discards the request and
  records no admission
- **realistic-demo.AC4.4 Success:** A repeat request from the same
  identity replaces the stored request rather than creating a second
- **realistic-demo.AC4.8 Failure:** `approve`, `deny`, `removed` or
  `welcome` without the creator token is answered with
  `error: 'not-creator'`

### realistic-demo.AC8: Rooms expire and say so
- **realistic-demo.AC8.1 Success:** Room creation sets an alarm for
  creation time plus three days, and the room reports its expiry time
- **realistic-demo.AC8.2 Success:** The alarm handler deletes all
  storage, deletes the alarm, closes live sockets, and is safe to run
  twice
- **realistic-demo.AC8.3 Success:** A `hello` for a room with no stored
  metadata is answered `no-room`, identically for an expired room and an
  id that never existed

**How these are verified.** All of these need a real Durable Object, so
they are verified operationally by extending the probe script from
Phase 4. The one pure piece -- counting application entries for
`priorCount` -- is extracted into `room-logic.ts` and unit tested.

---

## Codebase verification findings

Building on Phase 4, which is confirmed to provide:

- `Room` with `meta` and `log` tables created in `blockConcurrencyWhile`,
  `roomInfo()` as RPC, `fetch` for the WebSocket upgrade, and the
  `webSocketMessage` / `webSocketClose` / `webSocketError` handlers.
- Identity carried in `serializeAttachment` as `{ identity }`, set by
  `create` and `hello`. This phase widens that attachment.
- `broadcastRoster` computing `known` as `[meta.creator_identity]`, with
  a comment marking where this phase extends it with the ledger.
- `handle()` with a `default` branch rejecting the five control messages
  this phase implements.
- `room-logic.ts` with `nextSeq`, `entriesAfter`, `entryFromMls`,
  `assembleRoster`, `classifyStanding`, `isValidRoomId`.
- `protocol.ts` already defines every message this phase handles. **No
  change to the wire contract is needed or permitted here.**

## External dependency findings

Verified against current Cloudflare documentation on 2026-07-27.

- `ctx.storage.setAlarm(scheduledTime)`, `getAlarm()`, `deleteAlarm()`,
  all returning promises. One alarm per Durable Object -- `setAlarm`
  replaces any existing one.
- Alarms **retry on failure**, so the handler must be idempotent. This is
  what realistic-demo.AC8.2's "safe to run twice" is really about.
- `ctx.storage.deleteAll()` on the SQLite backend removes the entire
  contents of the object's private database, atomically. For a
  compatibility date of `2026-02-24` or later it **also deletes any
  active alarm**. Our compatibility date is `2026-07-27`, so `deleteAll()`
  already covers the alarm.
  https://developers.cloudflare.com/durable-objects/api/storage-api/

  The design nonetheless calls `deleteAlarm()` explicitly "rather than
  relying on `deleteAll()` to have done so". This plan keeps that
  explicit call. It is redundant under the current compatibility date but
  it is free, it is idempotent, and it means a future compatibility-date
  change cannot silently leave an alarm behind on a deleted room.

---

## Commands used throughout this phase

- **Worker typecheck:**
  `npx tsc -p example-realistic-demo/tsconfig.json --noEmit --declaration false --declarationMap false --listFiles false`
- **Root typecheck:**
  `npx tsc -p tsconfig.json --noEmit --declaration false --declarationMap false --listFiles false`
- **Lint:** `npm run lint`
- **Test:** `npm test`
- **Run the Worker:** `npm run worker:dev`

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->
<!-- START_TASK_1 -->
### Task 1: Add the prior-count rule to the pure logic

**Verifies:** None directly -- Task 2 tests it. It supports
realistic-demo.AC3.2 and realistic-demo.AC6.3, both claimed later.

The room stamps `priorCount` onto a `welcome-you`, so a joiner knows how
many messages it will never be able to read. Counting is pure, so it goes
where it can be tested.

**Files:**
- Modify: `example-realistic-demo/room-logic.ts`

**Step 1: Append to `room-logic.ts`**

```ts
/**
 * How many application messages sit at or below a cursor. A newcomer
 * gets this with its Welcome so the page can render one honest
 * placeholder -- "12 messages before you joined" -- rather than twelve
 * decrypt failures.
 *
 * Only `application` entries count. Commits and proposals are protocol
 * traffic and were never anything a person could read.
 */
export function countApplicationsAtOrBelow (
    entries:LogEntry[],
    cursor:number
):number {
    return entries.filter(entry => {
        return entry.kind === 'application' && entry.seq <= cursor
    }).length
}
```

**Step 2: Do not commit yet**

Task 2 adds the tests.
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Test the prior-count rule

**Verifies:** None (supports later ACs).

**Files:**
- Modify: `test/example-realistic-demo/room-logic.ts`

**Step 1: Add tests**

The file is already registered. Tests must cover:

- Counts only `application` entries, ignoring `commit` and `proposal`
  entries at or below the cursor. A log of one commit and two
  applications at or below the cursor counts 2, not 3.
- Ignores entries above the cursor entirely.
- Returns 0 for an empty log, and 0 for a cursor of 0.
- The boundary is inclusive: an application entry whose `seq` equals the
  cursor **is** counted. This is the case that decides whether a joiner's
  placeholder is off by one.

**Step 2: Run**

```bash
npm test
npm run lint
```

Expected: passes, count higher than before.

**Step 3: Commit**

```bash
git add -A
git commit -m "feat: count application entries at or below a cursor"
```
<!-- END_TASK_2 -->
<!-- END_SUBCOMPONENT_A -->

<!-- START_TASK_3 -->
### Task 3: Add the three tables and creator authorization

**Verifies:** realistic-demo.AC4.8 (confirmed operationally in Task 6)

**Files:**
- Modify: `example-realistic-demo/index.ts`

**Step 1: Extend the schema**

In the `blockConcurrencyWhile` block of the constructor, add three
`sql.exec` calls after the existing `meta` and `log` ones:

```ts
            ctx.storage.sql.exec(`
                CREATE TABLE IF NOT EXISTS pending (
                    identity TEXT PRIMARY KEY,
                    key_package TEXT NOT NULL,
                    requested_at INTEGER NOT NULL
                )
            `)
            ctx.storage.sql.exec(`
                CREATE TABLE IF NOT EXISTS mailbox (
                    recipient TEXT PRIMARY KEY,
                    payload TEXT NOT NULL,
                    cursor INTEGER NOT NULL,
                    prior_count INTEGER NOT NULL
                )
            `)
            ctx.storage.sql.exec(`
                CREATE TABLE IF NOT EXISTS ledger (
                    identity TEXT NOT NULL,
                    status TEXT NOT NULL,
                    PRIMARY KEY (identity, status)
                )
            `)
```

`pending.identity` is the primary key, which is what makes
realistic-demo.AC4.4 true by construction: a repeat request from the same
identity replaces the stored row rather than adding a second. It is
enforced by the schema, not by application logic that could be forgotten.

`mailbox.recipient` is likewise a primary key -- one pending Welcome per
recipient, replaced if reissued.

`ledger` has a composite key so one identity can be both `admitted` and
`removed`, which is exactly the history `classifyStanding` reads to
return `previously-removed`.

**Step 2: Widen the socket attachment to carry creator status**

Replace the `SocketState` interface and the `attach` / `readAttachment`
helpers:

```ts
interface SocketState {
    identity:string
    isCreator:boolean
}
```

```ts
    private attach (
        ws:WebSocket,
        identity:string,
        isCreator:boolean
    ):void {
        const state:SocketState = { identity, isCreator }
        ws.serializeAttachment(state)
    }

    private readAttachment (ws:WebSocket):SocketState|null {
        const value = ws.deserializeAttachment()
        if (!value || typeof value !== 'object') return null
        const state = value as Partial<SocketState>
        if (typeof state.identity !== 'string') return null
        return {
            identity: state.identity,
            isCreator: state.isCreator === true
        }
    }
```

The attachment is the right home for this: it survives hibernation, and
it means authorization is decided once at `hello` rather than re-checked
against storage on every control message.

**Step 3: Establish creator status on connect**

In `onCreate`, the caller is the creator by definition:

```ts
        this.attach(ws, identity, true)
```

In `onHello`, the token decides. Change the signature to accept the
optional token and compare it:

```ts
    private onHello (
        ws:WebSocket,
        identity:string,
        cursor:number,
        creatorToken?:string
    ):void {
        const meta = this.readMeta()
        if (!meta) {
            return this.send(ws, { type: 'no-room' })
        }

        // Both must hold. The identity alone is public -- it is a
        // signature key anyone in the room has seen -- so the token is
        // what actually authorizes.
        const isCreator = (
            creatorToken !== undefined &&
            creatorToken === meta.creator_token &&
            identity === meta.creator_identity
        )

        this.replaceExistingSocket(ws, identity)
        this.attach(ws, identity, isCreator)

        // ... rest unchanged: room-state, replay, roster
    }
```

Update the `hello` case in `handle()` to pass `msg.creatorToken`.

Note `room-state.isCreator` should now report this computed `isCreator`
rather than comparing identities, so the page never shows creator
controls to someone who cannot use them.

**Step 4: Add the authorization guard**

```ts
    /**
     * Control messages that write to the ledger or the mailbox are
     * creator-only. The room cannot verify the claims themselves -- it
     * never parses a commit -- so the token is the only thing standing
     * between the ledger and anyone who can open a socket.
     */
    private requireCreator (ws:WebSocket):SocketState|null {
        const state = this.readAttachment(ws)
        if (!state?.isCreator) {
            this.send(ws, { type: 'error', reason: 'not-creator' })
            return null
        }
        return state
    }
```

**Step 5: Typecheck**

```bash
npx tsc -p example-realistic-demo/tsconfig.json --noEmit --declaration false --declarationMap false --listFiles false
```

Expected: clean. `handle()` still has a `default` branch rejecting the
five new message types -- Task 4 replaces it.

**Step 6: Do not commit yet**

Task 4 uses these tables.
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Handle join, approval, denial, removal and Welcome

**Verifies:** realistic-demo.AC3.3, realistic-demo.AC4.3,
realistic-demo.AC4.4, realistic-demo.AC4.8 (all confirmed operationally
in Task 6)

**Files:**
- Modify: `example-realistic-demo/index.ts`

**Step 1: Replace the `default` branch in `handle()`**

```ts
            case 'join-request':
                return this.onJoinRequest(
                    ws, msg.identity, msg.keyPackage
                )
            case 'approve':
                return this.onApprove(ws, msg.identity)
            case 'deny':
                return this.onDeny(ws, msg.identity)
            case 'removed':
                return this.onRemoved(ws, msg.identity)
            case 'welcome':
                return this.onWelcome(ws, msg.to, msg.payload)
```

The `default` branch stays, now genuinely unreachable for well-formed
messages, and still returns `bad-message`.

**Step 2: Add the handlers**

```ts
    /**
     * A request outlives the tab that made it. `INSERT OR REPLACE` on a
     * primary key of identity means asking twice replaces the first ask
     * rather than queueing a duplicate for the creator to wade through.
     */
    private onJoinRequest (
        ws:WebSocket,
        identity:string,
        keyPackage:string
    ):void {
        if (!this.readMeta()) {
            return this.send(ws, { type: 'no-room' })
        }

        this.ctx.storage.sql.exec(
            `INSERT OR REPLACE INTO pending
                (identity, key_package, requested_at)
             VALUES (?, ?, ?)`,
            identity, keyPackage, Date.now()
        )

        this.attach(ws, identity, false)
        this.sendPendingToCreator()
    }

    /**
     * Recording an admission is an act of faith. The room was told a
     * commit exists; it did not check, and could not.
     */
    private onApprove (ws:WebSocket, identity:string):void {
        if (!this.requireCreator(ws)) return

        this.ctx.storage.sql.exec(
            `INSERT OR IGNORE INTO ledger (identity, status)
             VALUES (?, 'admitted')`,
            identity
        )
        this.ctx.storage.sql.exec(
            'DELETE FROM pending WHERE identity = ?',
            identity
        )

        this.sendPendingToCreator()
        this.broadcastRoster()
    }

    /**
     * Denial discards the request and records nothing. A denied
     * identity is not `previously-removed` -- it was never admitted, so
     * it stays a stranger and may ask again.
     */
    private onDeny (ws:WebSocket, identity:string):void {
        if (!this.requireCreator(ws)) return

        this.ctx.storage.sql.exec(
            'DELETE FROM pending WHERE identity = ?',
            identity
        )
        this.ctx.storage.sql.exec(
            'DELETE FROM mailbox WHERE recipient = ?',
            identity
        )

        this.sendPendingToCreator()
    }

    private onRemoved (ws:WebSocket, identity:string):void {
        if (!this.requireCreator(ws)) return

        this.ctx.storage.sql.exec(
            `INSERT OR IGNORE INTO ledger (identity, status)
             VALUES (?, 'removed')`,
            identity
        )
        this.ctx.storage.sql.exec(
            'DELETE FROM mailbox WHERE recipient = ?',
            identity
        )

        this.broadcastRoster()
    }

    /**
     * The room stamps the cursor, not the client. Because one socket
     * processes messages in order and the creator sends the commit
     * before the Welcome, that commit is already in the log by the time
     * this runs -- so the current high-water mark is exactly the epoch
     * the newcomer is joining at. Letting the client compute this would
     * add a round trip and an opportunity to get it wrong.
     */
    private onWelcome (
        ws:WebSocket,
        to:string,
        payload:string
    ):void {
        if (!this.requireCreator(ws)) return

        const cursor = this.highWater()
        // LogRow, not LogEntry: sql.exec<T> constrains T to
        // Record<string, SqlStorageValue>, which an interface does not
        // satisfy. See the type alias added in Phase 4.
        const rows = this.ctx.storage.sql
            .exec<LogRow>(
                'SELECT seq, sender, kind, payload FROM log'
            )
            .toArray()
        const all = rows.map(row => ({
            seq: row.seq,
            sender: row.sender,
            kind: row.kind as LogEntry['kind'],
            payload: row.payload
        }))
        const priorCount = countApplicationsAtOrBelow(all, cursor)

        this.ctx.storage.sql.exec(
            `INSERT OR REPLACE INTO mailbox
                (recipient, payload, cursor, prior_count)
             VALUES (?, ?, ?, ?)`,
            to, payload, cursor, priorCount
        )

        // Deliver now if they are here; otherwise it waits in the
        // mailbox until their next connect.
        this.deliverMailbox(to)
    }
```

Add `countApplicationsAtOrBelow` to the existing `./room-logic.js`
import.

**Step 3: Add the delivery and pending helpers**

```ts
    /**
     * A Welcome issued while its recipient was offline is delivered on
     * their next connect. Delivered mail is deleted -- a Welcome is
     * consumed once, and replaying it later would try to rejoin a group
     * the client is already in.
     */
    private deliverMailbox (identity:string):void {
        const rows = this.ctx.storage.sql
            .exec<{
                payload:string
                cursor:number
                prior_count:number
            }>(
                `SELECT payload, cursor, prior_count FROM mailbox
                 WHERE recipient = ?`,
                identity
            )
            .toArray()

        const mail = rows[0]
        if (!mail) return

        for (const peer of this.ctx.getWebSockets()) {
            const state = this.readAttachment(peer)
            if (state?.identity !== identity) continue

            this.send(peer, {
                type: 'welcome-you',
                payload: mail.payload,
                cursor: mail.cursor,
                priorCount: mail.prior_count
            })

            this.ctx.storage.sql.exec(
                'DELETE FROM mailbox WHERE recipient = ?',
                identity
            )
            return
        }
    }

    /**
     * Pending requests go only to the creator, and only to a socket that
     * proved it with the token.
     */
    private sendPendingToCreator ():void {
        const rows = this.ctx.storage.sql
            .exec<{
                identity:string
                key_package:string
                requested_at:number
            }>('SELECT * FROM pending ORDER BY requested_at ASC')
            .toArray()

        const admitted = this.ledgerIdentities('admitted')
        const removed = this.ledgerIdentities('removed')

        const requests:PendingRequest[] = rows.map(row => ({
            identity: row.identity,
            keyPackage: row.key_package,
            requestedAt: row.requested_at,
            standing: classifyStanding(row.identity, admitted, removed)
        }))

        for (const peer of this.ctx.getWebSockets()) {
            const state = this.readAttachment(peer)
            if (!state?.isCreator) continue
            this.send(peer, { type: 'pending', requests })
        }
    }

    private ledgerIdentities (status:string):string[] {
        return this.ctx.storage.sql
            .exec<{ identity:string }>(
                'SELECT identity FROM ledger WHERE status = ?',
                status
            )
            .toArray()
            .map(row => row.identity)
    }
```

Add `classifyStanding` to the `./room-logic.js` import and
`PendingRequest` to the `./protocol.js` type import.

**Step 4: Deliver the backlog on connect, mailbox before replay**

A Welcome must reach a joiner **before** the log batch that follows it.
A joiner connects with `cursor: 0`, so `onHello` would otherwise send the
entire log first, and the client would be handed entries for a group it
has not joined yet.

So restructure `onHello` to send in this order:

1. `room-state`
2. `welcome-you`, if the mailbox holds one for this identity
3. the `log` batch
4. `roster`
5. `pending`, if this socket is the creator's

Move the existing replay block so it comes **after** `deliverMailbox`:

```ts
        // The mailbox first. A joiner arrives with cursor 0, so the
        // replay below would otherwise deliver the whole log before the
        // Welcome that makes any of it processable.
        this.deliverMailbox(identity)

        const missed = this.entriesSince(cursor)
        if (missed.length > 0) {
            this.send(ws, { type: 'log', entries: missed })
        }

        this.broadcastRoster()
        if (isCreator) this.sendPendingToCreator()
```

Note this does not fully solve the ordering problem on its own -- a
joiner's `welcome-you` carries a cursor at the commit that added them, so
the log batch still contains entries from before they joined. Phase 6
Task 6 states the client-side rule that completes it. Sending the
Welcome first is what makes that rule expressible.

This is what makes realistic-demo.AC3.3 and realistic-demo.AC3.4 true:
neither half of a join needs both parties present at the same moment.

**Step 5: Extend the roster with the ledger**

In `broadcastRoster`, replace the `known` computation:

```ts
        const admitted = this.ledgerIdentities('admitted')
        const removed = new Set(this.ledgerIdentities('removed'))
        const known = [
            meta.creator_identity,
            ...admitted.filter(id => !removed.has(id))
        ]
```

The creator is always known -- they never approve themselves, so they
never appear in the ledger.

**Step 6: Typecheck and lint**

```bash
npx tsc -p example-realistic-demo/tsconfig.json --noEmit --declaration false --declarationMap false --listFiles false
npm run lint
```

Expected: both clean.

**Step 7: Do not commit yet**

Task 5 adds expiry, and a room that never expires should not be committed
as a milestone.
<!-- END_TASK_4 -->

<!-- START_TASK_5 -->
### Task 5: Expire the room

**Verifies:** realistic-demo.AC8.1, realistic-demo.AC8.2,
realistic-demo.AC8.3 (all confirmed operationally in Task 6)

**Files:**
- Modify: `example-realistic-demo/index.ts`

**Step 1: Set the alarm at creation**

`onCreate` already computes `expiresAt`. Setting the alarm makes it real.
`setAlarm` returns a promise, so `onCreate` becomes async -- update its
call site in `handle()` to `return this.onCreate(...)`, which already
returns the promise.

Immediately after the `INSERT INTO meta`:

```ts
        await this.ctx.storage.setAlarm(expiresAt)
```

Change the signature to
`private async onCreate (ws:WebSocket, identity:string):Promise<void>`.

Note the sequencing: the row is written before the alarm is set. If the
alarm write failed, a room would exist that never expires, which is
recoverable. The reverse -- an alarm with no room -- would fire against
nothing.

**Step 2: Add the alarm handler**

```ts
    /**
     * The room's whole life ends here. Alarms retry on failure, so this
     * must be safe to run twice: deleting an already-empty room is a
     * no-op, and closing an already-closed socket is caught.
     */
    async alarm ():Promise<void> {
        // Close first. After deleteAll the room cannot answer anything
        // meaningful, and a client left holding an open socket to a
        // room that no longer exists would sit there waiting.
        for (const ws of this.ctx.getWebSockets()) {
            try {
                ws.close(1000, 'room expired')
            } catch (_err) {
                // Already closed. Nothing to do.
            }
        }

        await this.ctx.storage.deleteAll()

        // Redundant under our compatibility date, where deleteAll also
        // clears the alarm. Kept because it is free and idempotent, and
        // because a future compatibility-date change must not silently
        // leave an alarm on a deleted room.
        await this.ctx.storage.deleteAlarm()
    }
```

**Step 3: Confirm the gone path already works**

No new code is needed for realistic-demo.AC8.3. `onHello` already returns
`{ type: 'no-room' }` when `readMeta()` is null, and after `deleteAll()`
there is no `meta` row. An expired room and an id that never existed are
deliberately the same state -- nothing distinguishes them once the
storage is gone, and inventing a tombstone would only need its own
lifetime.

Verify by reading `onHello`: the `!meta` branch must come before anything
that touches another table.

**Step 4: Typecheck, lint, and confirm no regression**

```bash
npx tsc -p example-realistic-demo/tsconfig.json --noEmit --declaration false --declarationMap false --listFiles false
npm run lint
npm test
```

Expected: all clean, test count unchanged from Task 2.

**Step 5: Commit**

```bash
git add -A
git commit -m "feat: asynchronous join, identity ledger and room expiry"
```
<!-- END_TASK_5 -->

<!-- START_TASK_6 -->
### Task 6: Verify against a running Worker

**Verifies:** realistic-demo.AC3.3, realistic-demo.AC4.3,
realistic-demo.AC4.4, realistic-demo.AC4.8, realistic-demo.AC8.1,
realistic-demo.AC8.2, realistic-demo.AC8.3

**Files:**
- Modify: `example-realistic-demo/scripts/probe.mjs`

**Step 1: Extend the probe script**

Add a second suite to the script from Phase 4. It must perform:

1. **Creator token required (realistic-demo.AC4.8).** Connect as a
   non-creator (plain `hello`, no token) and send each of `approve`,
   `deny`, `removed` and `welcome`. Assert **all four** are answered
   `{"type":"error","reason":"not-creator"}`. Then connect with a
   *wrong* token and assert the same four rejections -- a wrong token
   must be no better than none. Then connect with the correct token and
   assert the same messages are accepted.

2. **Request survives the requester leaving (realistic-demo.AC3.3).**
   Connect as B, send `join-request`, then **close B's socket entirely**.
   Reconnect as the creator with the token and assert the `pending`
   message still lists B, with B's `keyPackage` intact and a `standing`
   of `stranger`.

3. **Repeat request replaces (realistic-demo.AC4.4).** Send
   `join-request` twice from B with two different key packages. Assert
   the creator's `pending` list contains **exactly one** entry for B, and
   that it carries the **second** key package.

4. **Denial records nothing (realistic-demo.AC4.3).** Deny B, assert the
   `pending` list no longer contains B. Then have B request again and
   assert B's `standing` is still `stranger`, not `previously-removed` --
   denial is not removal.

5. **Welcome across absence (supports realistic-demo.AC3.4).** With B
   offline, have the creator send an `mls` commit and then a `welcome`
   addressed to B. Connect B and assert B receives `welcome-you` with a
   `cursor` equal to the seq of that commit and a plausible
   `priorCount`. Reconnect B a second time and assert the `welcome-you`
   is **not** delivered again -- it was consumed.

6. **Standing after removal (realistic-demo.AC4.7 at the wire).**
   Approve B, then send `removed` for B, then have B request again.
   Assert B's `standing` is `previously-removed`.

7. **Expiry (realistic-demo.AC8.1).** Create a room and assert the
   `created` message's `expiresAt` is three days from now, within a
   generous tolerance.

**Step 2: Verify the alarm handler directly**

A three-day wait is not a test. Verify the handler instead by temporarily
shortening the lifetime: change `ROOM_LIFETIME_MS` to `5000`, restart
`wrangler dev`, and run:

- Create a room and open a socket.
- Wait past the alarm.
- Assert the socket was **closed** by the server.
- Assert `GET /api/room/<id>` now returns **404**
  (realistic-demo.AC8.3 -- indistinguishable from an id that never
  existed).
- Assert a fresh `hello` to that room id is answered
  `{"type":"no-room"}`.

**Then verify idempotency (realistic-demo.AC8.2).** With the room already
expired and empty, trigger the handler a second time. `wrangler dev`
does not expose a way to fire an alarm on demand, so do this by creating
a second room with the short lifetime, letting it expire, and then
letting a second alarm fire against the now-empty room -- or, more
simply, by temporarily adding a debug RPC method that calls
`this.alarm()` directly, calling it twice, and asserting neither call
throws and the room stays empty.

**Restore `ROOM_LIFETIME_MS` to `3 * 24 * 60 * 60 * 1000` and remove any
debug method before committing.** Confirm with:

```bash
grep -n "ROOM_LIFETIME_MS =" example-realistic-demo/index.ts
```

Expected: shows the three-day value, not the test value.

**Step 3: Run the full probe**

```bash
npm run worker:dev
```

In a second terminal:

```bash
node example-realistic-demo/scripts/probe.mjs
```

Expected: every check from Phase 4 and this phase passes, exit 0.

**Step 4: Stop the Worker**

Stop `wrangler dev`. Do not leave it running.

**Step 5: Commit**

```bash
git add -A
git commit -m "test: probe join, ledger, authorization and expiry"
```
<!-- END_TASK_6 -->

---

## Phase 5 completion checklist

- [ ] `pending`, `mailbox` and `ledger` tables created
- [ ] Repeat join request replaces, enforced by primary key
- [ ] `approve`, `deny`, `removed`, `welcome` all reject a non-creator
      and a wrong token with `not-creator`
- [ ] Denial records no admission and leaves standing as `stranger`
- [ ] A request survives its requester disconnecting
- [ ] A Welcome survives its recipient being offline, and is consumed
      once
- [ ] `welcome` cursor is stamped by the room from the high-water mark
- [ ] `onHello` sends `welcome-you` before the `log` batch
- [ ] Row types at the SQL boundary are type aliases, not interfaces
- [ ] Roster `known` extended with admitted-minus-removed
- [ ] Alarm set at creation for creation time plus three days
- [ ] `alarm()` closes sockets, deletes all storage, deletes the alarm,
      and is safe to run twice
- [ ] Expired room answers `no-room`, identical to a never-existed id
- [ ] `ROOM_LIFETIME_MS` restored to three days; no debug method left
- [ ] `npm test`, `npm run lint`, both typechecks pass
- [ ] Worker stopped
