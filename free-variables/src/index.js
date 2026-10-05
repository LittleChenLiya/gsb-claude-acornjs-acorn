// Free-variable analysis built on top of the Acorn parser.
//
// The analysis walks a *parsed* AST; it never executes code and never mutates
// AST nodes. All analysis state lives in external WeakMap/Map structures.
//
// Scope kinds:
//   root     - Program (script or module)
//   params   - function parameter scope (defaults resolve here)
//   function - function body scope (var hoisting target; owns `arguments`)
//   block    - plain blocks, loop heads, class bodies
//   catch    - catch parameter + body
//   with     - dynamic scope; identifiers inside are reported *unknown*
//
// Direct eval (a call of the unshadowed identifier `eval` in non-strict code)
// can create bindings at runtime; names such a call might introduce are also
// reported as unknown. Indirect/global eval is an ordinary free reference.
//
// Member names and literal object keys are not references; computed keys and
// destructuring defaults are.

import * as acorn from "../../acorn/src/index.js"

export const isFunction = n => n && (n.type === "FunctionDeclaration" ||
  n.type === "FunctionExpression" || n.type === "ArrowFunctionExpression")

function makeScope(parent, node, kind) {
  return {
    id: null, parent, kind, node,
    bindings: new Map(),
    varTarget: kind === "root" ? null : undefined,
    strict: false,
    nfeName: null,
    taintedByEval: false,
    bodyScope: null,
    params: null,
    children: [],
    implicit: []
  }
}

export function locOf(node) {
  if (!node || !node.loc) return null
  return {
    start: {line: node.loc.start.line, column: node.loc.start.column, offset: node.start},
    end: {line: node.loc.end.line, column: node.loc.end.column, offset: node.end}
  }
}

function addBinding(scope, name, kind, node, implicit = false) {
  let b = scope.bindings.get(name)
  if (!b) {
    b = {name, kind, scope, loc: node ? locOf(node) : null, nodes: [], implicit}
    scope.bindings.set(name, b)
  }
  if (node) b.nodes.push(node)
  if (implicit) scope.implicit.push(b)
  return b
}

function declarePattern(pattern, scope, kind) {
  switch (pattern.type) {
  case "Identifier":
    addBinding(scope, pattern.name, kind, pattern)
    break
  case "ObjectPattern":
    for (const prop of pattern.properties) {
      if (prop.type === "RestElement") declarePattern(prop.argument, scope, kind)
      else declarePattern(prop.value, scope, kind)
    }
    break
  case "ArrayPattern":
    for (const el of pattern.elements) if (el) declarePattern(el, scope, kind)
    break
  case "AssignmentPattern":
    declarePattern(pattern.left, scope, kind)
    break
  case "RestElement":
    declarePattern(pattern.argument, scope, kind)
    break
  }
}

function isStrictBody(body) {
  if (!body || body.type !== "BlockStatement" || !body.body.length) return false
  const first = body.body[0]
  return first.type === "ExpressionStatement" &&
    first.expression.type === "Literal" && first.expression.value === "use strict"
}

class Analyzer {
  constructor(code, options = {}) {
    this.code = code
    this.forcedSourceType = options.sourceType
    this.globals = new Set(options.globals || [])
    this.ecmaVersion = options.ecmaVersion || "latest"
    this.scopes = []
    this.refs = []
    this.directEvals = []
    this.ast = null
    this._scopeMap = new WeakMap()
  }

  parse() {
    const sourceType = this.forcedSourceType ||
      (this._looksLikeModule() ? "module" : "script")
    this.ast = acorn.parse(this.code, {
      ecmaVersion: this.ecmaVersion,
      sourceType,
      locations: true,
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
      allowHashBang: true
    })
    this.sourceType = sourceType
    return this.ast
  }

  _looksLikeModule() {
    return /(^|[\s;{}])(import|export)([\s{*]|$)/.test(this.code)
  }

  scopeOf(node) { return this._scopeMap.get(node) }

  analyze() {
    if (!this.ast) this.parse()
    this._nextId = 0
    const root = makeScope(null, this.ast, "root")
    root.strict = this.sourceType === "module" || isStrictBody(this.ast)
    this._register(root, this.ast)
    for (const st of this.ast.body) this.walk(st, root)
    this.resolveRefs()
    return this.buildReport()
  }

  _register(scope, node) {
    scope.id = this._nextId++
    this.scopes.push(scope)
    this._scopeMap.set(node, scope)
  }

  childScope(parent, node, kind) {
    const s = makeScope(parent, node, kind)
    s.strict = parent.strict
    parent.children.push(s)
    this._register(s, node)
    return s
  }

  // Scope receiving `var` / hoisted function declarations.
  varTarget(scope) {
    if (scope.kind === "root" || scope.kind === "function") return scope
    if (scope.kind === "params") return scope.bodyScope
    if (scope.varTarget !== undefined) return scope.varTarget
    let s = scope.parent
    while (s && s.kind !== "function" && s.kind !== "root") s = s.parent
    scope.varTarget = s
    return s
  }

  walk(node, scope, state = {}) {
    if (!node || typeof node.type !== "string") return
    switch (node.type) {
    // ---- functions ----
    case "FunctionDeclaration": {
      if (node.id) {
        const target = scope.kind === "block" && scope.strict
          ? scope : this.varTarget(scope)
        addBinding(target, node.id.name, "function", node.id)
      }
      this.functionScopes(node, scope)
      return
    }
    case "FunctionExpression":
    case "ArrowFunctionExpression":
      this.functionScopes(node, scope)
      return

    // ---- declarations ----
    case "VariableDeclaration":
      this.varDeclaration(node, scope)
      return
    case "ClassDeclaration":
      if (node.id) addBinding(scope, node.id.name, "class", node.id)
      this.classBody(node, scope)
      return
    case "ClassExpression":
      this.classBody(node, scope)
      return
    case "ImportDeclaration":
      for (const spec of node.specifiers)
        addBinding(scope, spec.local.name, "import", spec.local)
      return
    case "ExportNamedDeclaration":
      this.exportNamed(node, scope)
      return
    case "ExportDefaultDeclaration":
      this.exportDefault(node, scope)
      return
    case "ExportAllDeclaration":
      return

    // ---- scoped statements ----
    case "BlockStatement":
    case "StaticBlock": {
      // Static blocks have their own lexical and var scope (like a function
      // body); var declarations do not leak to the enclosing class/module.
      const bs = this.childScope(scope, node, "block")
      if (node.type === "StaticBlock") bs.varTarget = bs
      for (const st of node.body) this.walk(st, bs)
      return
    }
    case "CatchClause": {
      const cs = this.childScope(scope, node, "catch")
      if (node.param) {
        declarePattern(node.param, cs, "catch")
        this.walkPatternRefs(node.param, cs)
      }
      this.walk(node.body, cs)
      return
    }
    case "WithStatement": {
      const ws = this.childScope(scope, node, "with")
      this.walk(node.object, scope)
      this.walk(node.body, ws)
      return
    }
    case "ForStatement":
    case "ForInStatement":
    case "ForOfStatement":
      this.forStatement(node, scope)
      return
    case "SwitchStatement":
      this.walk(node.discriminant, scope)
      for (const c of node.cases) {
        if (c.test) this.walk(c.test, scope)
        for (const st of c.consequent) this.walk(st, scope)
      }
      return

    // ---- expressions where identifiers may be references ----
    case "Identifier":
      this.addReference(node, scope, state)
      return
    case "MemberExpression":
    case "OptionalMemberExpression":
      this.walk(node.object, scope)
      if (node.computed) this.walk(node.property, scope)
      return
    case "Property":
      if (node.computed) this.walk(node.key, scope)
      if (node.shorthand && node.value.type === "Identifier") {
        this.addReference(node.value, scope)
        return
      }
      this.walk(node.value, scope)
      return
    case "ObjectExpression":
      for (const p of node.properties) this.walk(p, scope)
      return
    case "ArrayExpression":
      for (const el of node.elements) if (el) this.walk(el, scope)
      return
    case "SpreadElement":
      this.walk(node.argument, scope)
      return
    case "AssignmentExpression":
      if (node.left.type === "Identifier")
        this.addReference(node.left, scope, {assignmentTarget: true})
      else this.walkLvalRefs(node.left, scope)
      this.walk(node.right, scope)
      return
    case "UpdateExpression":
      if (node.argument.type === "Identifier")
        this.addReference(node.argument, scope, {assignmentTarget: true})
      else this.walk(node.argument, scope)
      return
    case "CallExpression":
    case "OptionalCallExpression":
    case "NewExpression":
      if (isFunction(node.callee)) this.functionScopes(node.callee, scope)
      else this.walk(node.callee, scope)
      for (const a of node.arguments)
        this.walk(a.type === "SpreadElement" ? a.argument : a, scope)
      return
    case "ChainExpression":
      this.walk(node.expression, scope)
      return
    case "AssignmentPattern":
      this.walkLvalRefs(node.left, scope)
      this.walk(node.right, scope)
      return
    case "ArrayPattern":
    case "ObjectPattern":
    case "RestElement":
      this.walkPatternRefs(node, scope)
      return
    case "ConditionalExpression":
      this.walk(node.test, scope)
      this.walk(node.consequent, scope)
      this.walk(node.alternate, scope)
      return
    case "SequenceExpression":
      for (const e of node.expressions) this.walk(e, scope)
      return
    case "TemplateLiteral":
      for (const e of node.expressions) this.walk(e, scope)
      return
    case "TaggedTemplateExpression":
      this.walk(node.tag, scope)
      this.walk(node.quasi, scope)
      return
    case "YieldExpression":
      if (node.argument) this.walk(node.argument, scope)
      return
    case "AwaitExpression":
      this.walk(node.argument, scope)
      return
    case "UnaryExpression":
      this.walk(node.argument, scope)
      return
    case "BinaryExpression":
    case "LogicalExpression":
      this.walk(node.left, scope)
      this.walk(node.right, scope)
      return
    case "MetaProperty":
    case "PrivateIdentifier":
      return
    case "ImportExpression":
      this.walk(node.source, scope)
      if (node.options) this.walk(node.options, scope)
      return
    case "MethodDefinition":
    case "PropertyDefinition":
      if (node.computed) this.walk(node.key, scope)
      if (node.value) {
        if (isFunction(node.value)) this.functionScopes(node.value, scope)
        else this.walk(node.value, scope)
      }
      return

    // ---- simple statements ----
    case "LabeledStatement":
      this.walk(node.body, scope)
      return
    case "IfStatement":
      this.walk(node.test, scope)
      this.walk(node.consequent, scope)
      if (node.alternate) this.walk(node.alternate, scope)
      return
    case "ReturnStatement":
      if (node.argument) this.walk(node.argument, scope)
      return
    case "ThrowStatement":
      this.walk(node.argument, scope)
      return
    case "TryStatement":
      this.walk(node.block, scope)
      if (node.handler) this.walk(node.handler, scope)
      if (node.finalizer) this.walk(node.finalizer, scope)
      return
    case "WhileStatement":
    case "DoWhileStatement":
      this.walk(node.test, scope)
      this.walk(node.body, scope)
      return
    case "ExpressionStatement":
      this.walk(node.expression, scope)
      return
    case "Literal":
    case "TemplateElement":
    case "DebuggerStatement":
    case "EmptyStatement":
    case "BreakStatement":
    case "ContinueStatement":
    case "ImportSpecifier":
    case "ImportDefaultSpecifier":
    case "ImportNamespaceSpecifier":
    case "ExportSpecifier":
      return
    default:
      for (const key of Object.keys(node)) {
        if (["type","start","end","loc","range","raw","comments"].includes(key)) continue
        const v = node[key]
        if (Array.isArray(v)) {
          for (const it of v) if (it && typeof it.type === "string") this.walk(it, scope)
        } else if (v && typeof v.type === "string") this.walk(v, scope)
      }
    }
  }

  exportNamed(node, scope) {
    const d = node.declaration
    if (d) {
      if (isFunction(d)) {
        if (d.id) addBinding(scope, d.id.name, "function", d.id)
        this.functionScopes(d, scope)
      } else if (d.type === "ClassDeclaration") {
        if (d.id) addBinding(scope, d.id.name, "class", d.id)
        this.classBody(d, scope)
      } else {
        this.varDeclaration(d, scope)
      }
    }
    for (const spec of node.specifiers || []) {
      // local name references a binding; exported name is just a name.
      if (spec.local && spec.local.type === "Identifier" && !d)
        this.addReference(spec.local, scope)
    }
  }

  exportDefault(node, scope) {
    const d = node.declaration
    if (isFunction(d)) {
      if (d.id) addBinding(scope, d.id.name, "function", d.id)
      this.functionScopes(d, scope)
    } else if (d.type === "ClassDeclaration" || d.type === "ClassExpression") {
      if (d.id) addBinding(scope, d.id.name, "class", d.id)
      this.classBody(d, scope)
    } else {
      this.walk(d, scope)
    }
  }

  varDeclaration(node, scope) {
    if (node.kind === "var") {
      const target = this.varTarget(scope)
      for (const d of node.declarations) declarePattern(d.id, target, "var")
    } else {
      for (const d of node.declarations) declarePattern(d.id, scope, node.kind)
    }
    for (const d of node.declarations) {
      this.walkPatternRefs(d.id, scope)
      if (d.init) this.walk(d.init, scope)
    }
  }

  forStatement(node, scope) {
    const bs = this.childScope(scope, node, "block")
    const init = node.init
    if (node.type === "ForStatement") {
      if (init) {
        if (init.type === "VariableDeclaration") this.varDeclaration(init, bs)
        else this.walk(init, bs)
      }
      if (node.test) this.walk(node.test, bs)
      if (node.update) this.walk(node.update, bs)
    } else {
      const left = node.left
      if (left.type === "VariableDeclaration") {
        this.varDeclaration(left, bs)
      } else if (left.type === "Identifier") {
        this.addReference(left, bs, {assignmentTarget: true})
      } else {
        this.walk(left, bs)
      }
      this.walk(node.right, bs)
    }
    this.walk(node.body, bs)
  }

  // References inside a *binding* pattern: computed keys (also references in
  // destructuring targets) and default-value expressions.
  walkPatternRefs(pattern, scope) {
    if (!pattern) return
    switch (pattern.type) {
    case "Identifier":
      return
    case "AssignmentPattern":
      this.walk(pattern.right, scope)
      this.walkPatternRefs(pattern.left, scope)
      return
    case "ObjectPattern":
      for (const prop of pattern.properties) {
        if (prop.type === "RestElement") { this.walkPatternRefs(prop.argument, scope); continue }
        if (prop.computed) this.walk(prop.key, scope)
        this.walkPatternRefs(prop.value, scope)
      }
      return
    case "ArrayPattern":
      for (const el of pattern.elements) if (el) this.walkPatternRefs(el, scope)
      return
    case "RestElement":
      this.walkPatternRefs(pattern.argument, scope)
      return
    default:
      this.walk(pattern, scope)
    }
  }

  // Assignment to a destructuring pattern without a declaration, e.g.
  // `({a} = o)` / `[x] = a`: element identifiers are references (targets).
  walkLvalRefs(pattern, scope) {
    switch (pattern.type) {
    case "Identifier":
      this.addReference(pattern, scope, {assignmentTarget: true})
      return
    case "ObjectPattern":
      for (const prop of pattern.properties) {
        if (prop.type === "RestElement") { this.walkLvalRefs(prop.argument, scope); continue }
        if (prop.computed) this.walk(prop.key, scope)
        if (prop.shorthand && prop.value.type === "Identifier")
          this.addReference(prop.value, scope, {assignmentTarget: true})
        else this.walkLvalRefs(prop.value, scope)
      }
      return
    case "ArrayPattern":
      for (const el of pattern.elements) if (el) this.walkLvalRefs(el, scope)
      return
    case "AssignmentPattern":
      this.walkLvalRefs(pattern.left, scope)
      this.walk(pattern.right, scope)
      return
    case "RestElement":
      this.walkLvalRefs(pattern.argument, scope)
      return
    case "MemberExpression":
      this.walk(pattern.object, scope)
      if (pattern.computed) this.walk(pattern.property, scope)
      return
    default:
      this.walk(pattern, scope)
    }
  }

  functionScopes(fn, outerScope) {
    const strict = outerScope.strict || isStrictBody(fn.body)
    const params = makeScope(outerScope, fn, "params")
    params.strict = strict
    const useBodyNode = fn.body && fn.body.type === "BlockStatement"
    const body = makeScope(params, useBodyNode ? fn.body : fn, "function")
    body.strict = strict
    params.bodyScope = body
    body.params = params

    if (fn.type === "FunctionExpression" && fn.id) {
      // Named function expression name: visible only inside the function
      // (parameter defaults included), never outside.
      params.nfeName = {name: fn.id.name, node: fn.id}
      body.nfeName = params.nfeName
    }

    for (const p of fn.params) declarePattern(p, params, "param")
    if (fn.type !== "ArrowFunctionExpression")
      addBinding(params, "arguments", "arguments", null, true)

    outerScope.children.push(params)
    params.children.push(body)
    this._register(params, fn)
    this._scopeMap.set(fn, params)
    this._register(body, useBodyNode ? fn.body : fn)

    // Parameter defaults evaluate in the parameter scope.
    for (const p of fn.params) this.walkPatternRefs(p, params)
    if (useBodyNode) {
      for (const st of fn.body.body) this.walk(st, body)
    } else {
      this.walk(fn.body, body)
    }
  }

  classBody(cls, outerScope) {
    // Class expression name is visible only within the class; a declaration
    // name is visible at the point of declaration, which is modeled by a
    // name scope wrapping the body scope.
    const nameScope = this.childScope(outerScope, cls, "block")
    if (cls.id) addBinding(nameScope, cls.id.name, "class", cls.id)
    if (cls.superClass) this.walk(cls.superClass, outerScope)
    const body = this.childScope(nameScope, cls.body, "block")
    for (const m of cls.body.body) {
      if (m.type === "StaticBlock") { this.walk(m, body); continue }
      if (m.computed) this.walk(m.key, body)
      if (m.value) {
        if (isFunction(m.value)) this.functionScopes(m.value, body)
        else this.walk(m.value, body)
      }
    }
  }

  addReference(idNode, scope, {assignmentTarget = false} = {}) {
    if (idNode.type !== "Identifier") return
    this.refs.push({
      name: idNode.name,
      loc: locOf(idNode),
      scope,
      binding: null,
      free: false,
      unknown: false,
      reasons: [],
      assignmentTarget
    })
  }

  resolveRefs() {
    this._markDirectEvals()
    const evalCallees = new Set()
    const keyOf = (name, loc) => `${name}@${loc ? loc.start.offset : -1}`
    for (const d of this.directEvals)
      evalCallees.add(keyOf(d.name, d.loc))
    for (const ref of this.refs) {
      const isEvalCallee = evalCallees.has(keyOf(ref.name, ref.loc))
      // Lexical bindings visible from the reference site always win, even
      // inside a `with` block (a shadowing var/let cannot be a property).
      const binding = this.lookup(ref.name, ref.scope)
      if (binding) { ref.binding = binding; continue }
      // Unresolved inside a `with` scope: may resolve to a runtime property.
      let ws = ref.scope
      while (ws && ws.kind !== 'with') ws = ws.parent
      if (ws) { ref.unknown = true; ref.reasons.push('with'); continue }
      // Direct eval can inject bindings into a non-strict enclosing function.
      if (!isEvalCallee && this.enclosingTaintedScope(ref.scope)) {
        ref.unknown = true
        ref.reasons.push('direct-eval')
        continue
      }
      // The eval callee itself is still an ordinary (global) reference;
      // the call site is additionally listed under `dynamicEval`.
      if (!this.globals.has(ref.name)) ref.free = true
      void isEvalCallee
    }
  }

  _markDirectEvals() {
    const refScope = new Map()
    for (const r of this.refs)
      refScope.set(`${r.name}@${r.loc ? r.loc.start.offset : -1}`, r)
    const visit = node => {
      if (!node || typeof node.type !== "string") return
      if ((node.type === "CallExpression" || node.type === "OptionalCallExpression") &&
          node.callee && node.callee.type === "Identifier" &&
          node.callee.name === "eval") {
        const r = refScope.get(`eval@${node.callee.start}`)
        if (r && !this.lookup("eval", r.scope)) {
          // Unshadowed eval -> direct eval. Only non-strict direct eval can
          // add bindings to the enclosing scope.
          if (!this._isStrictChain(r.scope)) {
            const fn = this.enclosingVarScope(r.scope)
            if (fn) {
              fn.taintedByEval = true
              this.directEvals.push({
                name: "eval", loc: locOf(node.callee),
                scope: r.scope, taintedScope: fn
              })
            }
          }
        }
      }
      for (const key of Object.keys(node)) {
        if (["type","start","end","loc","range","raw","comments"].includes(key)) continue
        const v = node[key]
        if (Array.isArray(v)) {
          for (const it of v) if (it && typeof it.type === "string") visit(it)
        } else if (v && typeof v.type === "string") visit(v)
      }
    }
    visit(this.ast)
  }

  _isStrictChain(scope) {
    for (let s = scope; s; s = s.parent) if (s.strict) return true
    return false
  }

  enclosingVarScope(scope) {
    let s = scope
    while (s && s.kind !== "function" && s.kind !== "root") s = s.parent
    return s
  }

  enclosingTaintedScope(scope) {
    for (let s = scope; s; s = s.parent) {
      if (s.strict) return null
      if (s.taintedByEval) return s
    }
    return null
  }

  lookup(name, scope) {
    for (let s = scope; s; s = s.parent) {
      if (s.nfeName && s.nfeName.name === name) {
        const owner = s.kind === "params" ? s : (s.params || s)
        if (!owner._nfeBinding)
          owner._nfeBinding = {
            name, kind: "function-name", scope: owner,
            loc: locOf(owner.nfeName.node), nodes: [owner.nfeName.node], implicit: false
          }
        return owner._nfeBinding
      }
      const b = s.bindings.get(name)
      if (b) return b
    }
    return null
  }

  _scopeRef(s) {
    return s ? {id: s.id, kind: s.kind} : null
  }

  buildReport() {
    const bindingView = b => this.scopeView(b)
    const bindings = []
    const emitted = new Set()
    const pushBinding = b => {
      if (emitted.has(b)) return
      emitted.add(b)
      bindings.push({
        name: b.name,
        kind: b.kind,
        implicit: !!b.implicit,
        scope: this._scopeRef(b.scope),
        loc: b.loc,
        references: this.refs
          .filter(r => r.binding === b)
          .map(r => r.loc)
          .filter(Boolean)
      })
    }
    for (const scope of this.scopes) {
      for (const b of scope.bindings.values()) pushBinding(b)
      if (scope._nfeBinding) pushBinding(scope._nfeBinding)
    }
    void bindingView

    const references = this.refs.map(r => ({
      name: r.name,
      loc: r.loc,
      assignmentTarget: r.assignmentTarget,
      resolved: r.binding
        ? {name: r.binding.name, kind: r.binding.kind, scope: this._scopeRef(r.binding.scope)}
        : null,
      free: r.free,
      unknown: r.unknown,
      reasons: r.reasons
    }))

    return {
      sourceType: this.sourceType,
      scopes: this.scopes.map(s => ({
        id: s.id,
        kind: s.kind,
        parent: s.parent ? s.parent.id : null,
        strict: s.strict,
        loc: locOf(s.node),
        bindings: [...s.bindings.keys()],
        taintedByDirectEval: s.taintedByEval
      })),
      bindings,
      references,
      freeVariables: references
        .filter(r => r.free)
        .map(r => ({name: r.name, loc: r.loc, assignmentTarget: r.assignmentTarget})),
      unknown: references
        .filter(r => r.unknown)
        .map(r => ({name: r.name, loc: r.loc, reasons: r.reasons})),
      dynamicEval: this.directEvals.map(d => ({
        name: d.name,
        loc: d.loc,
        scope: this._scopeRef(d.scope),
        taintedScope: this._scopeRef(d.taintedScope)
      }))
    }
  }
}

/**
 * Analyze source code; return the report object.
 * options: { sourceType: "script"|"module", ecmaVersion, globals: string[] }
 */
export function analyze(code, options) {
  return new Analyzer(code, options).analyze()
}

/** Parse with acorn and analyze; the AST returned is never mutated. */
export function analyzeWithAst(code, options) {
  const a = new Analyzer(code, options)
  const ast = a.parse()
  const report = a.analyze()
  return {ast, report}
}

export {Analyzer}
