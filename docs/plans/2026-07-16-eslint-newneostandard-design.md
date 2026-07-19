# ESLint newneostandard Migration Design

## Goal

Move the project from legacy ESLint configuration to contemporary flat
configuration using `newneostandard`, without changing the existing lint
scope, ignored paths, or explicit rule settings.

## Current behavior to preserve

- The `lint` script checks `./**/*.{ts,js}`.
- `lib.es5.d.ts` is ignored by ESLint.
- `dist/*`, `public/*`, and `test/*.js` remain ignored.
- TypeScript uses the `@typescript-eslint` recommended rules.
- Explicit rule overrides and their options remain unchanged:
  - `no-explicit-any` is disabled.
  - Unused arguments, variables, and caught errors beginning with `_` are
    allowed.
  - `operator-linebreak` and `multiline-ternary` are disabled.
  - Type-only imports are required.
  - At most one empty line is allowed, including at end of file.
  - Indentation remains four spaces with the existing switch and template
    literal exceptions.
  - Trailing comma enforcement is disabled.
  - Multiple spaces remain errors except for end-of-line comments.

## Design

Create `eslint.config.js` as an ECMAScript module. It will call
`newneostandard` with TypeScript support enabled and pass the existing ignore
patterns through its flat-config `ignores` option. The explicit project rules
will be applied in a following flat-config object, preserving their current
values and options.

Remove `.eslintrc` and `.eslintignore`, since those legacy files are not used
by flat config. Keep the existing `lint` script unchanged so its file glob is
preserved exactly.

The package dependencies will retain `newneostandard` and ESLint's contemporary
runtime dependencies while removing legacy-only configuration packages that
are no longer referenced directly.

## Verification

- Run `npm run lint` and require a successful exit.
- Run ESLint against an ignored declaration and ignored JavaScript file to
  confirm they remain excluded.
- Inspect the final diff to ensure unrelated working-tree changes are not
  modified.
