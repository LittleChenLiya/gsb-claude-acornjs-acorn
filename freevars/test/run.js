// Tests for the free variable analyzer. Run with: node freevars/test/run.js
//
// Covers the acceptance criteria:
//  - function-local x is not free
//  - obj.x only references obj (member names / object keys are not variables)
//  - destructuring default y counts as a reference
//  - nested closures point back to outer bindings
//  - with / dynamic eval are listed as unknowns, not pretended complete
//  - the four scope examples (function, parameter, block, catch)

import {test} from "node:test"
import assert from "node:assert/strict"
import {readFileSync} from "node:fs"
import {fileURLToPath} from "node:url"
import {dirname, join} from "node:path"

import {analyze} from "../src/index.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const examplesDir = join(__dirname, "..", "examples")

function freeVarsOf(code, fnName) {
  const result = analyze(code, {ecmaVersion: 2022})
  const f = result.functions.find(fn => fn.name === fnName)
  assert.ok(f, "expected a function named " + fnName)
  return f.freeVars.map(v => v.name)
}

function allRefs(code) {
  const result = analyze(code, {ecmaVersion: 2022})
  const names = []
  for (const s of result.scopes) for (const r of s.references) names.push(r.name)
  return names
}

function unknownKinds(code) {
  const result = analyze(code, {ecmaVersion: 2022})
  return result.unknowns.map(u => u.kind)
}

// ---------------------------------------------------------------------------
// Acceptance criteria
// ---------------------------------------------------------------------------

test("function-local x is not free", () => {
  const free = freeVarsOf("function f() { var x = 1; return x; }", "f")
  assert.deepEqual(free, [])
})

test("obj.x only references obj, not the member name", () => {
  const refs = allRefs("var v = obj.x;")
  assert.ok(refs.includes("obj"), "obj must be referenced")
  assert.ok(!refs.includes("x"), "member name x must not be a reference")
})

test("object literal keys are not variables", () => {
  const refs = allRefs("var o = {key: 1, other: 2};")
  assert.ok(!refs.includes("key"), "object key must not be a reference")
  assert.ok(!refs.includes("other"), "object key must not be a reference")
})

test("destructuring default y counts as a reference", () => {
  const free = freeVarsOf("function f({a = y}) { return a; }", "f")
  assert.ok(free.includes("y"), "y in destructuring default is a free reference")
})

test("nested closure points back to outer binding", () => {
  const result = analyze("var x = 1; function f() { return x; }", {ecmaVersion: 2022})
  const f = result.functions.find(fn => fn.name === "f")
  assert.equal(f.freeVars.length, 1)
  assert.equal(f.freeVars[0].name, "x")
  assert.equal(f.freeVars[0].resolution.type, "outer")
})

test("with is listed as unknown and references inside are not pretended resolved", () => {
  const code = "function g(o) { with (o) { return x; } }"
  const result = analyze(code, {ecmaVersion: 2022})
  assert.deepEqual(unknownKinds(code), ["with"])
  const f = result.functions.find(fn => fn.name === "g")
  assert.deepEqual(f.freeVars.map(v => v.name), [], "x inside with must not be claimed as a free var")
  const withScope = result.scopes.find(s => s.type === "with")
  assert.ok(withScope)
  const xRef = result.scopes.flatMap(s => s.references).find(r => r.name === "x")
  assert.ok(xRef, "x reference must be recorded")
  assert.equal(xRef.resolution, "unknown")
})

test("dynamic eval is listed as unknown", () => {
  assert.deepEqual(unknownKinds("function h() { eval('var z = 1'); return z; }"), ["eval"])
})

test("unknowns are listed separately from bindings and references", () => {
  const result = analyze("function h() { eval('var z = 1'); return z; }", {ecmaVersion: 2022})
  assert.ok(Array.isArray(result.unknowns))
  assert.equal(result.unknowns.length, 1)
  assert.equal(result.unknowns[0].kind, "eval")
  assert.ok(result.unknowns[0].loc)
})

// ---------------------------------------------------------------------------
// Scope rules
// ---------------------------------------------------------------------------

test("function self-name is not free", () => {
  const free = freeVarsOf("function f() { return f; }", "f")
  assert.deepEqual(free, [])
})

test("named function expression self-name is bound inside", () => {
  const result = analyze("var g = function f() { return f; };", {ecmaVersion: 2022})
  const f = result.functions[0]
  assert.deepEqual(f.freeVars, [])
})

test("arguments is bound in ordinary functions, free in arrows", () => {
  const result = analyze("function f() { return arguments; } var a = () => arguments;", {ecmaVersion: 2022})
  const f = result.functions.find(fn => fn.name === "f")
  assert.deepEqual(f.freeVars, [])
  const arrow = result.functions.find(fn => fn.name === null)
  assert.ok(arrow.freeVars.some(v => v.name === "arguments"))
})

test("parameter defaults can reference earlier parameters and outer bindings", () => {
  const result = analyze("function f(a = outer, b = a + 1) { return a + b; }", {ecmaVersion: 2022})
  const f = result.functions.find(fn => fn.name === "f")
  assert.ok(f.freeVars.some(v => v.name === "outer"))
  assert.ok(!f.freeVars.some(v => v.name === "a"))
  assert.ok(!f.freeVars.some(v => v.name === "b"))
})

test("block-scoped let/const are not free outside their block", () => {
  const free = freeVarsOf("function f(n) { let out = 0; for (let i = 0; i < n; i++) { const b = i; out += b; } return out; }", "f")
  assert.deepEqual(free, [])
})

test("catch parameter is scoped to the catch body", () => {
  const result = analyze("function f() { try { throw 1; } catch (e) { return e; } }", {ecmaVersion: 2022})
  const f = result.functions.find(fn => fn.name === "f")
  assert.deepEqual(f.freeVars, [])
  const catchScope = result.scopes.find(s => s.type === "catch")
  assert.ok(catchScope.bindings.some(b => b.name === "e" && b.kind === "catch"))
})

test("computed member keys count as references", () => {
  const refs = allRefs("function f() { return obj[k]; }")
  assert.ok(refs.includes("obj"))
  assert.ok(refs.includes("k"))
})

test("computed object literal keys count as references", () => {
  const refs = allRefs("function f() { return {[k]: 1}; }")
  assert.ok(refs.includes("k"))
})

test("shorthand properties in object literals are references", () => {
  const refs = allRefs("function f() { return {a}; }")
  assert.ok(refs.includes("a"))
})

test("assignment targets are references, not bindings", () => {
  const refs = allRefs("function f() { x = 1; return x; }")
  assert.ok(refs.includes("x"))
})

test("destructuring assignment defaults count as references", () => {
  const refs = allRefs("function f() { ({a = y} = obj); return a; }")
  assert.ok(refs.includes("y"))
  assert.ok(refs.includes("obj"))
})

test("rest patterns bind without referencing the rest name", () => {
  const refs = allRefs("function f(...rest) { return rest; }")
  assert.ok(refs.includes("rest"))
})

test("class name is bound in the class scope and resolves from methods", () => {
  const result = analyze("class C { m() { return C; } }", {ecmaVersion: 2022})
  const method = result.functions[0]
  assert.equal(method.freeVars.length, 1)
  assert.equal(method.freeVars[0].name, "C")
  assert.equal(method.freeVars[0].resolution.type, "outer")
  const classScope = result.scopes.find(s => s.type === "class")
  assert.ok(classScope.bindings.some(b => b.name === "C"))
})

test("class field initializers can reference the class name and outer bindings", () => {
  const result = analyze("var outer = 1; class C { x = outer; static y = C; }", {ecmaVersion: 2022})
  const field = result.scopes.find(s => s.type === "field")
  assert.ok(field)
  assert.ok(field.references.some(r => r.name === "outer"))
})

test("bindings and references carry source locations", () => {
  const result = analyze("function f() { var x = 1; return x; }", {ecmaVersion: 2022})
  const xBinding = result.scopes.flatMap(s => s.bindings).find(b => b.name === "x")
  assert.ok(xBinding.loc)
  assert.equal(xBinding.loc.start.line, 1)
  const xRef = result.scopes.flatMap(s => s.references).find(r => r.name === "x")
  assert.ok(xRef.loc)
  assert.equal(xRef.loc.start.line, 1)
})

test("the AST is not mutated", () => {
  const code = "function f() { var x = 1; return x; }"
  const result = analyze(code, {ecmaVersion: 2022})
  assert.ok(result)
  const again = analyze(code, {ecmaVersion: 2022})
  assert.deepEqual(again.functions.map(f => f.freeVars.length), result.functions.map(f => f.freeVars.length))
})

// ---------------------------------------------------------------------------
// Four scope examples
// ---------------------------------------------------------------------------

test("example: function scope - outer bindings are free in the nested closure", () => {
  const code = readFileSync(join(examplesDir, "function-scope.js"), "utf8")
  const result = analyze(code, {ecmaVersion: 2022})
  const inner = result.functions.find(fn => fn.name === "inner")
  const names = inner.freeVars.map(v => v.name)
  assert.ok(names.includes("localVar"))
  assert.ok(names.includes("x"))
  const outer = result.functions.find(fn => fn.name === "outer")
  assert.deepEqual(outer.freeVars, [])
})

test("example: parameter scope - default references outer, arguments bound", () => {
  const code = readFileSync(join(examplesDir, "parameter-scope.js"), "utf8")
  const result = analyze(code, {ecmaVersion: 2022})
  const f = result.functions.find(fn => fn.name === "f")
  assert.ok(f.freeVars.some(v => v.name === "outer"))
  assert.ok(!f.freeVars.some(v => v.name === "arguments"))
  const arrow = result.functions.find(fn => fn.name === null)
  assert.ok(arrow.freeVars.some(v => v.name === "arguments"))
})

test("example: block scope - let/const stay inside their blocks", () => {
  const code = readFileSync(join(examplesDir, "block-scope.js"), "utf8")
  const result = analyze(code, {ecmaVersion: 2022})
  const f = result.functions.find(fn => fn.name === "f")
  assert.deepEqual(f.freeVars, [])
})

test("example: catch scope - catch parameter stays in the catch body", () => {
  const code = readFileSync(join(examplesDir, "catch-scope.js"), "utf8")
  const result = analyze(code, {ecmaVersion: 2022, globals: {Error: true}})
  const f = result.functions.find(fn => fn.name === "f")
  assert.deepEqual(f.freeVars, [])
  const catchScope = result.scopes.find(s => s.type === "catch")
  assert.ok(catchScope.bindings.some(b => b.name === "e"))
})

test("example: unknowns - with and eval listed separately", () => {
  const code = readFileSync(join(examplesDir, "unknown-eval-with.js"), "utf8")
  const result = analyze(code, {ecmaVersion: 2022})
  const kinds = result.unknowns.map(u => u.kind).sort()
  assert.deepEqual(kinds, ["eval", "with"])
})

