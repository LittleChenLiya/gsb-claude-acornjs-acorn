// Explicit lexical-binding renamer built on top of Acorn.
//
// Scope of support (see README.md):
//   - local declarations (var / let / const / function / class / using),
//     including destructuring declarations,
//   - function parameters (including parameter patterns and defaults),
//   - explicit import aliases: `import x from "m"`, `import * as ns from "m"`,
//     `import {a as b} from "m"` (the local alias is renamed; the external
//     name is preserved).
//
// Refused outright:
//   - `with` statements,
//   - direct `eval(...)` calls,
//   - bindings introduced or re-exported by a direct export declaration.
//
// Object / destructuring shorthands keep their external property key
// (`{x}` -> `{x: p}`). Member property names such as `z.x` are never
// references. On failure the original source is returned untouched by the
// caller (this module never mutates input) and an error is thrown.
//
// Reflection-sensitive behaviour (e.g. `fn.name`) is not promised stable.

import {Parser} from "../../acorn/src/index.js"

export {Parser}

/** Error thrown for any unsupported construct or unsafe rename. */
export class RenameError extends Error {
  constructor(message, pos = null) {
    super(pos == null ? message : `${message} (at offset ${pos})`)
    this.name = "RenameError"
    this.pos = pos
  }
}

// ---------------------------------------------------------------------------
// Scope model
// ---------------------------------------------------------------------------

class Binding {
  constructor(name, kind, scope) {
    this.name = name
    this.kind = kind // var | let | using | function | class | param | catch
    //                 | import | function-name | class-name
    this.scope = scope
    this.decls = [] // Identifier nodes that declare this binding (>=1)
    this.refs = [] // occurrence records
    this.exported = false
  }
}

class Scope {
  constructor(node, type, parent) {
    this.node = node
    this.type = type // global | module | function | class | block | catch
    this.parent = parent || null
    this.lexical = new Map()
    this.vars = new Map()
    this.params = new Map()
    this.children = []
    this.index = -1
    // Region of the program text covered by this scope. For functions it
    // starts at the first parameter so parameter defaults are included.
    this.regionStart = node.start
    this.regionEnd = node.end
    if (parent) parent.children.push(this)
  }

  register(name, kind, idNode) {
    let map
    if (kind === "var" || kind === "function") map = this.vars
    else if (kind === "param") map = this.params
    else map = this.lexical
    let binding = map.get(name)
    if (!binding) {
      binding = new Binding(name, kind, this)
      map.set(name, binding)
    }
    if (idNode) binding.decls.push(idNode)
    return binding
  }

  own(name) {
    return this.lexical.get(name) || this.vars.get(name) ||
      (this.params.has(name) ? this.params.get(name) : null)
  }
}

function resolve(scope, name) {
  for (let s = scope; s; s = s.parent) {
    const lex = s.lexical.get(name)
    if (lex) return lex
    if (s.params.has(name)) return s.params.get(name)
    const v = s.vars.get(name)
    if (v) return v
  }
  return null
}

function isNode(v) { return v && typeof v === "object" && typeof v.type === "string" }

function parseCode(code, sourceType) {
  try {
    return Parser.parse(code, {
      ecmaVersion: "latest",
      sourceType,
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
      allowHashBang: true
    })
  } catch (err) {
    throw new RenameError(`source does not parse: ${err.message}`)
  }
}

// ---------------------------------------------------------------------------
// Pass 1: build scopes and register every declaration binding
// ---------------------------------------------------------------------------

function buildScopes(ast, sourceType) {
  const root = new Scope(ast, sourceType === "module" ? "module" : "global", null)
  const at = new WeakMap()
  at.set(ast, root)
  const all = [root]
  root.index = 0
  const pendingExports = []
  const exportedDeclared = []

  function newScope(node, type, parent) {
    const s = new Scope(node, type, parent)
    s.index = all.length
    all.push(s)
    at.set(node, s)
    return s
  }

  function hoistTarget(scope) {
    for (let s = scope; s; s = s.parent)
      if (s.type === "function" || s.type === "module" || s.type === "global") return s
    return root
  }

  function lexicalSet(scope, name, idNode, kind) {
    let binding = scope.lexical.get(name)
    if (!binding) { binding = new Binding(name, kind, scope); scope.lexical.set(name, binding) }
    binding.decls.push(idNode)
  }

  function declarePattern(pat, kind, scope) {
    if (!pat) return
    // Only `var` (and hoisted function names) escape blocks. let/const/using,
    // parameters, catch and import bindings stay in their own scope.
    const target = kind === "var" ? hoistTarget(scope) : scope
    switch (pat.type) {
    case "Identifier":
      target.register(pat.name, kind, pat)
      return
    case "AssignmentPattern":
      declarePattern(pat.left, kind, scope); return
    case "ArrayPattern":
      for (const el of pat.elements) if (el) declarePattern(el, kind, scope)
      return
    case "ObjectPattern":
      for (const prop of pat.properties) {
        if (prop.type === "RestElement") declarePattern(prop.argument, kind, scope)
        else declarePattern(prop.value, kind, scope)
      }
      return
    case "RestElement":
      declarePattern(pat.argument, kind, scope)
    }
  }

  function walkDefaultExprs(pat, scope) {
    if (!pat || !isNode(pat)) return
    if (pat.type === "AssignmentPattern") walkExpr(pat.right, scope)
    for (const key in pat) {
      if (key === "right" || key === "left") continue
      const v = pat[key]
      if (Array.isArray(v)) for (const e of v) walkDefaultExprs(e, scope)
      else if (isNode(v)) walkDefaultExprs(v, scope)
    }
  }

  function enterFunction(node, scope) {
    const scopeNode = node.body.type === "BlockStatement" ? node.body : node
    const fn = newScope(scopeNode, "function", scope)
    if (node.params.length)
      fn.regionStart = node.params[0].start
    for (const p of node.params) declarePattern(p, "param", fn)
    // Only a named function EXPRESSION has a name visible inside its own
    // body. A function declaration's name is hoisted by the caller.
    if (node.id && node.type === "FunctionExpression")
      fn.register(node.id.name, "function-name", node.id)
    for (const p of node.params) walkDefaultExprs(p, fn)
    if (scopeNode === node) walkStmt(node.body, fn) // concise arrow body
    else walkBlockBody(node.body, fn)
  }

  function walkBlockBody(block, fnScope) {
    for (const st of block.body) walkStmt(st, fnScope)
  }

  function enterClass(node, scope) {
    let nameScope = scope
    if (node.type === "ClassExpression") {
      nameScope = newScope(node, "class", scope)
      if (node.id) nameScope.register(node.id.name, "class-name", node.id)
    }
    if (node.superClass) walkExpr(node.superClass, scope)
    const body = newScope(node.body, "class", nameScope)
    for (const m of node.body.body) {
      if (m.type === "StaticBlock") {
        const bs = newScope(m, "function", body)
        for (const st of m.body) walkStmt(st, bs)
      } else if (m.type === "MethodDefinition" || m.type === "PropertyDefinition") {
        walkDecl(m, body)
      }
    }
  }

  function walkDecl(node, scope) {
    if (!node) return
    if (Array.isArray(node)) { for (const n of node) walkDecl(n, scope); return }
    if (!isNode(node)) return

    switch (node.type) {
    case "WithStatement":
      throw new RenameError("with statements are not supported", node.start)

    case "FunctionDeclaration":
      if (node.id) hoistTarget(scope).register(node.id.name, "function", node.id)
      enterFunction(node, scope)
      return

    case "FunctionExpression":
    case "ArrowFunctionExpression":
      enterFunction(node, scope)
      return

    case "ClassDeclaration":
      if (node.id) lexicalSet(scope, node.id.name, node.id, "class")
      enterClass(node, scope)
      return

    case "ClassExpression":
      enterClass(node, scope)
      return

    case "VariableDeclaration": {
      const kind = node.kind === "var" ? "var"
        : node.kind === "using" || node.kind === "await using" ? "using"
        : "let"
      for (const d of node.declarations) declarePattern(d.id, kind, scope)
      for (const d of node.declarations) if (d.init) walkExpr(d.init, scope)
      return
    }

    case "BlockStatement": {
      const s = newScope(node, "block", scope)
      for (const st of node.body) walkStmt(st, s)
      return
    }

    case "StaticBlock": {
      const s = newScope(node, "function", scope)
      for (const st of node.body) walkStmt(st, s)
      return
    }

    case "CatchClause": {
      const s = newScope(node, "catch", scope)
      if (node.param) declarePattern(node.param, "catch", s)
      walkDefaultExprs(node.param, s)
      walkStmt(node.body, s)
      return
    }

    case "SwitchStatement": {
      const s = newScope(node, "block", scope)
      walkExpr(node.discriminant, scope)
      for (const c of node.cases) {
        if (c.test) walkExpr(c.test, s)
        for (const st of c.consequent) walkStmt(st, s)
      }
      return
    }

    case "ForStatement":
    case "ForInStatement":
    case "ForOfStatement": {
      const s = newScope(node, "block", scope)
      const head = node.type === "ForStatement" ? node.init : node.left
      if (head) {
        if (head.type === "VariableDeclaration") {
          const kind = head.kind === "var" ? "var"
            : head.kind === "using" || head.kind === "await using" ? "using"
            : "let"
          for (const d of head.declarations) declarePattern(d.id, kind, s)
          for (const d of head.declarations) if (d.init) walkExpr(d.init, s)
        } else {
          // Plain expression head: writes, no bindings.
          if (node.type === "ForStatement") walkExpr(head, scope)
          else walkExpr(head, scope)
        }
      }
      if (node.test) walkExpr(node.test, s)
      if (node.update) walkExpr(node.update, s)
      if (node.right) walkExpr(node.right, scope)
      walkStmt(node.body, s)
      return
    }

    case "ImportDeclaration":
      for (const spec of node.specifiers)
        lexicalSet(scope, spec.local.name, spec.local, "import")
      return

    case "ExportNamedDeclaration":
      if (node.source) return // pure re-export; no local binding
      if (node.declaration) {
        markExports(node.declaration)
        walkDecl(node.declaration, scope)
      } else {
        pendingExports.push({names: node.specifiers.map(sp => sp.local.name), node})
      }
      return

    case "ExportDefaultDeclaration":
      if (node.declaration && isNode(node.declaration) &&
          (node.declaration.type === "FunctionDeclaration" ||
           node.declaration.type === "ClassDeclaration") && node.declaration.id)
        exportedDeclared.push(node.declaration.id)
      if (node.declaration && isNode(node.declaration)) walkDecl(node.declaration, scope)
      return

    case "ExportAllDeclaration":
      return

    case "MethodDefinition":
      if (node.computed) walkExpr(node.key, scope)
      if (node.value) {
        if (node.value.type === "FunctionExpression") enterFunction(node.value, scope)
        else walkExpr(node.value, scope)
      }
      return

    case "PropertyDefinition":
      if (node.computed) walkExpr(node.key, scope)
      if (node.value) {
        if (node.value.type === "FunctionExpression") enterFunction(node.value, scope)
        else walkExpr(node.value, scope)
      }
      return

    case "Property":
      if (node.computed) walkExpr(node.key, scope)
      walkDecl(node.value, scope)
      return

    case "AssignmentPattern":
      walkExpr(node.right, scope)
      walkDecl(node.left, scope)
      return

    default:
      for (const key in node) {
        if (key === "type") continue
        const v = node[key]
        if (Array.isArray(v)) { for (const e of v) if (isNode(e)) walkDecl(e, scope) }
        else if (isNode(v)) walkDecl(v, scope)
      }
    }
  }

  function markExports(decl) {
    if (decl.type === "VariableDeclaration")
      for (const d of decl.declarations) collectPatternNames(d.id, exportedDeclared)
    else if (decl.id) exportedDeclared.push(decl.id)
  }

  function walkStmt(node, scope) { walkDecl(node, scope) }

  // Expression descent for the declaration pass.
  function walkExpr(node, scope) {
    if (!node) return
    if (Array.isArray(node)) { for (const n of node) walkExpr(n, scope); return }
    if (!isNode(node)) return
    switch (node.type) {
    case "FunctionExpression":
    case "ArrowFunctionExpression":
      enterFunction(node, scope)
      return
    case "ClassExpression":
      enterClass(node, scope)
      return
    case "ObjectExpression":
      for (const p of node.properties) {
        if (p.type === "SpreadElement") walkExpr(p.argument, scope)
        else {
          if (p.computed) walkExpr(p.key, scope)
          walkExpr(p.value, scope)
        }
      }
      return
    case "Property":
      if (node.computed) walkExpr(node.key, scope)
      walkExpr(node.value, scope)
      return
    }
    for (const key in node) {
      if (key === "type") continue
      const v = node[key]
      if (Array.isArray(v)) { for (const e of v) if (isNode(e)) walkExpr(e, scope) }
      else if (isNode(v)) walkExpr(v, scope)
    }
  }

  walkStmt(ast, root)

  for (const id of exportedDeclared) {
    const b = resolve(root, id.name)
    if (b && b.decls.some(d => d.start === id.start)) b.exported = true
  }
  for (const {names, node} of pendingExports) {
    for (const name of names) {
      const b = resolve(root, name)
      if (!b) throw new RenameError(`export of undeclared name '${name}'`, node.start)
      b.exported = true
    }
  }

  return {root, scopes: all, at}
}

function collectPatternNames(pat, out) {
  if (!pat) return
  if (pat.type === "Identifier") { out.push(pat); return }
  if (pat.type === "AssignmentPattern") { collectPatternNames(pat.left, out); return }
  if (pat.type === "RestElement") { collectPatternNames(pat.argument, out); return }
  for (const key in pat) {
    const v = pat[key]
    if (Array.isArray(v)) for (const e of v) collectPatternNames(e, out)
    else if (isNode(v)) collectPatternNames(v, out)
  }
}

// ---------------------------------------------------------------------------
// Pass 2: collect genuine references (and declaration sites)
// ---------------------------------------------------------------------------

function collectReferences(ast, root, at) {
  const occurrences = []
  const free = []

  function bindingOf(id, scope) {
    for (let s = scope; s; s = s.parent) {
      for (const map of [s.lexical, s.vars, s.params]) {
        const b = map.get(id.name)
        if (b && b.decls.some(d => d.start === id.start && d.end === id.end)) return b
      }
    }
    return null
  }

  function add(id, scope, opts = {}) {
    const declared = !!opts.declared
    const shorthand = !!opts.shorthand
    const binding = declared ? bindingOf(id, scope) : resolve(scope, id.name)
    const rec = {id, scope, binding, shorthand, declared, free: !binding}
    occurrences.push(rec)
    if (!binding) free.push(rec)
    else binding.refs.push(rec)
    return rec
  }

  function patternDecl(pat, scope) {
    if (!pat) return
    if (pat.type === "Identifier") { add(pat, scope, {declared: true}); return }
    if (pat.type === "AssignmentPattern") {
      patternDecl(pat.left, scope)
      expr(pat.right, scope)
      return
    }
    if (pat.type === "RestElement") { patternDecl(pat.argument, scope); return }
    if (pat.type === "ArrayPattern") {
      for (const el of pat.elements) if (el) patternDecl(el, scope)
      return
    }
    if (pat.type === "ObjectPattern") {
      for (const prop of pat.properties) {
        if (prop.type === "RestElement") { patternDecl(prop.argument, scope); continue }
        if (prop.computed) expr(prop.key, scope)
        if (prop.shorthand) {
          const leaf = prop.value.type === "AssignmentPattern" ? prop.value.left : prop.value
          add(leaf, scope, {declared: true, shorthand: true})
          if (prop.value.type === "AssignmentPattern") expr(prop.value.right, scope)
        } else patternDecl(prop.value, scope)
      }
    }
  }

  function target(pat, scope) {
    if (!pat) return
    if (pat.type === "Identifier") { add(pat, scope); return }
    if (pat.type === "AssignmentPattern") {
      target(pat.left, scope)
      expr(pat.right, scope)
      return
    }
    if (pat.type === "RestElement") { target(pat.argument, scope); return }
    if (pat.type === "ArrayPattern") {
      for (const el of pat.elements) if (el) target(el, scope)
      return
    }
    if (pat.type === "ObjectPattern") {
      for (const prop of pat.properties) {
        if (prop.type === "RestElement") { target(prop.argument, scope); continue }
        if (prop.computed) expr(prop.key, scope)
        if (prop.shorthand) {
          const leaf = prop.value.type === "AssignmentPattern" ? prop.value.left : prop.value
          add(leaf, scope, {shorthand: true})
          if (prop.value.type === "AssignmentPattern") expr(prop.value.right, scope)
        } else target(prop.value, scope)
      }
    }
  }

  function expr(node, scope) {
    if (!node) return
    if (Array.isArray(node)) { for (const n of node) expr(n, scope); return }
    if (!isNode(node)) return

    switch (node.type) {
    case "Identifier":
      add(node, scope)
      return

    case "MemberExpression":
    case "OptionalMemberExpression":
      expr(node.object, scope)
      if (node.computed) expr(node.property, scope) // z.x is never a reference
      return

    case "Property":
      if (node.computed) expr(node.key, scope)
      if (node.shorthand && !node.computed) {
        const value = node.value
        if (value.type === "Identifier") add(value, scope, {shorthand: true})
        else if (value.type === "AssignmentPattern") {
          add(value.left, scope, {shorthand: true})
          expr(value.right, scope)
        } else expr(value, scope)
      } else expr(node.value, scope)
      return

    case "ObjectExpression":
      for (const p of node.properties) {
        if (p.type === "SpreadElement") expr(p.argument, scope)
        else expr(p, scope)
      }
      return

    case "CallExpression":
    case "NewExpression":
      if (node.type === "CallExpression" && node.callee.type === "Identifier" &&
          node.callee.name === "eval" && !node.optional)
        throw new RenameError("direct eval calls are not supported", node.callee.start)
      expr(node.callee, scope)
      for (const a of node.arguments)
        expr(a.type === "SpreadElement" ? a.argument : a, scope)
      return

    case "FunctionExpression":
    case "ArrowFunctionExpression":
      visitFunction(node, scope)
      return

    case "ClassExpression":
      visitClass(node, scope)
      return

    case "AssignmentExpression":
      target(node.left, scope)
      expr(node.right, scope)
      return

    case "UpdateExpression":
      target(node.argument, scope)
      return

    case "MethodDefinition":
      if (node.computed) expr(node.key, scope)
      visitFunction(node.value, scope)
      return

    case "PropertyDefinition":
      if (node.computed) expr(node.key, scope)
      if (node.value) expr(node.value, scope)
      return

    case "MetaProperty":
      return

    case "ImportExpression":
      expr(node.source, scope)
      if (node.options) expr(node.options, scope)
      return

    case "TemplateLiteral":
      for (const e of node.expressions) expr(e, scope)
      return

    case "TaggedTemplateExpression":
      expr(node.tag, scope)
      expr(node.quasi, scope)
      return

    case "ChainExpression":
      expr(node.expression, scope)
      return

    case "SpreadElement":
      expr(node.argument, scope)
      return
    }

    for (const key in node) {
      if (key === "type") continue
      const v = node[key]
      if (Array.isArray(v)) { for (const e of v) if (isNode(e)) expr(e, scope) }
      else if (isNode(v)) expr(v, scope)
    }
  }

  function visitFunction(node, scope, nameScope = null) {
    const fn = at.get(node.body) || at.get(node) || scope
    if (node.id && node.type === "FunctionExpression")
      add(node.id, fn, {declared: true})
    for (const p of node.params) patternDecl(p, fn)
    if (node.body.type === "BlockStatement") {
      for (const st of node.body.body) stmt(st, fn)
    } else expr(node.body, fn)
    void nameScope
  }

  function visitClass(node, scope) {
    let s = scope
    if (node.type === "ClassExpression") {
      s = at.get(node) || scope
      if (node.id) add(node.id, s, {declared: true})
    }
    if (node.superClass) expr(node.superClass, scope)
    const bodyScope = at.get(node.body) || s
    for (const m of node.body.body) {
      if (m.type === "MethodDefinition") {
        if (m.computed) expr(m.key, bodyScope)
        visitFunction(m.value, bodyScope)
      } else if (m.type === "PropertyDefinition") {
        if (m.computed) expr(m.key, bodyScope)
        if (m.value) expr(m.value, bodyScope)
      } else if (m.type === "StaticBlock") {
        const bs = at.get(m) || bodyScope
        for (const st of m.body) stmt(st, bs)
      }
    }
  }

  function stmt(node, scope) {
    if (!node) return
    if (Array.isArray(node)) { for (const n of node) stmt(n, scope); return }
    if (!isNode(node)) return

    switch (node.type) {
    case "FunctionDeclaration": {
      const fn = at.get(node.body) || at.get(node) || scope
      if (node.id) add(node.id, scope, {declared: true}) // hoisted into the outer scope
      for (const p of node.params) patternDecl(p, fn)
      for (const st of node.body.body) stmt(st, fn)
      return
    }

    case "ClassDeclaration":
      if (node.id) add(node.id, scope, {declared: true})
      visitClass(node, scope)
      return

    case "BlockStatement": {
      const s = at.get(node) || scope
      for (const st of node.body) stmt(st, s)
      return
    }

    case "StaticBlock": {
      const s = at.get(node) || scope
      for (const st of node.body) stmt(st, s)
      return
    }

    case "VariableDeclaration":
      for (const d of node.declarations) {
        patternDecl(d.id, scope)
        if (d.init) expr(d.init, scope)
      }
      return

    case "CatchClause": {
      const s = at.get(node) || scope
      if (node.param) patternDecl(node.param, s)
      stmt(node.body, s)
      return
    }

    case "SwitchStatement": {
      const s = at.get(node) || scope
      expr(node.discriminant, scope)
      for (const c of node.cases) {
        if (c.test) expr(c.test, s)
        for (const st of c.consequent) stmt(st, s)
      }
      return
    }

    case "ForStatement":
    case "ForInStatement":
    case "ForOfStatement": {
      const s = at.get(node) || scope
      const head = node.type === "ForStatement" ? node.init : node.left
      if (head) {
        if (head.type === "VariableDeclaration") {
          for (const d of head.declarations) {
            patternDecl(d.id, s)
            if (d.init) expr(d.init, s)
          }
        } else target(head, scope)
      }
      if (node.test) expr(node.test, s)
      if (node.update) expr(node.update, s)
      if (node.right) expr(node.right, scope)
      stmt(node.body, s)
      return
    }

    case "ImportDeclaration":
      for (const spec of node.specifiers) add(spec.local, scope, {declared: true})
      return

    case "ExportNamedDeclaration":
      if (node.declaration) stmt(node.declaration, scope)
      else for (const sp of node.specifiers) if (!node.source) add(sp.local, scope)
      return

    case "ExportDefaultDeclaration":
      if (node.declaration && isNode(node.declaration)) {
        if (node.declaration.type === "FunctionDeclaration") stmt(node.declaration, scope)
        else if (node.declaration.type === "ClassDeclaration") stmt(node.declaration, scope)
        else expr(node.declaration, scope)
      }
      return

    case "WithStatement":
      throw new RenameError("with statements are not supported", node.start)

    case "ExpressionStatement":
      expr(node.expression, scope)
      return

    case "ReturnStatement":
      if (node.argument) expr(node.argument, scope)
      return

    case "ThrowStatement":
      expr(node.argument, scope)
      return

    case "LabeledStatement":
      stmt(node.body, scope) // label names are not identifiers
      return

    case "BreakStatement":
    case "ContinueStatement":
      return // labels are not identifier bindings

    case "IfStatement":
      expr(node.test, scope)
      stmt(node.consequent, scope)
      if (node.alternate) stmt(node.alternate, scope)
      return

    case "TryStatement":
      stmt(node.block, scope)
      if (node.handler) stmt(node.handler, scope)
      if (node.finalizer) stmt(node.finalizer, scope)
      return

    case "WhileStatement":
    case "DoWhileStatement":
      if (node.test) expr(node.test, scope)
      stmt(node.body, scope)
      return

    default:
      if (node.type.startsWith("Export")) return
      for (const key in node) {
        if (key === "type") continue
        const v = node[key]
        if (Array.isArray(v)) {
          for (const e of v) {
            if (!isNode(e)) continue
            if (e.type === "Identifier" || isExpressionNode(e.type)) expr(e, scope)
            else stmt(e, scope)
          }
        } else if (isNode(v)) {
          if (v.type === "Identifier" || isExpressionNode(v.type)) expr(v, scope)
          else stmt(v, scope)
        }
      }
    }
  }

  for (const stNode of ast.body) stmt(stNode, root)

  return {occurrences, free}
}

const EXPRESSION_NODES = new Set([
  "Identifier", "Literal", "ThisExpression", "ArrayExpression", "ObjectExpression",
  "FunctionExpression", "UnaryExpression", "UpdateExpression", "BinaryExpression",
  "AssignmentExpression", "LogicalExpression", "MemberExpression", "ConditionalExpression",
  "CallExpression", "NewExpression", "SequenceExpression", "TemplateLiteral",
  "TaggedTemplateExpression", "ArrowFunctionExpression", "ClassExpression", "YieldExpression",
  "AwaitExpression", "SpreadElement", "ChainExpression", "ImportExpression",
  "ParenthesizedExpression", "OptionalCallExpression", "OptionalMemberExpression",
  "MetaProperty"
])
function isExpressionNode(type) { return EXPRESSION_NODES.has(type) }

// ---------------------------------------------------------------------------
// Analysis entry point and binding lookup
// ---------------------------------------------------------------------------

export function analyze(code, options = {}) {
  const sourceType = options.sourceType === "module" ? "module" : "script"
  const ast = parseCode(code, sourceType)
  const {root, scopes, at} = buildScopes(ast, sourceType)
  const {occurrences, free} = collectReferences(ast, root, at)
  return {ast, root, scopes, at, occurrences, free, code, sourceType}
}

export function findBinding(analysis, oldName, atOffset = null) {
  const candidates = []
  for (const scope of analysis.scopes) {
    for (const map of [scope.lexical, scope.vars, scope.params]) {
      const b = map.get(oldName)
      if (b && !candidates.includes(b)) candidates.push(b)
    }
  }
  if (candidates.length === 0)
    throw new RenameError(`no local binding named '${oldName}' found`)
  if (atOffset != null) {
    const byDecl = candidates.find(b =>
      b.decls.some(d => d.start <= atOffset && atOffset <= d.end))
    if (byDecl) return byDecl
    const onRef = analysis.occurrences.find(o =>
      candidates.includes(o.binding) &&
      o.id.start <= atOffset && atOffset <= o.id.end)
    if (onRef) return onRef.binding
    throw new RenameError(`offset ${atOffset} is not on binding '${oldName}'`)
  }
  if (candidates.length > 1)
    throw new RenameError(
      `ambiguous binding name '${oldName}'; pass atOffset to disambiguate ` +
      `(found in ${candidates.length} scopes)`)
  return candidates[0]
}

/** List every genuine reference (plus declaration site) of a binding. */
export function listReferences(code, oldName, options = {}) {
  const analysis = analyze(code, options)
  const binding = findBinding(analysis, oldName, options.atOffset ?? null)
  return {
    binding,
    declarations: binding.decls.map(d => ({
      start: d.start, end: d.end, text: code.slice(d.start, d.end)
    })),
    references: (binding.refs || []).filter(r => !r.declared).map(r => ({
      start: r.id.start, end: r.id.end,
      text: code.slice(r.id.start, r.id.end),
      shorthand: r.shorthand
    }))
  }
}

// ---------------------------------------------------------------------------
// Safety checks
// ---------------------------------------------------------------------------

function rangeContains(scope, pos) {
  return scope.regionStart <= pos && pos <= scope.regionEnd
}

function isDescendantScope(maybeInner, outer) {
  for (let s = maybeInner; s; s = s.parent)
    if (s === outer) return true
  return false
}

function validateNewName(newName, sourceType) {
  if (typeof newName !== "string" || !newName)
    throw new RenameError("new name must be a non-empty string")
  if (newName.includes("\\"))
    throw new RenameError("new name must not contain escape sequences")
  try {
    Parser.parse(`var ${newName};`, {ecmaVersion: "latest", sourceType: "script"})
  } catch {
    throw new RenameError(`'${newName}' is not a valid identifier (script)`)
  }
  if (sourceType === "module") {
    try {
      Parser.parse(`var ${newName};`, {ecmaVersion: "latest", sourceType: "module"})
    } catch {
      throw new RenameError(`'${newName}' is not a valid identifier at module scope`)
    }
  }
}

function findInnerBinding(scope, name) {
  for (const child of scope.children) {
    const own = child.own(name)
    if (own) return own
    const deeper = findInnerBinding(child, name)
    if (deeper) return deeper
  }
  return null
}

function findImportSpecifier(ast, idNode) {
  let found = null
  ;(function walk(n) {
    if (!n || found) return
    if (Array.isArray(n)) { for (const e of n) walk(e); return }
    if (!isNode(n)) return
    if ((n.type === "ImportSpecifier" || n.type === "ImportDefaultSpecifier" ||
         n.type === "ImportNamespaceSpecifier") &&
        n.local.start === idNode.start && n.local.end === idNode.end) {
      found = n
      return
    }
    for (const key in n) {
      const v = n[key]
      if (isNode(v)) walk(v)
      else if (Array.isArray(v)) for (const e of v) walk(e)
    }
  })(ast)
  return found
}

function safetyChecks(analysis, binding, newName) {
  if (binding.exported)
    throw new RenameError(
      `binding '${binding.name}' is part of a direct export declaration; refusing to rename`)

  if (binding.kind === "import") {
    for (const id of binding.decls) {
      const spec = findImportSpecifier(analysis.ast, id)
      if (spec && spec.type === "ImportSpecifier" &&
          spec.imported.start === spec.local.start &&
          spec.imported.end === spec.local.end)
        throw new RenameError(
          `rename of a plain named import '${binding.name}' is not supported; ` +
          `use an explicit alias (import {${binding.name} as ${newName}})`)
    }
  }

  const targetScope = binding.scope

  // 1. clash within the binding's own scope
  const clash = targetScope.own(newName)
  if (clash && clash !== binding)
    throw new RenameError(
      `'${newName}' is already declared in the same scope (offset ${clash.decls[0].start})`,
      clash.decls[0].start)

  // 2. inner shadowing: a nested scope declares the new name
  const inner = findInnerBinding(targetScope, newName)
  if (inner)
    throw new RenameError(
      `renaming to '${newName}' would be shadowed by an inner binding (offset ${inner.decls[0].start})`,
      inner.decls[0].start)

  // 3. capture of free variables or references to outer bindings inside R
  for (const occ of analysis.occurrences) {
    if (occ.id.name !== newName) continue
    if (!rangeContains(targetScope, occ.id.start)) continue
    if (occ.free)
      throw new RenameError(
        `renaming to '${newName}' would capture the free variable '${newName}' (offset ${occ.id.start})`,
        occ.id.start)
    if (occ.binding && occ.binding !== binding &&
        occ.binding.scope !== targetScope &&
        isDescendantScope(targetScope, occ.binding.scope))
      throw new RenameError(
        `renaming to '${newName}' would capture a reference to an outer binding (offset ${occ.id.start})`,
        occ.id.start)
  }
}

// ---------------------------------------------------------------------------
// Edit planning and application
// ---------------------------------------------------------------------------

function planEdits(binding, newName) {
  const edits = []
  const seen = new Set()
  const addEdit = (start, end, text, kind) => {
    const key = start + ":" + end
    if (seen.has(key)) return
    seen.add(key)
    edits.push({start, end, text, kind})
  }

  // Identifier ranges span the whole token, so escaped identifiers
  // (`\u0078`) are replaced in their entirety.
  for (const id of binding.decls) {
    const isShorthand = (binding.refs || []).some(r =>
      r.declared && r.shorthand && r.id.start === id.start && r.id.end === id.end)
    if (isShorthand) addEdit(id.end, id.end, `: ${newName}`, "shorthand-decl")
    else addEdit(id.start, id.end, newName, "decl")
  }

  for (const ref of binding.refs || []) {
    if (ref.declared) continue // covered by decls
    if (ref.shorthand)
      addEdit(ref.id.end, ref.id.end, `: ${newName}`, "shorthand") // keep external key
    else
      addEdit(ref.id.start, ref.id.end, newName, "ref")
  }
  return edits
}

function applyEdits(code, edits) {
  const sorted = edits.slice().sort((a, b) => b.start - a.start || b.end - a.end)
  let out = code
  for (const e of sorted) out = out.slice(0, e.start) + e.text + out.slice(e.end)
  return out
}

// ---------------------------------------------------------------------------
// Verification: reparse the new source and check the binding correspondence
// ---------------------------------------------------------------------------

function verify(analysis, newCode, binding, newName) {
  const fresh = analyze(newCode, {sourceType: analysis.sourceType})
  if (analysis.scopes.length !== fresh.scopes.length)
    throw new RenameError("internal verification failed: scope count changed")
  for (let i = 0; i < analysis.scopes.length; i++)
    if (analysis.scopes[i].type !== fresh.scopes[i].type)
      throw new RenameError("internal verification failed: scope structure changed")

  const newScope = fresh.scopes[binding.scope.index]
  const newBinding = newScope.own(newName)
  if (!newBinding)
    throw new RenameError(`internal verification failed: '${newName}' missing in target scope`)
  if (newBinding.kind !== binding.kind)
    throw new RenameError("internal verification failed: binding kind changed")

  const oldCount = (binding.refs || []).length
  const newCount = (newBinding.refs || []).length
  if (oldCount !== newCount)
    throw new RenameError(
      `internal verification failed: occurrence count changed (${oldCount} -> ${newCount})`)

  for (const r of newBinding.refs || [])
    if (resolve(newScope, r.id.name) !== newBinding)
      throw new RenameError("internal verification failed: an occurrence resolves elsewhere")

  const oldFree = analysis.free.map(f => f.id.name).sort()
  const newFree = fresh.free.map(f => f.id.name).sort()
  if (oldFree.length !== newFree.length || oldFree.some((n, i) => n !== newFree[i]))
    throw new RenameError("internal verification failed: free variable multiset changed")

  if (newScope.own(binding.name))
    throw new RenameError(`internal verification failed: '${binding.name}' remains in scope`)

  return fresh
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Rename one explicitly addressed lexical binding.
 * The input string is never mutated; on failure an error is thrown and the
 * caller keeps the original source.
 *
 * @param {string} code source text
 * @param {string} oldName current binding name
 * @param {string} newName desired name
 * @param {{sourceType?: 'script'|'module', atOffset?: number, verify?: boolean}} [options]
 * @returns {{code: string, binding: Binding, references: Array, changed: boolean, edits: Array}}
 */
export function renameBinding(code, oldName, newName, options = {}) {
  if (typeof code !== "string") throw new RenameError("code must be a string")
  const sourceType = options.sourceType === "module" ? "module" : "script"
  const analysis = analyze(code, {sourceType})
  const binding = findBinding(analysis, oldName, options.atOffset ?? null)
  if (newName === oldName)
    return {code, binding, references: binding.refs || [], changed: false, edits: []}
  validateNewName(newName, sourceType)
  safetyChecks(analysis, binding, newName)
  const edits = planEdits(binding, newName)
  const newCode = applyEdits(code, edits)
  if (newCode === code) throw new RenameError("rename produced no changes")
  if (options.verify !== false) verify(analysis, newCode, binding, newName)
  return {
    code: newCode, binding, references: binding.refs || [],
    changed: true, edits
  }
}
