# 07: Skipped generations retain a key/nonce pair, not the chain secret

**What to build:** part of audit finding H2, spec story 5. When a
message arrives out of order, `ratchetUntil` stores the application
ratchet secret for each skipped generation in `unusedGenerations`. That
secret derives every later generation. So after one lost or reordered
message, a state compromise recovers every message of the epoch,
including ones already consumed. RFC 9420 section 9.2 allows only the
key and nonce to be kept.

After this ticket:
- For each skipped generation the ratchet derives and stores the
  `{key, nonce}` pair for that generation, never the chain secret. The
  stored nonce is the raw derived nonce, and the reuse guard is applied
  at use, as today.
- Every intermediate chain secret `ratchetUntil` allocates (all except
  its input) is wiped once the next one is derived. The input belongs
  to the caller's tree and is left alone, per the ownership rule in
  AGENTS.md.
- The retained-generation record changes from a map of chain secrets
  to a map of key/nonce pairs. This changes the exported `ClientState`
  type, and the CHANGELOG records it as breaking. The library has no
  state serialization format, so it needs no migration.
- `example-shared/persistence-storage.ts` bumps its IndexedDB version,
  and its upgrade handler discards sessions saved in the old shape
  rather than loading them. Both demos pick this up because the store
  is shared. Update the comment above `openDb`, which currently argues
  against bumping. Check both callers, as `example-shared/AGENTS.md`
  requires.

**Blocked by:** None (can start immediately)

**Touches:** `src/secret-tree.ts` (`ratchetUntil`,
`updateUnusedGenerations`, the consume path that reads
`unusedGenerations`, the wipe of handshake `unusedGenerations`, the
ratchet state type), `example-shared/persistence-storage.ts`
(`openDb`), `test/scenario/generation-out-of-order.ts`,
`test/validation/key-material-retention.ts`, `CHANGELOG.md`

**Status:** done

- [x] Generation 0 of an epoch is lost, and generations 1 to 3 arrive
      in order and are consumed. A test simulating state compromise
      then tries every secret reachable from the member's state, and
      none of them decrypts generations 1 to 3.
- [x] That still holds after two further commits, while the epoch is
      retained as historical receiver data.
- [x] Positive control: a skipped generation delivered late still
      decrypts once, and a second delivery is rejected as a replay.
- [x] The retention limits (`retainKeysForGenerations` of 0, 1 and 2)
      behave as before. A limit of 0 retains nothing.
- [x] The existing out-of-order and retention scenarios pass, and both
      demos typecheck against the new state shape.
