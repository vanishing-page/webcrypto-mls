# Remove Browserify Polyfills Design

## Goal

Remove the `crypto-browserify` and `stream-browserify` development
dependencies from the browser test bundle without changing test behavior.

## Design

The AEAD test only uses Node's `crypto` module for `randomBytes`. Replace that
import with `randomBytes` from `@noble/hashes/utils.js`, which is already a
project dependency and uses `globalThis.crypto.getRandomValues`.

With no Node built-in imports remaining, remove the `crypto` and `stream`
aliases from `build-test.js`. Remove both Browserify packages from
`devDependencies`.

## Verification

- Demonstrate that the current browser entry cannot bundle without aliases.
- Run the browser test suite after the replacement.
- Run the Node test suite after the replacement.
- Run lint and inspect the final dependency graph and diff.
