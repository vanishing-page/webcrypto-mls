# Substrate form controls in the realistic demo

Replace the realistic demo's native form controls with
`@substrate-system/input`, `@substrate-system/button` and
`@substrate-system/check-box`, styled by the default CSS those packages
expose.

All three are already in `devDependencies`. Nothing is installed by this
work.

## Why

The demo hand-styles `button`, `input` and `input[type="checkbox"]` in
`example-realistic-demo/client/style.css`. Those rules are a private
copy of control behaviour -- focus rings, disabled states, hover
transitions -- that the packages already ship and maintain. Adopting the
components moves that behaviour out of the demo, and adopting their
default CSS is what keeps it out: a re-skin would put the same rules
back under different selectors.

The consequence is visible and intended. Buttons go from filled accent
uppercase to transparent with a hairline border, and the demo's controls
stop matching the uppercase label register used elsewhere on the page.

## Scope

Twelve controls across five files in `example-realistic-demo`, plus one
in `example-shared`:

| File | Control |
|------|---------|
| `client/views/setup.ts` | name field, submit button |
| `client/views/room-link.ts` | readonly URL field, copy button |
| `client/views/room.ts` | approve, deny, remove, composer field, send |
| `client/views/persistence.ts` | persist checkbox, reset button |
| `client/views/gone.ts` | create-new button |
| `example-shared/storage-panel.ts` | request-persistence button |

`storage-panel.ts` is shared: `example/persistence-demo.ts` and
`example/multi-device-demo.ts` render it too. Converting it reaches into
those pages, and that is accepted rather than worked around -- see
Registration below for what it obliges.

Out of scope: `example/`'s own controls, and `example/style.css`. Its
existing `button` rules go on styling the inner `<button>` that
`substrate-button` renders, so those pages keep their present look.

## Registration

`@substrate-system/web-component/util` binds `document.querySelector` at
module top level, and `CheckBox extends HTMLElement`. Both throw under
Node.

The node suite imports the view modules directly --
`test/example-realistic-demo/views.ts` pulls in `setup.js`, `room.js`,
`persistence.js` and `storage-panel.js` and calls them as plain
functions. So the registration imports must not live in any module the
suite reaches. They live in the two browser entries, neither of which
the suite imports:

- `example-realistic-demo/client/index.ts` -- all three packages
- `example/index.ts` -- `@substrate-system/button` only

The second is obligatory, not tidiness. An undefined custom element does
not render: without the import, `<substrate-button>` on the two
`example/` pages would leave its label as inert inline text and the
button would be gone.

Each package calls `customElements.define` on import, so a side-effect
import is the whole of it. No `.define()` call.

This costs the tests nothing. `htm` builds a vnode whose type is the
string `'substrate-button'` whether or not the element is registered.

## CSS

Three imports beside the existing normalize import in
`client/style.css`:

```css
@import url("@substrate-system/button/css");
@import url("@substrate-system/check-box/css");
@import url("@substrate-system/input/css");
```

### Deleted

The package sheets and the demo's own rules describe the same controls
differently, and `substrate-button button` outspecifies a bare `button`,
so leaving both in place yields neither design. These go:

| Lines | Rule |
|-------|------|
| 204-231 | `button` -- filled accent, uppercase, square |
| 234-247 | `.deny, .remove, .reset, .request-persist-btn` |
| 249-263 | `input[type="text"], input:not([type])` |
| 265-269 | `input[type="checkbox"]` |
| 271-273 | `input:focus-visible` |
| 275-285 | `label` |

The `label` rule goes because after the conversion the demo has no bare
`<label>` of its own left. `substrate-input` renders
`label.label-content` and `check-box` renders `label.checkbox-label`,
both inside the component, both styled by the package sheets.

### Retargeted

Layout survives; it is the demo's, not the packages'. The selectors move
to the new tags:

- `.setup .setup-form input` -> `substrate-input`, dropping
  `font-size: 1.375rem` and the `label { flex-basis: 100% }` rule
- `.composer .draft` -> the `substrate-input` host, dropping its
  `label` rule for the same reason
- `.room-link .room-url` -> the `substrate-input` host for `flex` and
  `min-width`; border and background now come from the package
- `.pending .request button` -> `substrate-button`
- `.persistence .persist-toggle` -> `check-box.persist-toggle`, keeping
  only `margin-bottom`; the component supplies the label layout
- `.members .member .remove` needs no change. `substrate-button` keeps
  the class on the host element, so `grid-column: 4` still lands.

### Kept deliberately

`.room-url` stays monospaced, moved from the machine-values group at
lines 149-160 to `substrate-input.room-url input` -- an input does not
inherit the host's font. "A machine value is set in mono" is the demo's
rule about content, not a control skin, and the same rule governs
`.seq`, `.epoch` and `.status`, which are untouched.

## The conversions

Preact drives all three components through real property setters --
`value` on `substrate-input`, `checked` on `check-box`, `disabled` and
`type` on `substrate-button` -- and each setter syncs the host attribute
and the inner element. Native events bubble from the inner element to
the host, so `onInput`, `onChange` and `onClick` on the host work
unchanged.

Children are diffed in before `connectedCallback`, so
`substrate-button` moving its label into the inner `<button>` happens
after Preact has placed it. Labels that change (`Creating...` /
`Create room`) still update, because Preact mutates the text node it
already holds a reference to and that node is the one that moved.

Most sites are a tag swap that keeps the existing class, `type` and
`aria-label`. Three change shape:

- `setup.ts` and `room.ts`'s composer drop their `<label for>` in
  favour of `label="Your name"` and `label="Say something"`. The
  component generates the `for`/`id` pair.
- `persistence.ts`'s `<label class="persist-toggle">` wrapper collapses
  into `<check-box class="persist-toggle">`, with the sentence as text
  content. `check-box` reads `textContent` once at connect; the
  sentence is static, so once is enough.

## Tests

`test/example-realistic-demo/views.ts` asserts on vnode types. Roughly a
dozen sites move:

- `findByType(tree, 'input')` -> `'substrate-input'`
- `findByType(tree, 'button')` -> `'substrate-button'`
- the checkbox lookup, currently `findByType(...)` filtered on
  `props.type === 'checkbox'`, becomes `findByType(off, 'check-box')`

`findByClass` lookups -- `copy`, `reset`, `draft` -- are unaffected. The
classes stay on the host.

The two tests that assert a `<label>`'s `for` matches its input's `id`
become an assertion that the field carries a non-empty `label` prop:
that it is labelled, not what the label says.

`test/example/storage-panel.ts` needs no change. It exercises
`persistOutcome` and `PERSIST_MESSAGES`, never the component.

## Verification

1. `npm run lint`
2. `npm run test:node`
3. `npm run build:realistic`

The build is the load-bearing one. It is what proves vite and
lightningcss resolve the `@substrate-system/input/css` subpath export
from a CSS `@import`. The existing `css-normalize` import only proves
the bare-package form works. If the subpath does not resolve, the
fallback is to import the three sheets from
`client/index.ts` instead, which is the form the packages document.
