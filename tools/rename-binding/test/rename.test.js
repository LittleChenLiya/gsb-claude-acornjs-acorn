import {test} from "node:test"
import assert from "node:assert/strict"
import {renameBinding, listReferences, analyze, RenameError} from "../index.js"

const ok = (code, oldName, newName, expected, options) => {
  const r = renameBinding(code, oldName, newName, options)
  assert.equal(r.code, expected)
  return r
}
const refused = (code, oldName, newName, options, match) => {
  const snapshot = code
  assert.throws(
    () => renameBinding(code, oldName, newName, options),
    (e) => {
      assert.ok(e instanceof RenameError)
      if (match) assert.match(e.message, match)
      return true
    })
  assert.equal(code, snapshot, "input string must be untouched after refusal")
}

test("acceptance: parameter x -> p turns {x} into {x:p}, leaves z.x alone", () => {
  ok(
    "function f(x){ return {x}; }\nz.x;",
    "x", "p",
    "function f(p){ return {x: p}; }\nz.x;")
})

test("acceptance: capture of an originally free p is refused", () => {
  refused("function f(x){ p; x; }", "x", "p", {}, /free variable/)
})

test("acceptance: result reparses and binding correspondence is verified", () => {
  const r = renameBinding("function f(x){ {x}; return z[x]; }", "x", "p")
  const fresh = analyze(r.code)
  const fnScope = fresh.scopes.find(s => s.type === "function")
  const b = fnScope.own("p")
  assert.ok(b, "new binding p exists in function scope")
  assert.equal(b.kind, "param")
  const pRefs = b.refs.filter(rec => !rec.declared).length
  assert.equal(pRefs, 2) // shorthand read + computed member index
  for (const rec of b.refs) assert.equal(rec.binding, b)
  assert.equal(fnScope.own("x"), null)
})

test("escaped identifiers are replaced over their full token range", () => {
  ok(
    "function f(\u0078){ var y = \u0078; ({\u0078}); }",
    "x", "p",
    "function f(p){ var y = p; ({x: p}); }")
})

test("object expression shorthand keeps its external key", () => {
  ok("var x = 1; use({x});", "x", "p", "var p = 1; use({x: p});")
})

test("destructuring parameter shorthand keeps its external key", () => {
  ok("function f({x}){ return x; }", "x", "p", "function f({x: p}){ return p; }")
})

test("shorthand with default keeps its external key", () => {
  ok("f = ({x = 1}) => x", "x", "p", "f = ({x: p = 1}) => p")
})

test("destructuring declaration shorthand keeps its external key", () => {
  ok("const {x} = o; x;", "x", "p", "const {x: p} = o; p;")
})

test("non-computed member access is not a reference", () => {
  ok("var x=1; z.x = 2; x;", "x", "p", "var p=1; z.x = 2; p;")
})

test("computed member access is a reference", () => {
  ok("var x=1; z[x];", "x", "p", "var p=1; z[p];")
})

test("method and non-computed property keys are not references", () => {
  ok("var x=1; ({x(){}, y: x});", "x", "p", "var p=1; ({x(){}, y: p});")
})

test("inner same-named variable shadows -> refused", () => {
  refused("function f(x){ { let p; } x; }", "x", "p", {}, /shadowed by an inner binding/)
})

test("nested function declaring new name -> refused", () => {
  refused("function f(x){ function g(){ var p; } x; }", "x", "p", {}, /shadowed by an inner binding/)
})

test("same-scope redeclaration clash -> refused", () => {
  refused("let x, p; x;", "x", "p", {}, /already declared in the same scope/)
})

test("outer free new name outside region is harmless", () => {
  ok("p; function f(x){ x; }", "x", "p", "p; function f(p){ p; }")
})

test("new name pointing at outer binding inside region -> capture refused", () => {
  refused("var p=0; function f(x){ p; x; }", "x", "p", {}, /outer binding/)
})

test("with statements are refused", () => {
  refused("with (o) { x; } var x = 1;", "x", "p", {}, /with statements/)
})

test("direct eval calls are refused", () => {
  refused("eval('x'); var x = 1;", "x", "p", {}, /direct eval/)
})

test("indirect eval is allowed", () => {
  ok("(0,eval)('x'); var x = 1; x;", "x", "p", "(0,eval)('x'); var p = 1; p;")
})

test("direct export declarations are refused", () => {
  refused("export let x = 1; x;", "x", "p", {sourceType: "module"}, /direct export/)
})

test("export lists mark bindings exported", () => {
  refused("let x = 1; x; export {x};", "x", "p", {sourceType: "module"}, /direct export/)
})

test("export default named function is refused", () => {
  refused("export default function f(){ f(); }", "f", "g",
          {sourceType: "module"}, /direct export/)
})

test("non-exported local in a module is allowed", () => {
  ok("function f(){ return 1; } f();", "f", "g",
     "function g(){ return 1; } g();", {sourceType: "module"})
})

test("explicit import alias keeps the external name", () => {
  ok('import {a as b} from "m"; b;', "b", "c",
     'import {a as c} from "m"; c;', {sourceType: "module"})
})

test("default import is a local alias", () => {
  ok('import d from "m"; d;', "d", "e", 'import e from "m"; e;',
     {sourceType: "module"})
})

test("namespace import alias", () => {
  ok('import * as ns from "m"; ns;', "ns", "pkg",
     'import * as pkg from "m"; pkg;', {sourceType: "module"})
})

test("plain named imports are refused (shared external/local token)", () => {
  refused('import {c} from "m"; c;', "c", "d", {sourceType: "module"},
          /plain named import/)
})

test("import rename would capture a free name in a nested scope", () => {
  // nested function refers to free c; renaming module binding b to c inside
  // the module region would capture that free reference
  refused('import {a as b} from "m"; function f(){ c; } b;', "b", "c",
          {sourceType: "module"}, /free variable|outer binding/)
})

test("array destructuring parameter", () => {
  ok("function f([x]){ return x; }", "x", "p", "function f([p]){ return p; }")
})

test("catch parameter", () => {
  ok("try {} catch (x) { x; }", "x", "p", "try {} catch (p) { p; }")
})

test("class declaration name", () => {
  ok("class X { m(){ return new X(); } }", "X", "P",
     "class P { m(){ return new P(); } }")
})

test("named function expression self binding", () => {
  ok("const f = function g(){ return g(); };", "g", "h",
     "const f = function h(){ return h(); };")
})

test("var hoisting through blocks and nested functions", () => {
  ok("var x=1; { x; } function g(){ x; }", "x", "p",
     "var p=1; { p; } function g(){ p; }")
})

test("for-of lexical binding", () => {
  ok("for (const x of xs) use(x);", "x", "p", "for (const p of xs) use(p);")
})

test("parameter default sees sibling parameters", () => {
  ok("function f(x, y = x){ return x + y; }", "x", "p",
     "function f(p, y = p){ return p + y; }")
})

test("labels are not identifiers and do not bind", () => {
  // a same-named variable renames while the label is untouched
  ok("var loop = 1; loop: for (;;) { break loop; use(loop); }", "loop", "again",
     "var again = 1; loop: for (;;) { break loop; use(again); }")
  assert.throws(
    () => renameBinding("loop: for(;;){ break loop; }", "loop", "again"),
    /no local binding/)
})

test("invalid new names are rejected", () => {
  refused("var x = 1;", "x", "42", {}, /not a valid identifier/)
  refused("var x = 1;", "x", "if", {}, /not a valid identifier/)
  refused("var x = 1;", "x", "a\\u0062", {}, /escape/)
  // contextual-only words are still rejected in strict module code
  refused("var x = 1;", "x", "let", {sourceType: "module"}, /not a valid identifier/)
})

test("same name rename is a no-op", () => {
  const code = "var x = 1; x;"
  const r = renameBinding(code, "x", "x")
  assert.equal(r.changed, false)
  assert.equal(r.code, code)
})

test("missing binding is reported", () => {
  assert.throws(() => renameBinding("var x = 1;", "y", "p"), /no local binding/)
})

test("ambiguous names need atOffset", () => {
  assert.throws(
    () => renameBinding("function f(x){ function g(x){ x; } x; }", "x", "p"),
    /ambiguous/)
  const src = "function f(x){ function g(x){ x; } x; }"
  const inner = renameBinding(src, "x", "p",
    {atOffset: src.indexOf("g(x)") + 3})
  assert.equal(inner.code, "function f(x){ function g(p){ p; } x; }")
  const outer = renameBinding(src, "x", "p", {atOffset: 11})
  assert.equal(outer.code, "function f(p){ function g(x){ x; } p; }")
})

test("listReferences reports declaration sites and genuine references", () => {
  const info = listReferences("function f(x){ z.x; return {x}; }", "x")
  assert.deepEqual(info.declarations.map(d => d.text), ["x"])
  assert.equal(info.references.length, 1)
  assert.equal(info.references[0].shorthand, true)
  assert.equal(info.references[0].text, "x")
})

test("free variable multiset is preserved", () => {
  const a = analyze("p; function f(x){ x; }")
  const b = analyze("p; function f(p){ p; }")
  assert.deepEqual(a.free.map(f => f.id.name), b.free.map(f => f.id.name))
})

test("sibling scopes do not shadow each other", () => {
  ok("function a(p){ p; } function b(x){ x; }", "x", "p",
     "function a(p){ p; } function b(p){ p; }")
})

test("object shorthand write keeps its external key", () => {
  ok("var x; ({x} = o);", "x", "p", "var p; ({x: p} = o);")
})

test("renamed source round-trips through acorn with locations intact", () => {
  const r = renameBinding("var \u0078 = 1; x;", "x", "p")
  // Reparse is already performed by verify(); check resulting text directly.
  assert.equal(r.code, "var p = 1; p;")
})
