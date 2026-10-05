// Tests for the explicit lexical binding renamer.
//
// These tests cover the three scope examples required by the task:
//   1. capture  - renaming would capture a free variable
//   2. shadow   - renaming would be shadowed by an inner same-named binding
//   3. safe     - renaming is safe and succeeds
// plus shorthand handling, escaped identifiers, and rejection of unsupported
// constructs (with, eval, direct export).

(function() {
  "use strict"

  var acorn = require("../acorn/dist/acorn.js")
  var rename = acorn.rename
  var RenameError = acorn.RenameError

  var passed = 0
  var failed = 0

  function assert(cond, msg) {
    if (cond) {
      passed++
    } else {
      failed++
      console.error("FAIL: " + msg)
    }
  }

  function assertRename(src, from, to, expected, label, sourceType) {
    try {
      var r = rename(src, {from: from, to: to, sourceType: sourceType || "script"})
      assert(r.code === expected, label + ": expected " + JSON.stringify(expected) + ", got " + JSON.stringify(r.code))
    } catch (e) {
      failed++
      console.error("FAIL: " + label + " threw " + e.message)
    }
  }

  function assertReject(src, from, to, label) {
    try {
      var r = rename(src, {from: from, to: to})
      failed++
      console.error("FAIL: " + label + " should have been rejected, got " + JSON.stringify(r.code))
    } catch (e) {
      assert(e instanceof RenameError, label + ": expected RenameError, got " + e.name)
    }
  }

  // ---- Scope example 1: capture ----
  // Renaming x to p would capture the free p in the function scope.
  assertReject(
    "function f() { var x = 1; return x + p; }",
    "x", "p",
    "capture-free-variable"
  )

  // Renaming x to p would capture a global p reference.
  assertReject(
    "var p = 1; function f() { var x = 2; return x + p; }",
    "x", "p",
    "capture-global"
  )

  // ---- Scope example 2: shadow ----
  // Renaming x to p would be shadowed by an inner p declaration.
  assertReject(
    "function f() { var x = 1; function g() { var p = 2; return x + p; } return x; }",
    "x", "p",
    "shadow-inner-declaration"
  )

  // Renaming x to p would be shadowed by an inner let p.
  assertReject(
    "function f() { var x = 1; { let p = 2; return x; } }",
    "x", "p",
    "shadow-inner-let"
  )

  // ---- Scope example 3: safe ----
  // Renaming x to p is safe (no free p, no inner p).
  assertRename(
    "function f() { var x = 1; return x + 1; }",
    "x", "p",
    "function f() { var p = 1; return p + 1; }",
    "safe-var"
  )

  // Renaming a parameter x to p is safe.
  assertRename(
    "function f(x) { return x; }",
    "x", "p",
    "function f(p) { return p; }",
    "safe-param"
  )

  // ---- Shorthand handling ----
  // {x} becomes {x:p}, z.x is unchanged.
  assertRename(
    "function f(x) { var o = {x}; return o.x + z.x; }",
    "x", "p",
    "function f(p) { var o = {x:p}; return o.x + z.x; }",
    "shorthand-object"
  )

  // Destructuring shorthand {x} becomes {x:p}.
  assertRename(
    "function f() { var x = 1; var {x} = obj; return x; }",
    "x", "p",
    "function f() { var p = 1; var {x:p} = obj; return p; }",
    "shorthand-destructuring"
  )

  // Non-shorthand property {x: x} becomes {x: p}.
  assertRename(
    "function f() { var x = 1; var o = {x: x}; return o; }",
    "x", "p",
    "function f() { var p = 1; var o = {x: p}; return o; }",
    "non-shorthand-property"
  )

  // ---- Escaped identifiers ----
  // Escaped identifier in a declaration is fully replaced.
  assertRename(
    "function f() { var \u0078 = 1; return \u0078; }",
    "x", "p",
    "function f() { var p = 1; return p; }",
    "escaped-declaration"
  )

  // Escaped shorthand keeps the external key name.
  assertRename(
    "function f() { var x = 1; var o = {\u0078}; return o; }",
    "x", "p",
    "function f() { var p = 1; var o = {\u0078:p}; return o; }",
    "escaped-shorthand"
  )

  // ---- Rejection of unsupported constructs ----
  assertReject(
    "function f() { var x = 1; with (o) { return x; } }",
    "x", "p",
    "reject-with"
  )

  assertReject(
    "function f() { var x = 1; return eval(x); }",
    "x", "p",
    "reject-eval"
  )

  assertReject(
    "export var x = 1;",
    "x", "p",
    "reject-export"
  )

  // ---- Import alias renaming ----
  assertRename(
    "import {x} from 'mod'; function f() { return x; }",
    "x", "p",
    "import {p} from 'mod'; function f() { return p; }",
    "import-alias",
    "module"
  )

  // ---- Re-parse verification ----
  // The renamed source must parse successfully.
  function assertReparses(src, from, to, label) {
    try {
      var r = rename(src, {from: from, to: to})
      var reparsed = acorn.parse(r.code, {ecmaVersion: "latest", sourceType: "script"})
      assert(reparsed.type === "Program", label + ": re-parse failed")
    } catch (e) {
      failed++
      console.error("FAIL: " + label + " threw " + e.message)
    }
  }

  assertReparses(
    "function f(x) { var o = {x}; return o.x + z.x; }",
    "x", "p",
    "reparse-shorthand"
  )

  assertReparses(
    "function f() { var x = 1; return x + 1; }",
    "x", "p",
    "reparse-safe"
  )

  console.log("rename tests: " + passed + " passed, " + failed + " failed")
  if (failed) process.exit(1)
})()
