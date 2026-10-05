// Three examples of the explicit "use strict" directive insertion planner.
//
// Run with:
//   node examples/strict-directive-examples.mjs
//
// Each example shows a different outcome:
//   1. A normal function that gets "use strict" inserted and parses.
//   2. A function with duplicate parameter names (f(a,a)) that is rejected.
//   3. A function with a non-simple parameter list that is rejected.

import {insertStrictDirectives} from "../acorn/src/index.js"

function show(title, source, result) {
  console.log("=".repeat(60))
  console.log(title)
  console.log("-".repeat(60))
  console.log("original source:")
  console.log(source)
  console.log("-".repeat(60))
  if (result.ok) {
    console.log("result: OK")
    console.log("inserted into: " + result.insertedScopes.map(s => s.name).join(", "))
    console.log("affected sub-scopes: " + (result.affectedScopes.map(s => s.name).join(", ") || "(none)"))
    console.log("rewritten source:")
    console.log(result.code)
  } else {
    console.log("result: REJECTED")
    for (const err of result.errors) {
      console.log("  [" + err.phase + "] " + err.message)
      if (err.originalPos != null) {
        console.log("    mapped back to original position: " + err.originalPos)
      }
    }
    console.log("(no partial rewritten code returned)")
  }
  console.log()
}

// Example 1: a normal function. Inserting "use strict" is legal, so the
// rewritten source parses with the same ecmaVersion.
{
  const source = [
    "function add(a, b) {",
    "  return a + b;",
    "}",
    "",
    "add(1, 2);"
  ].join("\n")
  const result = insertStrictDirectives(source, {ecmaVersion: 2022})
  show("Example 1: normal function (accepted)", source, result)
}

// Example 2: duplicate parameter names. In strict mode f(a, a) is a
// syntax error, so the planner rejects the insertion.
{
  const source = [
    "function f(a, a) {",
    "  return a;",
    "}"
  ].join("\n")
  const result = insertStrictDirectives(source, {ecmaVersion: 2022})
  show("Example 2: f(a,a) duplicate parameters (rejected)", source, result)
}

// Example 3: non-simple parameter list. A "use strict" directive in a
// function with default, rest, or destructured parameters is illegal,
// so the planner rejects the insertion.
{
  const source = [
    "function g(a = 1) {",
    "  return a;",
    "}"
  ].join("\n")
  const result = insertStrictDirectives(source, {ecmaVersion: 2022})
  show("Example 3: non-simple parameters (rejected)", source, result)
}
