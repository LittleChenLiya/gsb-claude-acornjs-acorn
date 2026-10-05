# acorn-free-vars

Free variable analysis for JavaScript, built on top of [Acorn](../acorn).

It resolves identifier references against the real binding structure of the
program and reports, for every scope, which names are bound, where they are
bound, and where they are referenced.

## Scope model

Bindings are resolved per the language rules:

- **function scope** — `var`, function declarations, the function's own name
  (for recursion) and the implicit `arguments` binding (except in arrow
  functions).
- **parameter scope** — formal parameters; default values can reference outer
  bindings and earlier parameters.
- **block scope** — `let`/`const` bindings in blocks, `for`/`for-in`/`for-of`
  iteration scopes, and `switch` blocks.
- **catch scope** — the catch parameter, bound only inside the catch body.
- **class scope** — the class name, visible in methods and field initializers.
- **global / module scope** — the top level.

Member property names (`obj.x`) and object literal keys (`{x: 1}`) are never
treated as variables. References in destructuring defaults (`{a = y}`) and
computed keys (`obj[k]`, `{[k]: v}`) are counted. Assignment targets are
references, not bindings.

## Unknowns

`with` statements and direct calls to a globally visible `eval` are reported
as **unknowns**. Their effect on binding resolution cannot be decided
statically, so the analysis does not pretend to be complete: references inside
a `with` body are marked `unknown` instead of being claimed as free variables.

## Usage

```sh
# Human-readable report
node freevars/bin/freevars.js file.js

# Machine-readable JSON
node freevars/bin/freevars.js --json file.js

# Module source type and predefined globals (not flagged as free)
node freevars/bin/freevars.js --module --globals console,JSON file.mjs
```

The JSON report contains `scopes` (bindings and references with source
locations), `functions` (per-function free variables), `topGlobals` and
`unknowns`.

## Programmatic API

```js
import {analyze, analyzeAst} from "./freevars/src/index.js"

const result = analyze("function f(x) { return x + y; }", {ecmaVersion: 2022})
// result.functions[0].freeVars -> [{name: "y", ...}]
```

`analyzeAst(ast, options)` runs the same analysis on an existing Acorn AST.
The AST is never mutated and no code is executed.

## Examples

The `examples/` directory contains one fixture per scope:

- `function-scope.js` — function-local bindings and nested closures
- `parameter-scope.js` — parameter defaults and `arguments`
- `block-scope.js` — `let`/`const` blocks and `for` loops
- `catch-scope.js` — catch parameters
- `unknown-eval-with.js` — `with` and dynamic `eval` unknowns

## Tests

```sh
node freevars/test/run.js
```