# ESLint Type Annotation Spacing Design

## Goal

Make spaces around TypeScript type annotation colons an ESLint error. The
project's preferred form is `value:Type`, with no space before or after the
colon.

## Design

Add `@typescript-eslint/type-annotation-spacing` to the existing TypeScript
rules block in `eslint.config.js` with both `before` and `after` set to
`false`. This keeps the rule scoped to TypeScript and uses the standard
TypeScript ESLint rule for the requested style.

No source or test files will be reformatted or otherwise changed.

## Verification

- Run ESLint on a temporary sample containing spaced type annotations and
  confirm it reports errors.
- Remove the temporary sample and run `npm run lint`.
- Confirm the final diff contains only the ESLint configuration change plus
  this design record, without altering existing working-tree edits.
