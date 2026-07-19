# ESLint Type Annotation Spacing Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to
> implement this plan task-by-task.

**Goal:** Configure ESLint to report spaces around TypeScript type annotation
colons as errors.

**Architecture:** Extend the existing TypeScript-specific rules object in the
flat ESLint configuration. Use `@typescript-eslint/type-annotation-spacing`
with `before: false` and `after: false`, leaving all source and test files
unchanged.

**Tech Stack:** ESLint 10, `newneostandard`, TypeScript ESLint flat config.

---

### Task 1: Enforce type annotation spacing

**Files:**
- Modify: `eslint.config.js`
- Test: temporary file under `/tmp`, removed after verification

**Step 1: Add the rule**

Add `@typescript-eslint/type-annotation-spacing` to the existing TypeScript
rules object with this configuration:

```js
'@typescript-eslint/type-annotation-spacing': [
    'error',
    {
        before: false,
        after: false
    }
]
```

**Step 2: Verify the rule rejects spaced annotations**

Create a temporary TypeScript sample containing `value: string` and run:

```bash
npx eslint /tmp/type-annotation-spacing.ts
```

Expected: ESLint exits non-zero and reports
`@typescript-eslint/type-annotation-spacing` errors.

**Step 3: Verify the preferred form**

Change the temporary sample to use `value:string` and run the same command.

Expected: ESLint exits zero for the spacing rule.

**Step 4: Remove the temporary sample and run the project lint**

Run:

```bash
rm /tmp/type-annotation-spacing.ts
npm run lint
```

Expected: the project lint completes successfully without modifying source or
test files.

**Step 5: Review the diff**

Run:

```bash
git diff --check
git status --short
```

Expected: only `eslint.config.js` is modified after the design and plan
commits, with all pre-existing user changes preserved.

**Step 6: Commit**

```bash
git add eslint.config.js
git commit -m "lint: enforce compact type annotations"
```
