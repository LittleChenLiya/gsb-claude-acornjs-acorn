// Deterministic acceptance tests for the free-variable analyzer.
// Run with: node free-variables/test/run.js  (no dependencies, no network)

import assert from "node:assert/strict"
import {analyze, analyzeWithAst} from "../src/index.js"

let passed = 0
const failures = []
function test(name, fn) {
  try { fn(); passed++ }
  catch (e) { failures.push([name, e]) }
}

const free = (code, opts) => analyze(code, opts).freeVariables.map(f => f.name)
const freeNames = r => r.freeVariables.map(f => f.name)

const EXAMPLE = `
var top = "x"
function make(a, b = outer) {
  const local = a + b
  { let inner = local + helper(); return inner }
  function helper() {
    try { return maybeGlobal + top }
    catch (err) { return err + a + local }
  }
}
`

test("local x in function is not free", () => {
  const r = analyze(`function f() { var x = 1; return x; }`)
  assert.deepEqual(freeNames(r), [])
  const xb = r.bindings.find(b => b.name === "x" && b.kind === "var")
  assert.ok(xb, "x binding exists")
  assert.equal(xb.scope.kind, "function")
  assert.equal(xb.references.length, 1)
})

test("member access only references the object", () => {
  assert.deepEqual(free(`obj.x.y`), ["obj"])
})

test("bracket member with literal key only references object", () => {
  assert.deepEqual(free(`obj["x"].y`), ["obj"])
})

test("computed member key is a reference", () => {
  assert.deepEqual(free(`obj[k]`), ["obj", "k"])
})

test("literal object keys are not references, computed keys are", () => {
  const r = analyze(`var o = {x: 1, [k]: 2, y: obj}`)
  assert.deepEqual(freeNames(r), ["k", "obj"])
})

test("shorthand property references the variable", () => {
  assert.deepEqual(free(`f({x})`), ["f", "x"])
})

test("destructuring default value is a reference", () => {
  assert.deepEqual(free(`var {a = y} = z`), ["y", "z"])
  assert.deepEqual(free(`var [a = y] = z`), ["y", "z"])
})

test("destructured bindings not free; computed key in pattern counts", () => {
  const r = analyze(`var {[k]: a = d, ...rest} = src; use(a, rest)`)
  assert.deepEqual(freeNames(r), ["k", "d", "src", "use"])
})

test("parameter default references outer binding", () => {
  const r = analyze(`var outer = 1; function f(a = outer) { return a }`)
  assert.deepEqual(freeNames(r), [])
  const ref = r.references.find(x => x.name === "outer")
  assert.equal(ref.resolved.kind, "var")
  assert.equal(ref.resolved.scope.kind, "root")
})

test("parameter default sees earlier params, not body vars", () => {
  const r = analyze(`function f(a, b = a, c = later) { var later = 1; return b }`)
  assert.deepEqual(freeNames(r), ["later"])
})

test("nested closure resolves to outer binding", () => {
  const r = analyze(`function outer() { var x = 1; return function inner() { return x } }`)
  assert.deepEqual(freeNames(r), [])
  const xb = r.bindings.find(b => b.name === "x")
  const xref = r.references.find(ref => ref.name === "x")
  assert.equal(xref.resolved.scope.id, xb.scope.id)
  assert.equal(xref.resolved.kind, "var")
})

test("inner same-name shadows outer; outer stays bound", () => {
  const r = analyze(`var x = 1; function f() { var x = 2; return x }; x`)
  assert.equal(r.bindings.filter(b => b.name === "x").length, 2)
  assert.deepEqual(freeNames(r), [])
})

test("named function expression name visible only inside", () => {
  const r = analyze(`var f = function fact(n) { return n > 1 ? fact(n-1) : 1 }`)
  assert.deepEqual(freeNames(r), [])
  const selfRef = r.references.find(x => x.name === "fact")
  assert.equal(selfRef.resolved.kind, "function-name")
})

test("named function expression name not visible outside", () => {
  assert.deepEqual(free(`fact; (function fact(){}); fact`), ["fact", "fact"])
})

test("function declaration name bound in enclosing scope", () => {
  assert.deepEqual(free(`function f(){} f()`), [])
})

test("arguments is implicit binding of non-arrow function", () => {
  const r = analyze(`function f() { return arguments[0] }`)
  assert.deepEqual(freeNames(r), [])
  const ab = r.bindings.find(b => b.name === "arguments")
  assert.equal(ab.kind, "arguments")
  assert.equal(ab.implicit, true)
})

test("arrow has no own arguments; outer or free", () => {
  assert.deepEqual(free(`var a = () => arguments`), ["arguments"])
  assert.deepEqual(free(`function f() { return () => arguments }`), [])
})

test("catch parameter only visible in catch block", () => {
  const r = analyze(`try { x } catch (e) { log(e) }; e`)
  assert.deepEqual(freeNames(r), ["x", "log", "e"])
  const inner = r.references.find(z => z.name === "e" && !z.free)
  assert.equal(inner.resolved.kind, "catch")
})

test("catch parameter shadows outer binding", () => {
  assert.deepEqual(free(`var e = 1; try {} catch (e) { e }`), [])
})

test("let/const are block scoped", () => {
  const r = analyze(`{ let a = 1 } a; { const b = c }`)
  assert.deepEqual(freeNames(r), ["a", "c"])
})

test("var escapes blocks but not functions", () => {
  const r = analyze(`function f(){ { var v = 1 } return v }; v`)
  assert.deepEqual(freeNames(r), ["v"])
})

test("for loop binding scoped to the loop", () => {
  const r = analyze(`for (let i = 0; i < n; i++) { log(i) } i`)
  assert.deepEqual(freeNames(r), ["n", "log", "i"])
})

test("with makes identifiers unknown, not free", () => {
  const r = analyze(`function f(o){ with (o) { a + b } c }`)
  assert.deepEqual(r.unknown.map(x => x.name), ["a", "b"])
  assert.deepEqual(freeNames(r), ["c"])
})

test("nested identifiers under with are unknown too", () => {
  const r = analyze(`with (o) { function g(){ return mystery } }`)
  assert.ok(r.unknown.some(x => x.name === "mystery"))
})

test("direct eval taints unresolved names", () => {
  const r = analyze(`function f(){ eval("var x=1"); return x }`)
  assert.ok(r.dynamicEval.length >= 1)
  const u = r.unknown.find(x => x.name === "x")
  assert.ok(u.reasons.includes("direct-eval"))
})

test("direct eval does not hide real bindings", () => {
  const r = analyze(`function f(x){ eval("x"); return x }`)
  // `eval` itself is a global reference; only x must resolve to the param.
  assert.deepEqual(freeNames(r), ["eval"])
  assert.equal(r.references.find(z => z.name === "x").resolved.kind, "param")
})

test("strict-mode direct eval does not taint", () => {
  const r = analyze(`function f(){ "use strict"; eval("var x=1"); return x }`)
  assert.deepEqual(freeNames(r).filter(n => n !== 'eval'), ["x"])
  assert.equal(r.dynamicEval.length, 0)
})

test("indirect eval is an ordinary free reference", () => {
  const r = analyze(`function f(){ (0, eval)("x"); return y }`)
  assert.equal(r.dynamicEval.length, 0)
  assert.deepEqual(freeNames(r), ["eval", "y"])
})

test("shadowed eval is not direct eval", () => {
  const r = analyze(`function f(eval){ eval("x"); return y }`)
  assert.equal(r.dynamicEval.length, 0)
  assert.deepEqual(freeNames(r), ["y"])
})

test("assumed globals are neither free nor unknown", () => {
  const r = analyze(`console.log(process.version)`, {globals: ["console", "process"]})
  assert.deepEqual(freeNames(r), [])
})

test("assignment targets without declaration are references", () => {
  assert.deepEqual(free(`x = 1`), ["x"])
  assert.deepEqual(free(`x += 1; y++`), ["x", "y"])
})

test("destructuring assignment without declaration references names", () => {
  assert.deepEqual(free(`({a, b: c} = o); [d] = a2`), ["a", "c", "o", "d", "a2"])
})

test("delete of identifier still references it", () => {
  assert.deepEqual(free(`delete x`), ["x"])
})

test("module imports are bindings", () => {
  const r = analyze(`import x, {y as z} from "m"; x + z`, {sourceType: "module"})
  assert.deepEqual(freeNames(r), [])
  assert.ok(r.bindings.find(b => b.name === "z" && b.kind === "import"))
})

test("module specifier string is not a reference", () => {
  const r = analyze(`import "m"`, {sourceType: "module"})
  assert.equal(r.references.length, 0)
})

test("class expression name visible only inside", () => {
  const r = analyze(`var C = class Cls { static f(){ return Cls } }; Cls`)
  const outer = r.references.filter(x => x.name === "Cls")
  assert.equal(outer.filter(x => x.free).length, 1)
  assert.equal(outer.filter(x => !x.free).length, 1)
})

test("class declaration name is bound", () => {
  assert.deepEqual(free(`class A {} new A()`), [])
})

test("computed method key is a reference; literal key is not", () => {
  assert.deepEqual(free(`class A { [k](){} m(){} }`), ["k"])
})

test("locations point at the right source offsets", () => {
  const code = `foo(bar)`
  const r = analyze(code)
  const foo = r.freeVariables.find(f => f.name === "foo")
  assert.equal(code.slice(foo.loc.start.offset, foo.loc.end.offset), "foo")
  const bar = r.freeVariables.find(f => f.name === "fbar".slice(1))
  assert.equal(code.slice(bar.loc.start.offset, bar.loc.end.offset), "bar")
})

test("analysis does not mutate the AST", () => {
  const code = `function f(a){ var x = y; return x + a }`
  const {ast, report} = analyzeWithAst(code)
  void report
  const id = ast.body[0].params[0]
  assert.deepEqual([...Object.keys(id)].sort(),
    ["end", "loc", "name", "start", "type"].sort())
})

test("four-scopes example: only documented names are free", () => {
  const r = analyze(EXAMPLE)
  assert.deepEqual(freeNames(r), ["outer", "maybeGlobal"])
  const kinds = new Set(r.scopes.map(s => s.kind))
  for (const k of ["root", "params", "function", "block", "catch"])
    assert.ok(kinds.has(k), `scope kind ${k} present`)
})


// Regression: for-in/for-of (including for-await) use node.left/right.
test("for-in/for-of declarations and targets resolve correctly", () => {
  assert.deepEqual(free(`for (const k in o) use(k)`), ["o", "use"])
  assert.deepEqual(free(`for (k in o) q()`), ["k", "o", "q"])
  assert.deepEqual(free(`for ([a] of o) z()`), ["o", "z"])
  const r = analyze(
    `async function* g(...items){ for await (const it of items) yield f(it) }`)
  assert.deepEqual(freeNames(r), ["f"])
  assert.equal(r.bindings.find(b => b.name === "items").references.length, 1)
  assert.equal(r.bindings.find(b => b.name === "it").references.length, 1)
})

if (failures.length) {
  for (const [name, e] of failures) {
    console.error(`FAIL: ${name}`)
    console.error("  " + (e && e.message ? e.message.split("\n").join("\n  ") : e))
  }
  console.error(`\n${passed} passed, ${failures.length} failed`)
  process.exit(1)
}
console.log(`All ${passed} tests passed`)

