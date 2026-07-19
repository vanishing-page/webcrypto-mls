# Remove Browserify Polyfills Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to
> implement this plan task-by-task.

**Goal:** Remove the Browserify crypto and stream polyfills from the browser
test build while preserving test behavior.

**Architecture:** Use the existing `@noble/hashes` random-byte helper in the
only test that imports Node crypto. Once no Node built-ins enter the browser
bundle, remove the esbuild aliases and their development dependencies.

**Tech Stack:** TypeScript, esbuild, Web Crypto, `@noble/hashes`, tapzero.

---

### Task 1: Prove the browser entry needs the current aliases

**Files:**

- Test: `test/index.ts`
- Inspect: `test/crypto/aead.ts`

**Step 1: Bundle the current browser entry without aliases**

Run an in-memory esbuild build using the existing browser configuration but
omit the `alias` option.

Expected: the build fails because `test/crypto/aead.ts` imports `crypto`.

### Task 2: Replace the Node random-byte import

**Files:**

- Modify: `test/crypto/aead.ts`
- Modify: `build-test.js`
- Modify: `package.json`

**Step 1: Use the existing cross-platform helper**

Replace the Node crypto import with:

```ts
import { randomBytes } from '@noble/hashes/utils.js'
```

**Step 2: Remove the aliases**

Delete the `crypto` and `stream` alias configuration and its obsolete comment
from `build-test.js`.

**Step 3: Remove the dependencies**

Remove `crypto-browserify` and `stream-browserify` from `devDependencies` in
`package.json`.

### Task 3: Verify and commit the cleanup

**Files:**

- Verify: `test/crypto/aead.ts`
- Verify: `build-test.js`
- Verify: `package.json`

**Step 1: Run browser tests**

Run:

```bash
npm run test:browser
```

Expected: the browser suite passes.

**Step 2: Run Node tests**

Run:

```bash
npm run test:node
```

Expected: all Node assertions pass.

**Step 3: Run lint and review**

Run:

```bash
npm run lint
npm ls crypto-browserify stream-browserify --depth=0
git diff --check
git status --short
```

Expected: lint passes, neither Browserify package is a direct dependency, and
the diff contains only the planned files.

**Step 4: Commit**

```bash
git add test/crypto/aead.ts build-test.js package.json
git commit -m "test: remove browserify crypto polyfills"
```
