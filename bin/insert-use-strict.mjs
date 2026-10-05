// Explicit "use strict" directive insertion planner.
//
// Inserts a `"use strict";` prologue directive into *selected* scopes only:
// the top-level script (Program) and/or plain function scopes
// (FunctionDeclaration / FunctionExpression). Scopes that are already strict
// are never touched:
//
//   - modules (`sourceType: "module"`) are strict by definition
//   - class bodies (and everything inside them) are strict by definition
//   - any scope that already has a "use strict" directive of its own, or
//     inherits one from an enclosing scope, is skipped
//
// Shebang lines, comments and existing directives are preserved. Comment
// text that merely *mentions* "use strict" is ignored (only real AST
// directive prologues count). After rewriting, the result is re-parsed with
// the same ecmaVersion/sourceType; if the stricter code no longer parses
// (duplicate parameters, non-simple parameters, `with`, octals, ...), the
// whole operation is rejected and no partially rewritten code is returned.
//
// All reported positions (insertion offsets, scope ranges) map back to the
// *original* source text.
//
// CLI:
//   node bin/insert-use-strict.mjs [--ecma-version V] [--source-type T]
//        [--select start,start,...] [--plan] <file>
//
// Example (see examples/three-functions.js):
//   node bin/insert-use-strict.mjs examples/three-functions.js

import {parse} from "../acorn/src/index.js"

const FUNCTION_SCOPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression"
])

const ALL_FUNCTION_SCOPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression"
])

// Does this Program/BlockStatement node already have a "use strict"
// directive in its prologue? Only genuine AST directives count - comment
// text is never consulted.
function hasUseStrictDirective(bodyNode) {
  return bodyNode.body.some(stmt => stmt.directive === "use strict")
}

function scopeInfo(node) {
  return {
    type: node.type,
    name: node.type === "Program" ? null : (node.id && node.id.name || null),
    start: node.start,
    end: node.end
  }
}

// Iterate over child AST nodes (generic, node-type agnostic).
function eachChild(node, fn) {
  for (const key in node) {
    if (key === "range" || key === "loc" || key === "start" || key === "end") continue
    const value = node[key]
    if (Array.isArray(value)) {
      for (const item of value)
        if (item && typeof item.type === "string") fn(item)
    } else if (value && typeof value.type === "string") {
      fn(value)
    }
  }
}

// Indentation of the line containing `pos`, plus one extra level.
function innerIndentAt(code, pos) {
  const lineStart = code.lastIndexOf("\n", pos - 1) + 1
  const match = /^[ \t]*/.exec(code.slice(lineStart, pos))
  return (match ? match[0] : "") + "  "
}

// Validate that making `node` (a function) strict is legal with respect to
// its parameter list. Returns a list of problems (empty when fine).
function paramProblems(node) {
  const problems = []
  const seen = new Set()
  for (const param of node.params) {
    if (param.type !== "Identifier") {
      problems.push({
        message: `non-simple parameter (${param.type}) cannot be used in a strict mode function`,
        start: param.start,
        end: param.end
      })
    } else if (seen.has(param.name)) {
      problems.push({
        message: `duplicate parameter name '${param.name}' is not allowed in strict mode`,
        start: param.start,
        end: param.end
      })
    } else {
      seen.add(param.name)
    }
  }
  return problems
}

// Collect every function scope inside `node` that is not already strict on
// its own (own directive or class context). These are the sub-scopes that
// become strict as a side effect of inserting into an enclosing scope.
function collectAffectedSubScopes(node, out) {
  eachChild(node, child => {
    if (child.type === "ClassDeclaration" || child.type === "ClassExpression" ||
        child.type === "ClassStaticBlock") {
      return // class bodies are always strict - not affected by us
    }
    if (ALL_FUNCTION_SCOPES.has(child.type)) {
      if (child.body.type === "BlockStatement" && hasUseStrictDirective(child.body))
        return // already strict via its own directive
      out.push(Object.assign({via: "inherited"}, scopeInfo(child)))
    }
    collectAffectedSubScopes(child, out)
  })
}

// Plan "use strict" insertions for `code` without applying them.
//
// Options:
//   ecmaVersion  - passed to acorn (default "latest")
//   sourceType   - "script" (default) or "module"; modules are never rewritten
//   select       - optional array of scope starts (numbers matching a
//                  scope's `start` offset; the string "program" selects the
//                  Program) or a predicate (node) => boolean. Only selected
//                  scopes are considered. Default: all eligible
//                  script/plain-function scopes.
//
// Returns {ok: true, insertions, affectedScopes, skipped, ecmaVersion,
// sourceType} or {ok: false, errors}. All offsets refer to the original
// source.
export function planUseStrictInsertion(code, options = {}) {
  const ecmaVersion = options.ecmaVersion == null ? "latest" : options.ecmaVersion
  const sourceType = options.sourceType || "script"
  const comments = []
  let ast
  try {
    ast = parse(code, {
      ecmaVersion,
      sourceType,
      allowHashBang: true,
      locations: true,
      onComment: comments
    })
  } catch (error) {
    return {ok: false, errors: [{message: `cannot parse input: ${error.message}`, start: error.pos, end: error.pos}]}
  }

  const select = options.select
  const isSelected = node => {
    if (select == null) return true
    if (typeof select === "function") return select(node)
    return select.some(entry =>
      node.type === "Program" ? entry === "program" : entry === node.start)
  }

  const insertions = []
  const affectedScopes = []
  const skipped = []
  const errors = []

  const addInsertion = (node, offset, text) => {
    const scope = scopeInfo(node)
    const affected = []
    collectAffectedSubScopes(node.type === "Program" ? node : node.body, affected)
    insertions.push({offset, text, scope})
    affectedScopes.push(Object.assign({via: "direct"}, scope))
    for (const sub of affected) affectedScopes.push(sub)
  }

  // `strictness` is null (non-strict), "inherited" (already strict before
  // we ran) or "inserted" (strict because of one of our own insertions).
  const visit = (node, strictness) => {
    if (node.type === "Program") {
      const ownStrict = sourceType === "module" || hasUseStrictDirective(node)
      let own = null
      if (!ownStrict) {
        if (isSelected(node)) {
          // Preserve the shebang: insert on the line after it.
          const hashbang = comments.find(c => c.start === 0 && code.startsWith("#!"))
          let offset = 0, text = "\"use strict\";\n"
          if (hashbang) {
            const nl = code.indexOf("\n", hashbang.end)
            if (nl === -1) { offset = code.length; text = "\n\"use strict\";\n" }
            else offset = nl + 1
          }
          addInsertion(node, offset, text)
          own = "inserted"
        }
      } else {
        skipped.push(Object.assign({
          reason: sourceType === "module"
            ? "modules are always strict"
            : "already has a \"use strict\" directive"
        }, scopeInfo(node)))
        own = "inherited"
      }
      eachChild(node, child => visit(child, own || strictness))
      return
    }

    if (node.type === "ClassDeclaration" || node.type === "ClassExpression") {
      // Class bodies are strict mode code: never insert inside them. Only
      // the super class and computed property keys are evaluated in the
      // enclosing (possibly non-strict) scope.
      if (node.superClass) visit(node.superClass, strictness)
      for (const member of node.body.body) {
        if (member.computed && member.key) visit(member.key, strictness)
        if (member.value && ALL_FUNCTION_SCOPES.has(member.value.type))
          skipped.push(Object.assign({reason: "class bodies are always strict"}, scopeInfo(member.value)))
      }
      return
    }

    if (FUNCTION_SCOPES.has(node.type)) {
      const ownStrict = hasUseStrictDirective(node.body)
      let own = null
      if (strictness) {
        if (strictness === "inherited")
          skipped.push(Object.assign({reason: "inherits strict mode from an enclosing scope"}, scopeInfo(node)))
        // When strictness is "inserted" the scope is already reported in
        // affectedScopes - no need to list it as skipped as well.
      } else if (ownStrict) {
        skipped.push(Object.assign({reason: "already has a \"use strict\" directive"}, scopeInfo(node)))
        own = "inherited"
      } else if (isSelected(node)) {
        const problems = paramProblems(node)
        if (problems.length) {
          for (const problem of problems)
            errors.push(Object.assign({scope: scopeInfo(node)}, problem))
        } else {
          addInsertion(node, node.body.start + 1,
            "\n" + innerIndentAt(code, node.body.start) + "\"use strict\";")
          own = "inserted"
        }
      }
      eachChild(node, child => visit(child, own || strictness))
      return
    }

    eachChild(node, child => visit(child, strictness))
  }

  visit(ast, null)

  if (errors.length) return {ok: false, errors}
  return {ok: true, insertions, affectedScopes, skipped, ecmaVersion, sourceType}
}

// Apply the plan and verify the result by re-parsing with the same
// ecmaVersion/sourceType. On any failure the result is {ok: false, errors}
// and no (partially) rewritten code is returned.
export function insertUseStrict(code, options = {}) {
  const plan = planUseStrictInsertion(code, options)
  if (!plan.ok) return plan

  let rewritten = code
  const ordered = plan.insertions.slice().sort((a, b) => b.offset - a.offset)
  for (const {offset, text} of ordered)
    rewritten = rewritten.slice(0, offset) + text + rewritten.slice(offset)

  try {
    parse(rewritten, {
      ecmaVersion: plan.ecmaVersion,
      sourceType: plan.sourceType,
      allowHashBang: true
    })
  } catch (error) {
    return {
      ok: false,
      errors: [{
        message: `re-parse with ecmaVersion ${plan.ecmaVersion} rejected the strict rewrite: ${error.message}`,
        start: error.pos,
        end: error.pos
      }]
    }
  }

  return Object.assign({code: rewritten}, plan)
}

// --- CLI ------------------------------------------------------------------

function parseArgs(argv) {
  const options = {}
  let file = null, planOnly = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--ecma-version") options.ecmaVersion = argv[++i]
    else if (arg === "--source-type") options.sourceType = argv[++i]
    else if (arg === "--select") {
      options.select = argv[++i].split(",").map(part =>
        part === "program" ? "program" : Number(part))
    } else if (arg === "--plan") planOnly = true
    else if (arg === "--help" || arg === "-h") {
      console.log("usage: node bin/insert-use-strict.mjs [--ecma-version V] [--source-type script|module] [--select start,...] [--plan] <file>")
      process.exit(0)
    } else file = arg
  }
  return {options, file, planOnly}
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href
if (isMain) {
  const {readFileSync} = await import("fs")
  const {options, file, planOnly} = parseArgs(process.argv.slice(2))
  if (!file) {
    console.error("error: no input file given (try --help)")
    process.exit(2)
  }
  const code = readFileSync(file, "utf8")
  const result = planOnly ? planUseStrictInsertion(code, options) : insertUseStrict(code, options)
  if (!result.ok) {
    for (const error of result.errors)
      console.error(`error: ${error.message}` +
        (error.start != null ? ` (at offset ${error.start})` : ""))
    process.exit(1)
  }
  if (planOnly) console.log(JSON.stringify(result, null, 2))
  else process.stdout.write(result.code)
}
