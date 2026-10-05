// Focused acceptance tests for bin/insert-use-strict.mjs.
// Run directly:  node test/insert-use-strict.mjs

import assert from "node:assert/strict"
import {execFileSync} from "node:child_process"
import {writeFileSync, unlinkSync} from "node:fs"
import {fileURLToPath} from "node:url"
import path from "node:path"
import {parse} from "../acorn/src/index.js"
import {insertUseStrict, planUseStrictInsertion} from "../bin/insert-use-strict.mjs"

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

let passed = 0
function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    console.error(error)
    process.exitCode = 1
  }
}

function reparses(code, options = {}) {
  parse(code, Object.assign({ecmaVersion: "latest", allowHashBang: true}, options))
}

// --- 1. Plain function scopes get the directive and still parse ----------

test("plain function: directive inserted into function body, result parses", () => {
  const code = "function f(a) {\n  return a\n}\n"
  const result = insertUseStrict(code, {select: [0]})
  assert.equal(result.ok, true)
  assert.equal(result.code, "function f(a) {\n  \"use strict\";\n  return a\n}\n")
  reparses(result.code)
  assert.equal(result.insertions.length, 1)
  assert.equal(result.insertions[0].scope.type, "FunctionDeclaration")
  assert.equal(result.insertions[0].scope.name, "f")
})

test("script scope: directive inserted at program level, result parses", () => {
  const code = "var x = 1\nfunction f() { return x }\n"
  const result = insertUseStrict(code)
  assert.equal(result.ok, true)
  assert.ok(result.code.startsWith("\"use strict\";\n"))
  reparses(result.code)
  // The function inherits strictness from the program: no duplicate insert.
  assert.equal(result.insertions.length, 1)
  assert.equal(result.insertions[0].scope.type, "Program")
})

test("function expression is a plain function scope", () => {
  const code = "var f = function(a) { return a }\n"
  const result = insertUseStrict(code, {select: [code.indexOf("function")]})
  assert.equal(result.ok, true)
  assert.ok(result.code.includes("function(a) {\n  \"use strict\";"))
  reparses(result.code)
})

// --- 2. Rejections --------------------------------------------------------

test("duplicate parameters f(a, a) are rejected", () => {
  const result = insertUseStrict("function f(a, a) {}\n", {select: [0]})
  assert.equal(result.ok, false)
  assert.equal(result.code, undefined) // no partial rewrite
  assert.ok(result.errors.some(e => /duplicate parameter/.test(e.message)))
})

test("duplicate parameters are also rejected via program-level re-parse", () => {
  const result = insertUseStrict("function f(a, a) {}\n")
  assert.equal(result.ok, false)
  assert.equal(result.code, undefined)
})

test("non-simple parameters (default) are rejected", () => {
  const result = insertUseStrict("function f(a = 1) {}\n", {select: [0]})
  assert.equal(result.ok, false)
  assert.equal(result.code, undefined)
  assert.ok(result.errors.some(e => /non-simple parameter/.test(e.message)))
})

test("non-simple parameters (destructuring, rest) are rejected", () => {
  for (const src of ["function f({a}) {}\n", "function f(...a) {}\n"]) {
    const result = insertUseStrict(src, {select: [0]})
    assert.equal(result.ok, false, src)
    assert.equal(result.code, undefined)
  }
})

test("re-parse rejection: 'with' cannot become strict, nothing returned", () => {
  const result = insertUseStrict("function f() { with (Math) {} }\n")
  assert.equal(result.ok, false)
  assert.equal(result.code, undefined)
  assert.ok(result.errors.some(e => /re-parse/.test(e.message)))
})

test("atomicity: one bad scope rejects the whole rewrite", () => {
  const code = "function good(a) { return a }\nfunction bad(a, a) {}\n"
  const result = insertUseStrict(code, {select: [0, code.indexOf("function bad")]})
  assert.equal(result.ok, false)
  assert.equal(result.code, undefined)
})

// --- 3. Comments, shebang, existing directives ----------------------------

test("comment text mentioning \"use strict\" is not treated as a directive", () => {
  const code = "// \"use strict\" in a comment\n/* use strict */\nfunction f() {}\n"
  const result = insertUseStrict(code)
  assert.equal(result.ok, true)
  assert.ok(result.code.startsWith("\"use strict\";\n// \"use strict\""))
  reparses(result.code)
})

test("shebang is preserved and the directive goes on the next line", () => {
  const code = "#!/usr/bin/env node\nvar x = 1\n"
  const result = insertUseStrict(code)
  assert.equal(result.ok, true)
  assert.equal(result.code, "#!/usr/bin/env node\n\"use strict\";\nvar x = 1\n")
  reparses(result.code)
  assert.equal(result.insertions[0].offset, 20) // offset in the *original* source
})

test("existing \"use strict\" directive is not duplicated", () => {
  const code = "\"use strict\";\nfunction f() {}\n"
  const result = insertUseStrict(code)
  assert.equal(result.ok, true)
  assert.equal(result.code, code)
  assert.equal(result.insertions.length, 0)
  assert.ok(result.skipped.some(s => s.type === "Program"))
})

test("existing other directives are preserved", () => {
  const code = "\"use asm\";\nfunction f() { return 1 }\n"
  const result = insertUseStrict(code)
  assert.equal(result.ok, true)
  assert.ok(result.code.startsWith("\"use strict\";\n\"use asm\";"))
  reparses(result.code)
})

test("function with its own directive is left alone", () => {
  const code = "function f() {\n  \"use strict\";\n}\n"
  const result = insertUseStrict(code, {select: [0]})
  assert.equal(result.ok, true)
  assert.equal(result.insertions.length, 0)
  assert.equal(result.code, code)
})

// --- 4. Modules and classes are already strict ----------------------------

test("modules are never rewritten", () => {
  const code = "export function f() {}\n"
  const result = insertUseStrict(code, {sourceType: "module"})
  assert.equal(result.ok, true)
  assert.equal(result.code, code)
  assert.equal(result.insertions.length, 0)
  assert.ok(result.skipped.some(s => /modules are always strict/.test(s.reason)))
})

test("class bodies are never rewritten", () => {
  const code = "class A {\n  m() { return 1 }\n  static s() {}\n}\n"
  const result = insertUseStrict(code)
  assert.equal(result.ok, true)
  assert.equal(result.insertions.length, 1) // Program only
  assert.equal(result.insertions[0].scope.type, "Program")
  assert.ok(!result.code.includes("m() {\n  \"use strict\";"))
  assert.ok(result.skipped.some(s => /class bodies are always strict/.test(s.reason)))
  reparses(result.code)
})

test("plain function containing a class: function gets the directive, class untouched", () => {
  const code = "function f() {\n  class A { m() {} }\n  return A\n}\n"
  const result = insertUseStrict(code, {select: [0]})
  assert.equal(result.ok, true)
  assert.ok(result.code.includes("function f() {\n  \"use strict\";"))
  assert.ok(!result.code.includes("m() {\n    \"use strict\";"))
  reparses(result.code)
  // The class methods must not be reported as affected (already strict).
  assert.ok(!result.affectedScopes.some(s => s.name === "m"))
})

// --- 5. Selection ---------------------------------------------------------

test("only selected scopes are processed", () => {
  const code = "function a() {}\nfunction b() {}\n"
  const result = insertUseStrict(code, {select: [code.indexOf("function b")]})
  assert.equal(result.ok, true)
  assert.equal(result.insertions.length, 1)
  assert.equal(result.insertions[0].scope.name, "b")
  assert.ok(result.code.includes("function b() {\n  \"use strict\";"))
  assert.ok(result.code.includes("function a() {}"))
  reparses(result.code)
})

test("selecting the program only", () => {
  const code = "function a() {}\n"
  const result = insertUseStrict(code, {select: ["program"]})
  assert.equal(result.ok, true)
  assert.equal(result.insertions.length, 1)
  assert.equal(result.insertions[0].scope.type, "Program")
})

// --- 6. Positions map back to the original source -------------------------

test("insertion offsets and scope ranges refer to the original source", () => {
  const code = "function a(x) { return x }\nfunction b(y) { return y }\n"
  const plan = planUseStrictInsertion(code, {select: [0, code.indexOf("function b")]})
  assert.equal(plan.ok, true)
  assert.equal(plan.insertions.length, 2)
  for (const {offset, text, scope} of plan.insertions) {
    // Scope ranges slice the original source exactly.
    assert.ok(code.slice(scope.start, scope.start + 8) === "function")
    assert.ok(code.slice(scope.start, scope.end).endsWith("}"))
    // The insertion offset is right after the function's opening brace.
    assert.equal(code[offset - 1], "{")
    assert.ok(text.includes("\"use strict\";"))
  }
  // Applying insertions at the reported original offsets (right to left)
  // reproduces insertUseStrict's output.
  let manual = code
  for (const {offset, text} of plan.insertions.slice().sort((p, q) => q.offset - p.offset))
    manual = manual.slice(0, offset) + text + manual.slice(offset)
  assert.equal(manual, insertUseStrict(code, {select: [0, code.indexOf("function b")]}).code)
})

// --- 7. Affected sub-scopes are reported together -------------------------

test("affected sub-scopes are reported with the insertion", () => {
  const code = "function outer() {\n  function inner() {\n    const arrow = () => 1\n    return arrow()\n  }\n  return inner()\n}\n"
  const result = insertUseStrict(code, {select: [0]})
  assert.equal(result.ok, true)
  const names = result.affectedScopes.map(s => `${s.via}:${s.type}:${s.name}`)
  assert.deepEqual(names, [
    "direct:FunctionDeclaration:outer",
    "inherited:FunctionDeclaration:inner",
    "inherited:ArrowFunctionExpression:null"
  ])
  reparses(result.code)
})

// --- 8. CLI ----------------------------------------------------------------

const cli = path.join(root, "bin", "insert-use-strict.mjs")
const example = path.join(root, "examples", "three-functions.js")

test("CLI rewrites the three-function example", () => {
  const out = execFileSync(process.execPath, [cli, example], {encoding: "utf8"})
  assert.ok(out.startsWith("\"use strict\";\n"))
  reparses(out)
})

test("CLI --plan reports insertions and affected scopes as JSON", () => {
  const out = execFileSync(process.execPath, [cli, "--plan", example], {encoding: "utf8"})
  const plan = JSON.parse(out)
  assert.equal(plan.ok, true)
  assert.equal(plan.insertions.length, 1)
  const names = plan.affectedScopes.map(s => s.name)
  assert.deepEqual(names, [null, "alpha", "beta", "gamma", "delta"])
})

test("CLI exits non-zero and prints no code on rejection", () => {
  const bad = path.join(root, "test", "tmp-bad-fixture.js")
  writeFileSync(bad, "function f(a, a) {}\n")
  let failed = null
  try {
    execFileSync(process.execPath, [cli, "--select", "0", bad], {encoding: "utf8", stdio: "pipe"})
  } catch (error) {
    failed = error
  } finally {
    unlinkSync(bad)
  }
  assert.ok(failed, "expected the CLI to fail")
  assert.equal(failed.status, 1)
  assert.equal(failed.stdout, "")
  assert.ok(/duplicate parameter/.test(failed.stderr))
})

console.log(`\n${passed} tests passed`)
