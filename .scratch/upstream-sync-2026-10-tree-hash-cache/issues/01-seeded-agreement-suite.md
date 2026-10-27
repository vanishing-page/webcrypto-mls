# 01: Seeded multi-member agreement suite

**What to build:** the safety net for the rest of this spec, landed
before any cache exists so that it passes on today's code. A seeded
random sequence of Adds, Removes, Updates, path commits and external
joins runs over a group of a few dozen members. After every epoch,
every member's epoch authenticator agrees, and every member can
decrypt an application message from every other member.

The suite also covers the two cases a cache is most likely to break:

- **Cold against warm.** Partway through the sequence, one member's
  state is structured-cloned with `clientConfig` re-attached, the
  way the README's Persistence section does it. The clone and the
  original then process the same commits and have to reach the same
  epoch authenticator at every epoch.
- **Width changes.** The sequence is steered to include at least one
  Add that extends the tree and at least one Remove that truncates
  it. Each is followed by another commit, and all members still
  agree afterwards.

The seed is fixed by default, can be overridden for a local run, and
is printed whenever an assertion fails. Keep every printed line clear
of the tokens tapout reads as failure (`Failed`, `FAIL`, `Error:`).
Each step that takes longer than three seconds reports progress, or
the browser run will be treated as truncated (see AGENTS.md, Tests).

Loop over `sampleCiphersuites()`, pass `testClientConfig` to every
group, and import the file from `test/matrix.ts`. No assertion
inspects tree hashes or timing. This ticket does not change `src/`.

**Blocked by:** None (can start immediately)

**Touches:** a new `test/scenario/` suite, `test/matrix.ts`. Prior
art: `test/scenario/large-group-full-lifecycle.ts`,
`test/scenario/multiple-joins-at-once.ts`,
`test/scenario/external-join.ts`,
`test/helpers/suite-filter.ts` (`sampleCiphersuites`),
`test/helpers/client-config.ts` (`testClientConfig`), the README's
Persistence section.

**Status:** done

- [x] Under a fixed seed, every member reaches the same epoch
      authenticator at every epoch of a random sequence that mixes
      Adds, Removes, Updates, path commits and external joins over a
      few dozen members.
- [x] After every epoch, every member decrypts an application message
      from every other member.
- [x] A structured clone of one member, taken partway through,
      reaches the same epoch authenticator as the original at every
      later epoch.
- [x] A commit that extends the tree and a Remove that truncates it,
      each followed by a commit, leave all members in agreement.
- [x] A failing assertion prints the seed that reproduces it.
- [x] `npm run typecheck`, the Worker typecheck,
      `npm run test:checks`, `npm run check:style`, `npm test` and
      `npm run test:browser` pass.
