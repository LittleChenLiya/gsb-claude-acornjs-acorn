# acorn-rename-binding

Explicit **lexical binding renaming** built on top of the in-repo
[Acorn](../../acorn) parser (`ecmaVersion: "latest"`).

Given a binding name and a new name, the tool:

1. builds the full lexical scope tree and registers every declaration,
2. lists every *genuine reference* (member property names and labels are not
   references),
3. checks that the new name neither **captures an originally free variable /
   outer binding** nor gets **shadowed by an inner same-named variable**,
4. rewrites the source, and
5. **reparses the result** and verifies that the new binding exists in the
   matching scope with the same occurrence count, all occurrences resolve to
   it, and the free-variable multiset is unchanged.

The input string is never mutated. If any check fails the tool throws and the
caller keeps the original source.

## Run (local Node command, no install/build step)

From the repository root, with any Node.js that supports ESM (tested with
Node 22/24):

```sh
# print rewritten source to stdout
node tools/rename-binding/cli.js --old x --new p path/to/file.js

# ESM input
node tools/rename-binding/cli.js --old x --new p --module path/to/file.mjs

# disambiguate shadowed names by a byte offset on the target binding
node tools/rename-binding/cli.js --old x --new p --at 12 file.js

# list the declaration sites and genuine references, then exit
node tools/rename-binding/cli.js --list --old x file.js

# rewrite the file in place (only happens after every check succeeds)
node tools/rename-binding/cli.js --old x --new p --write file.js
```

Run the test suite (deterministic, uses the built-in `node:test` runner):

```sh
npm run test:rename-binding
# or
node --test tools/rename-binding/test/
```

## Scope examples

Three small files live in [`examples/`](examples):

| file | demonstrates | command |
| --- | --- | --- |
| `examples/1-param-shorthand.js` | parameter rename, `{x}` → `{x: p}`, `z.x` untouched | `node tools/rename-binding/cli.js --old x --new p examples/1-param-shorthand.js` |
| `examples/2-free-capture.js` | free `p` in the region → rename refused | same command on the file; exit code 1 |
| `examples/3-inner-shadow.js` | inner same-named binding would shadow → refused | same command on the file; exit code 1 |

Acceptance example (`x` → `p`):

```js
// before
function f(x) { return {x}; }
z.x
// after
function f(p) { return {x: p}; }
z.x
```

If the body referred to a free `p` (`function f(x){ p + x }`) the rename is
rejected: after renaming, that `p` would resolve to the new parameter instead
of remaining free.

## Supported rename targets

* local declarations: `var`, `let`, `const`, `using`, `await using`,
  function and class declarations, including destructuring declarations;
* function parameters, including parameter patterns
  (`function f({a, [b]: c})`, defaults, rest);
* catch clause parameters;
* named function/class expression self-names;
* **explicit import aliases only**:
  * `import x from "m"` and `import x, {...} from "m"` (default local name),
  * `import * as ns from "m"` (namespace local name),
  * `import {a as b} from "m"` — the local alias `b` is renamed while the
    external name `a` is preserved.

## Refused

* any `with` statement in the file;
* any **direct** `eval(...)` call in the file (indirect `(0,eval)(...)` is
  allowed);
* bindings introduced or re-exported by a **direct export declaration**
  (`export let x`, `export function f`, `export {x}`, named default
  declarations, …) — rename the plain local declaration instead;
* plain named imports `import {x} from "m"` where one token is both the
  external and the local name — add an explicit alias first
  (`import {x as p} from "m"`);
* new names that are not valid identifiers for the source type, or that
  contain escape sequences;
* renames that cause a same-scope clash, inner shadowing, or capture.

## Shorthand semantics and reflection

Object literals and binding/assignment patterns use the same token for the
property key and the local name. Renaming the local name **keeps the external
key**:

```js
function f(x) { return {x} }   // -> function f(p) { return {x: p} }
function g({x}) { return x }   // -> function g({x: p}) { return p }
var {x} = o                    // -> var {x: p} = o
({x} = o)                      // -> ({x: p} = o)
```

Non-computed member access (`z.x`, `z?.x`) is a property name and is never a
reference; computed access (`z[x]`) is a reference and is rewritten.

Reflection-visible names are **not promised** to stay stable: e.g. a renamed
named function changes its `.name`-observable identity. The tool only
guarantees the static lexical semantics listed here.

## Escaped identifiers

Identifier ranges reported by Acorn span the whole token, including Unicode
escape sequences, so `\u0078` is replaced in its entirety:

```js
function f(\u0078) { var y = \u0078; ({\u0078}); }
// ->
function f(p) { var y = p; ({x: p}); }
```

The new name itself must be written literally (escapes are rejected) to keep
the intended name unambiguous.

## Library API

```js
import {renameBinding, listReferences, analyze, RenameError}
  from "./tools/rename-binding/index.js"

renameBinding(code, "x", "p", {sourceType: "script", atOffset: 12})
// -> { code, binding, references, changed, edits }

listReferences(code, "x", {sourceType: "module"})
// -> { binding, declarations: [{start, end, text}],
//      references:   [{start, end, text, shorthand}] }
```

`atOffset` selects one binding when the same name exists in nested scopes; it
may point at a declaration or a reference.
