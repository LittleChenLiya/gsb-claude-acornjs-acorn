// Explicit "use strict" directive insertion planner.
//
// This module scans a parsed script for scopes that are not yet in
// strict mode and plans the insertion of an explicit "use strict"
// directive. Only the script top-level scope and ordinary function
// scopes (function declarations, function expressions, and block-body
// arrow functions) are considered. Modules and class bodies are always
// strict, so they (and their methods) are never touched.
//
// The planner never returns partially rewritten source: every planned
// insertion is applied to a copy, the result is re-parsed with the same
// ecmaVersion, and only if that re-parse succeeds is the rewritten code
// returned. If the re-parse fails (e.g. because a function has duplicate
// parameter names or a non-simple parameter list, both of which are
// illegal in strict mode) the planner reports the error together with
// its position mapped back to the original source.

import {parse} from "./index.js"

const STRICT_DIRECTIVE = "use strict"

const KIND_SCRIPT = "script"
const KIND_MODULE = "module"
const KIND_FUNCTION = "function"
const KIND_ARROW = "arrow"
const KIND_CLASS = "class"
const KIND_METHOD = "method"

const DEFAULT_ECMA_VERSION = 2022

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Plan and apply explicit "use strict" directive insertions.
 *
 * @param {string} source  Original source code.
 * @param {object} [options]
 * @param {number|"latest"} [options.ecmaVersion=2022]
 *   ECMAScript version used for both the initial parse and the
 *   validation re-parse.
 * @param {"script"|"module"|"commonjs"} [options.sourceType="script"]
 *   Source type. Modules are already strict and are skipped.
 * @param {Array<string|object>} [options.scopes]
 *   Optional selectors choosing which scopes to process. A selector is
 *   either the string "script", a function name, or an object with
 *   `name` and/or `start`/`end` position. When omitted, the outermost
 *   non-strict scope is selected (the script top-level for scripts,
 *   which makes the whole script strict).
 * @param {boolean} [options.script=false]
 *   When true (and `scopes` is omitted), process the script top-level
 *   scope instead of individual function scopes. This makes the whole
 *   script strict in one insertion.
 * @returns {object}
 *   On success: `{ok: true, code, changes, insertedScopes,
 *   affectedScopes, strictScopes}`. On failure: `{ok: false, errors}`
 *   with no `code` field (no partial rewritten code is returned).
 */
export function insertStrictDirectives(source, options = {}) {
  const ecmaVersion = options.ecmaVersion != null ? options.ecmaVersion : DEFAULT_ECMA_VERSION
  const sourceType = options.sourceType != null ? options.sourceType : "script"
  const selectors = options.scopes != null ? options.scopes : null
  const processScript = options.script === true

  // 1. Parse the original source. Directive detection is done on the
  //    AST, so comments are never mistaken for directives.
  let ast
  try {
    ast = parse(source, {
      ecmaVersion,
      sourceType,
      locations: true,
      allowHashBang: true,
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true
    })
  } catch (err) {
    return fail([makeError("parse", err, null)])
  }

  // 2. Collect every scope and determine which are already strict.
  const scopes = collectScopes(ast, sourceType)
  computeStrictness(scopes, source)

  // 3. Decide which scopes to insert directives into.
  const selected = selectScopes(scopes, selectors, processScript)

  // 4. Build the list of insertions (original positions).
  const insertions = []
  for (const scope of selected) {
    if (scope.strict) continue
    const ins = buildInsertion(scope, source)
    if (ins) insertions.push(ins)
  }

  if (insertions.length === 0) {
    return {
      ok: true,
      code: source,
      changes: [],
      insertedScopes: [],
      affectedScopes: [],
      strictScopes: scopes.filter(s => s.strict).map(publicScope)
    }
  }

  // 5. Apply insertions to a copy of the source (reverse order so that
  //    earlier positions stay valid).
  const code = applyInsertions(source, insertions)

  // 6. Re-parse the rewritten source with the same ecmaVersion to
  //    validate that the inserted directives are legal.
  try {
    parse(code, {
      ecmaVersion,
      sourceType,
      locations: true,
      allowHashBang: true,
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true
    })
  } catch (err) {
    const mapped = mapPositionBack(err.pos, insertions)
    return fail([makeError("reparse", err, mapped)])
  }

  // 7. Report the scopes that were inserted into and the sub-scopes
  //    that became strict as a consequence.
  const insertedScopes = insertions.map(ins => publicScope(ins.scope))
  const affectedScopes = collectAffectedScopes(scopes, selected)
  const strictScopes = scopes.filter(s => s.strict || selected.includes(s)).map(publicScope)

  return {
    ok: true,
    code,
    changes: insertions.map(ins => ({
      scope: publicScope(ins.scope),
      kind: ins.scope.kind,
      start: ins.start,
      end: ins.end,
      text: ins.text
    })),
    insertedScopes,
    affectedScopes,
    strictScopes
  }
}

// ---------------------------------------------------------------------------
// Scope collection
// ---------------------------------------------------------------------------

function collectScopes(ast, sourceType) {
  const scopes = []
  const program = makeScope(
    sourceType === "module" ? KIND_MODULE : KIND_SCRIPT,
    ast,
    ast.body,
    null,
    sourceType === "module"
  )
  program.name = "<" + (sourceType === "module" ? "module" : "script") + ">"
  scopes.push(program)

  function visit(node, scope, inClass) {
    if (!node || typeof node !== "object") return
    if (Array.isArray(node)) {
      for (const child of node) visit(child, scope, inClass)
      return
    }
    if (!node.type) return

    let newScope = scope
    let newInClass = inClass

    if (node.type === "ClassDeclaration" || node.type === "ClassExpression") {
      newScope = makeScope(KIND_CLASS, node, node.body, scope, true)
      newScope.name = node.id ? node.id.name : "<class>"
      scopes.push(newScope)
      newInClass = true
    } else if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression") {
      const kind = inClass ? KIND_METHOD : KIND_FUNCTION
      newScope = makeScope(kind, node, node.body, scope, false)
      newScope.name = functionName(node, scope)
      scopes.push(newScope)
    } else if (node.type === "ArrowFunctionExpression") {
      if (node.body && node.body.type === "BlockStatement") {
        newScope = makeScope(KIND_ARROW, node, node.body, scope, false)
        newScope.name = functionName(node, scope)
        scopes.push(newScope)
      }
    }

    for (const key of Object.keys(node)) {
      if (key === "loc" || key === "start" || key === "end" || key === "range") continue
      const child = node[key]
      if (child && typeof child === "object") visit(child, newScope, newInClass)
    }
  }

  visit(ast, program, false)
  return scopes
}

function makeScope(kind, node, body, parent, strict) {
  return {kind, node, body, parent, strict, name: ""}
}

function functionName(node, parentScope) {
  if (node.id && node.id.name) return node.id.name
  return "<anonymous>"
}

// ---------------------------------------------------------------------------
// Strictness detection
// ---------------------------------------------------------------------------

function computeStrictness(scopes, source) {
  for (const scope of scopes) {
    if (scope.kind === KIND_MODULE || scope.kind === KIND_CLASS) {
      scope.strict = true
      continue
    }
    if (hasUseStrictDirective(scope.body, source)) {
      scope.strict = true
      continue
    }
    if (scope.parent && scope.parent.strict) {
      scope.strict = true
    }
  }
}

function hasUseStrictDirective(body, source) {
  // The script scope's body is the Program.body array; function scopes
  // have a BlockStatement node with a `.body` array.
  const stmts = Array.isArray(body) ? body : body && body.body
  if (!stmts) return false
  for (const stmt of stmts) {
    if (!isDirectiveCandidate(stmt, source)) break
    if (stmt.expression.value === STRICT_DIRECTIVE) return true
  }
  return false
}

function isDirectiveCandidate(stmt, source) {
  return (
    stmt.type === "ExpressionStatement" &&
    stmt.expression.type === "Literal" &&
    typeof stmt.expression.value === "string" &&
    (source[stmt.start] === "\"" || source[stmt.start] === "'")
  )
}

// ---------------------------------------------------------------------------
// Scope selection
// ---------------------------------------------------------------------------

function selectScopes(scopes, selectors, processScript) {
  if (selectors) {
    const selected = []
    for (const scope of scopes) {
      if (scope.kind === KIND_MODULE || scope.kind === KIND_CLASS || scope.kind === KIND_METHOD) continue
      if (matchesSelector(scope, selectors)) selected.push(scope)
    }
    return selected
  }

  // Default: process every non-strict ordinary function scope
  // individually. Inserting "use strict" into a function that has
  // non-simple parameters is itself illegal, so such functions are
  // rejected at validation time.
  if (processScript) {
    const script = scopes.find(s => s.kind === KIND_SCRIPT)
    if (script && !script.strict) return [script]
    return []
  }

  return scopes.filter(s =>
    (s.kind === KIND_FUNCTION || s.kind === KIND_ARROW) && !s.strict
  )
}

function matchesSelector(scope, selectors) {
  for (const sel of selectors) {
    if (typeof sel === "string") {
      if (sel === "script" && scope.kind === KIND_SCRIPT) return true
      if (scope.name === sel) return true
    } else if (sel && typeof sel === "object") {
      if (sel.name != null && scope.name === sel.name) return true
      if (sel.start != null && scope.node.start === sel.start) return true
      if (sel.end != null && scope.node.end === sel.end) return true
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// Insertion planning
// ---------------------------------------------------------------------------

function buildInsertion(scope, source) {
  let position
  if (scope.kind === KIND_SCRIPT || scope.kind === KIND_MODULE) {
    // Insert at the start of the source, but after a leading hashbang
    // line so the shebang is preserved and remains valid.
    position = 0
    if (source.charCodeAt(0) === 35 && source.charCodeAt(1) === 33) {
      const nl = source.indexOf("\n")
      position = nl === -1 ? source.length : nl + 1
    }
  } else {
    // Ordinary function / arrow with a block body: insert right after
    // the opening brace of the body block.
    if (!scope.body || scope.body.type !== "BlockStatement") return null
    position = scope.body.start + 1
  }
  return {
    scope,
    start: position,
    end: position,
    text: "\"" + STRICT_DIRECTIVE + "\";"
  }
}

function applyInsertions(source, insertions) {
  let result = source
  for (let i = insertions.length - 1; i >= 0; i--) {
    const ins = insertions[i]
    result = result.slice(0, ins.start) + ins.text + result.slice(ins.start)
  }
  return result
}

// ---------------------------------------------------------------------------
// Position mapping (modified source -> original source)
// ---------------------------------------------------------------------------

function buildSegments(insertions) {
  const segments = []
  let oPos = 0
  let mPos = 0
  for (const ins of insertions) {
    if (ins.start > oPos) {
      const len = ins.start - oPos
      segments.push({mStart: mPos, mEnd: mPos + len, oStart: oPos, type: "orig"})
      mPos += len
      oPos = ins.start
    }
    segments.push({mStart: mPos, mEnd: mPos + ins.text.length, oStart: ins.start, type: "ins"})
    mPos += ins.text.length
  }
  return segments
}

function mapPositionBack(modifiedPos, insertions) {
  if (modifiedPos == null) return null
  const segments = buildSegments(insertions)
  for (const seg of segments) {
    if (modifiedPos < seg.mEnd) {
      if (seg.type === "orig") {
        return seg.oStart + (modifiedPos - seg.mStart)
      }
      return seg.oStart
    }
  }
  // Past the end: map to the end of the original source.
  const last = segments[segments.length - 1]
  if (last) {
    if (last.type === "orig") return last.oStart + (last.mEnd - last.mStart)
    return last.oStart
  }
  return modifiedPos
}

// ---------------------------------------------------------------------------
// Affected scope reporting
// ---------------------------------------------------------------------------

function collectAffectedScopes(scopes, insertedScopes) {
  const insertedSet = new Set(insertedScopes)
  const affected = []
  for (const scope of scopes) {
    if (scope.kind === KIND_SCRIPT || scope.kind === KIND_MODULE) continue
    if (scope.kind === KIND_CLASS || scope.kind === KIND_METHOD) continue
    // A function scope is affected if it descends from an inserted scope.
    let p = scope.parent
    while (p) {
      if (insertedSet.has(p)) {
        affected.push(publicScope(scope))
        break
      }
      p = p.parent
    }
  }
  return affected
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function publicScope(scope) {
  return {
    kind: scope.kind,
    name: scope.name,
    start: scope.node.start,
    end: scope.node.end,
    strict: scope.strict
  }
}

function makeError(phase, err, mappedPos) {
  const entry = {
    phase,
    message: err.message,
    pos: err.pos != null ? err.pos : null
  }
  if (err.loc) {
    entry.line = err.loc.line
    entry.column = err.loc.column
  }
  if (mappedPos != null) {
    entry.originalPos = mappedPos
  }
  return entry
}

function fail(errors) {
  return {ok: false, errors}
}
