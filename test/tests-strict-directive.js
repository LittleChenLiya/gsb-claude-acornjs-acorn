// Tests for the explicit "use strict" directive insertion planner.
//
// These tests verify that:
//   - normal functions get a "use strict" directive and the result parses;
//   - duplicate parameter names (f(a,a)) are rejected;
//   - non-simple parameter lists (default, rest, destructuring) are rejected;
//   - "use strict" text inside comments is not treated as a directive;
//   - modules and classes (already strict) are not touched;
//   - existing directives and shebangs are preserved;
//   - positions are mapped back to the original source on failure;
//   - no partial rewritten code is returned on failure.

if (typeof exports !== "undefined") {
  var driver = require("./driver.js")
  var test = driver.test
  var testFail = driver.testFail
  var testAssert = driver.testAssert
  var {insertStrictDirectives} = require("../acorn")
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

function assertEq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(msg + "\n  expected: " + JSON.stringify(expected) + "\n  actual:   " + JSON.stringify(actual))
  }
}

// ---------------------------------------------------------------------------
// Normal functions are accepted
// ---------------------------------------------------------------------------

testAssert("function add(a, b) { return a + b; }", (ast) => {
  return undefined
}, {ecmaVersion: 2022})

{
  const src = "function add(a, b) { return a + b; }\nadd(1, 2);"
  const r = insertStrictDirectives(src, {ecmaVersion: 2022})
  assert(r.ok, "normal function should be accepted")
  assert("code" in r, "result should have a code field")
  assert(r.code.indexOf('"use strict"') !== -1, "rewritten code should contain use strict")
  assert(r.code.indexOf("function add") !== -1, "rewritten code should preserve the function")
  assertEq(r.insertedScopes.length, 1, "should insert into one scope")
  assertEq(r.insertedScopes[0].name, "add", "should insert into 'add'")
}

// Function expression and arrow function with block body
{
  const src = "const f = function(x) { return x; };\nconst g = (y) => { return y; };"
  const r = insertStrictDirectives(src, {ecmaVersion: 2022})
  assert(r.ok, "function expression and arrow should be accepted")
  assertEq(r.insertedScopes.length, 2, "should insert into two scopes")
}

// ---------------------------------------------------------------------------
// Duplicate parameter names are rejected
// ---------------------------------------------------------------------------

{
  const src = "function f(a, a) { return a; }"
  const r = insertStrictDirectives(src, {ecmaVersion: 2022})
  assert(!r.ok, "f(a,a) should be rejected")
  assert(!("code" in r), "no partial rewritten code on failure")
  assertEq(r.errors.length, 1, "should report one error")
  assert(r.errors[0].message.indexOf("Argument name clash") !== -1, "error should be about argument name clash")
  assertEq(r.errors[0].originalPos, 14, "error position should map back to the second 'a'")
}

// ---------------------------------------------------------------------------
// Non-simple parameter lists are rejected
// ---------------------------------------------------------------------------

{
  const src = "function g(a = 1) { return a; }"
  const r = insertStrictDirectives(src, {ecmaVersion: 2022})
  assert(!r.ok, "default parameters should be rejected")
  assert(!("code" in r), "no partial rewritten code on failure")
  assert(r.errors[0].message.indexOf("non-simple parameter list") !== -1, "error should mention non-simple parameter list")
}

{
  const src = "function h(...args) { return args; }"
  const r = insertStrictDirectives(src, {ecmaVersion: 2022})
  assert(!r.ok, "rest parameters should be rejected")
  assert(!("code" in r), "no partial rewritten code on failure")
}

{
  const src = "function i({a, b}) { return a + b; }"
  const r = insertStrictDirectives(src, {ecmaVersion: 2022})
  assert(!r.ok, "destructured parameters should be rejected")
  assert(!("code" in r), "no partial rewritten code on failure")
}

// ---------------------------------------------------------------------------
// Comments do not count as directives
// ---------------------------------------------------------------------------

{
  const src = '// "use strict"\nfunction foo() { return 1; }'
  const r = insertStrictDirectives(src, {ecmaVersion: 2022})
  assert(r.ok, "comment with use strict should not prevent insertion")
  assert(r.code.indexOf('"use strict"') !== -1, "directive should be inserted")
  assert(r.code.indexOf('// "use strict"') !== -1, "comment should be preserved")
}

{
  const src = '/* "use strict" */\nfunction foo() { return 1; }'
  const r = insertStrictDirectives(src, {ecmaVersion: 2022})
  assert(r.ok, "block comment with use strict should not prevent insertion")
  assertEq(r.insertedScopes.length, 1, "should still insert into the function")
}

// ---------------------------------------------------------------------------
// Existing directives are preserved
// ---------------------------------------------------------------------------

{
  const src = '"use strict";\nfunction foo() { return 1; }'
  const r = insertStrictDirectives(src, {ecmaVersion: 2022})
  assert(r.ok, "existing use strict should be accepted")
  assertEq(r.changes.length, 0, "should not insert when already strict")
}

{
  const src = 'function f() { "use asm"; return 1; }'
  const r = insertStrictDirectives(src, {ecmaVersion: 2022})
  assert(r.ok, "existing directive should be preserved")
  assert(r.code.indexOf('"use strict"; "use asm"') !== -1, "use strict should be inserted before existing directive")
  assert(r.code.indexOf('"use asm"') !== -1, "existing directive should be preserved")
}

// ---------------------------------------------------------------------------
// Modules and classes are not touched
// ---------------------------------------------------------------------------

{
  const src = "export function foo() { return 1; }"
  const r = insertStrictDirectives(src, {ecmaVersion: 2022, sourceType: "module"})
  assert(r.ok, "module should be accepted")
  assertEq(r.changes.length, 0, "module should not be touched")
}

{
  const src = "class Foo { method() { return 1; } }\nfunction bar() { return 2; }"
  const r = insertStrictDirectives(src, {ecmaVersion: 2022})
  assert(r.ok, "class should be accepted")
  assertEq(r.insertedScopes.length, 1, "only the function should be inserted into")
  assertEq(r.insertedScopes[0].name, "bar", "should insert into 'bar', not the class method")
}

// ---------------------------------------------------------------------------
// Shebang is preserved (script-level insertion)
// ---------------------------------------------------------------------------

{
  const src = "#!/usr/bin/env node\nfunction foo() { return 1; }"
  const r = insertStrictDirectives(src, {ecmaVersion: 2022, script: true})
  assert(r.ok, "shebang script should be accepted")
  assert(r.code.indexOf("#!/usr/bin/env node") === 0, "shebang should be preserved at the start")
  assert(r.code.indexOf('"use strict"') !== -1, "use strict should be inserted after the shebang")
}

// ---------------------------------------------------------------------------
// Affected sub-scopes are reported
// ---------------------------------------------------------------------------

{
  const src = "function outer() {\n  function inner() { return 1; }\n  return inner();\n}"
  const r = insertStrictDirectives(src, {ecmaVersion: 2022})
  assert(r.ok, "nested functions should be accepted")
  assertEq(r.insertedScopes.length, 2, "both outer and inner should be inserted into")
  assertEq(r.affectedScopes.length, 1, "inner should be reported as affected")
  assertEq(r.affectedScopes[0].name, "inner", "affected scope should be 'inner'")
}

// ---------------------------------------------------------------------------
// Position mapping with multiple insertions
// ---------------------------------------------------------------------------

{
  const src = "function f(a, a) { return a; }\nfunction g(b) { return b; }"
  const r = insertStrictDirectives(src, {ecmaVersion: 2022})
  assert(!r.ok, "f(a,a) should be rejected")
  assertEq(r.errors[0].originalPos, 14, "error should map back to the second 'a' in the original source")
}

// ---------------------------------------------------------------------------
// Script-level insertion makes everything strict
// ---------------------------------------------------------------------------

{
  const src = "function foo() { return 1; }\nfunction bar(a) { return a + 1; }\nfoo();"
  const r = insertStrictDirectives(src, {ecmaVersion: 2022, script: true})
  assert(r.ok, "script-level insertion should be accepted")
  assertEq(r.insertedScopes.length, 1, "should insert into the script only")
  assertEq(r.insertedScopes[0].name, "<script>", "should insert into the script scope")
  assert(r.affectedScopes.length >= 2, "all functions should be reported as affected")
}
