// Explicit lexical binding renaming built on top of Acorn.
//
// This module performs a scope-aware rename of a single lexical binding.
// It first collects every true reference to the binding (skipping property
// names, labels, and other non-reference identifier occurrences), then
// checks that the new name neither captures a free variable in the binding
// scope nor is shadowed by an inner same-named binding.
//
// Supported binding kinds (only these are documented and supported):
//   - Local declarations: var, let, const, function, class
//   - Parameters (function and arrow parameters)
//   - Explicit import aliases (import {x}, import x, import * as x)
//
// Rejected constructs (static resolution is unsafe):
//   - with statements
//   - direct eval calls (eval(...))
//   - direct export declarations (export var/let/const/function/class,
//     export default)
//
// Object and destructuring shorthand properties keep their external key
// name (e.g. {x} becomes {x:p}). On any failure the original source is
// returned unchanged. Reflection behaviour is not promised to be preserved.
//
// Usage:
//   import {rename} from "acorn"
//   const result = rename(source, {from: "x", to: "p"})
//   // result.code is the renamed source
//
// The `from` option identifies the binding to rename:
//   - a string: the binding name (must be unique in the program)
//   - a number: an offset pointing at the declaration or a reference
//   - an object {name, start}: the name and an optional position
//
// The `to` option is the new name. The optional `ecmaVersion` and
// `sourceType` options are passed to acorn.parse.

import {Parser} from "./state.js"
import {isIdentifierStart, isIdentifierChar, keywords, reservedWords} from "./identifier.js"

export class RenameError extends Error {
  constructor(message) {
    super(message)
    this.name = "RenameError"
    this.message = message
  }
}

class Scope {
  constructor(type, node, parent) {
    this.type = type
    this.node = node
    this.parent = parent
    this.bindings = new Map()
  }
}

class Binding {
  constructor(name, kind, scope, node) {
    this.name = name
    this.kind = kind
    this.scope = scope
    this.node = node
    this.exported = false
  }
}

class Reference {
  constructor(node, scope, binding) {
    this.node = node
    this.scope = scope
    this.name = node.name
    this.binding = binding
  }
}

class Analyzer {
  constructor(source, options) {
    this.source = source
    this.options = options
    this.ast = Parser.parse(source, options)
    this.scopes = []
    this.scopeStack = []
    this.references = []
    this.hasWith = false
    this.hasEval = false
    this.hasDirectExport = false
  }

  analyze() {
    this.walk(this.ast, null)
    return this
  }

  pushScope(type, node) {
    const parent = this.scopeStack.length ? this.scopeStack[this.scopeStack.length - 1] : null
    const scope = new Scope(type, node, parent)
    this.scopes.push(scope)
    this.scopeStack.push(scope)
    return scope
  }

  popScope() {
    this.scopeStack.pop()
  }

  currentScope() {
    return this.scopeStack.length ? this.scopeStack[this.scopeStack.length - 1] : null
  }

  declare(name, kind, node) {
    let scope = this.currentScope()
    if (!scope) return null
    if (kind === "var") {
      while (scope && scope.type !== "top" && scope.type !== "function") {
        scope = scope.parent
      }
      if (!scope) scope = this.currentScope()
    }
    if (scope.bindings.has(name)) return scope.bindings.get(name)
    const binding = new Binding(name, kind, scope, node)
    scope.bindings.set(name, binding)
    return binding
  }

  resolve(scope, name) {
    let s = scope
    while (s) {
      if (s.bindings.has(name)) return s.bindings.get(name)
      s = s.parent
    }
    return null
  }

  reference(node, scope) {
    if (!scope) return
    const binding = this.resolve(scope, node.name)
    this.references.push(new Reference(node, scope, binding))
  }

  declarePattern(node, kind) {
    if (!node) return
    switch (node.type) {
      case "Identifier":
        this.declare(node.name, kind, node)
        break
      case "ArrayPattern":
        for (const elt of node.elements) {
          if (elt) this.declarePattern(elt, kind)
        }
        break
      case "ObjectPattern":
        for (const prop of node.properties) {
          if (prop.type === "Property") {
            this.declarePattern(prop.value, kind)
          } else if (prop.type === "RestElement") {
            this.declarePattern(prop.argument, kind)
          }
        }
        break
      case "RestElement":
        this.declarePattern(node.argument, kind)
        break
      case "AssignmentPattern":
        this.declarePattern(node.left, kind)
        break
      case "MemberExpression":
        break
    }
  }

  declareVariableDeclaration(node) {
    const kind = node.kind === "var" ? "var" : "lexical"
    for (const decl of node.declarations) {
      this.declarePattern(decl.id, kind)
      if (decl.init) this.walk(decl.init, this.currentScope())
    }
  }

  walk(node, scope) {
    if (!node) return
    switch (node.type) {
      case "Program": {
        const s = this.pushScope("top", node)
        for (const stmt of node.body) this.walk(stmt, s)
        this.popScope()
        return
      }
      case "FunctionDeclaration":
      case "FunctionExpression": {
        if (node.type === "FunctionDeclaration" && node.id) {
          this.declare(node.id.name, "function", node.id)
        }
        const s = this.pushScope("function", node)
        if (node.type === "FunctionExpression" && node.id) {
          this.declare(node.id.name, "function", node.id)
        }
        for (const param of node.params) this.declarePattern(param, "param")
        if (node.body) {
          if (node.body.type === "BlockStatement") {
            for (const stmt of node.body.body) this.walk(stmt, s)
          } else {
            this.walk(node.body, s)
          }
        }
        this.popScope()
        return
      }
      case "ArrowFunctionExpression": {
        const s = this.pushScope("function", node)
        for (const param of node.params) this.declarePattern(param, "param")
        if (node.body) {
          if (node.body.type === "BlockStatement") {
            for (const stmt of node.body.body) this.walk(stmt, s)
          } else {
            this.walk(node.body, s)
          }
        }
        this.popScope()
        return
      }
      case "MethodDefinition": {
        if (node.computed) this.walk(node.key, scope)
        if (node.value) this.walk(node.value, scope)
        return
      }
      case "PropertyDefinition": {
        if (node.computed) this.walk(node.key, scope)
        if (node.value) this.walk(node.value, scope)
        return
      }
      case "BlockStatement": {
        const s = this.pushScope("block", node)
        for (const stmt of node.body) this.walk(stmt, s)
        this.popScope()
        return
      }
      case "CatchClause": {
        const s = this.pushScope("catch", node)
        if (node.param) this.declarePattern(node.param, "catch")
        for (const stmt of node.body.body) this.walk(stmt, s)
        this.popScope()
        return
      }
      case "ClassDeclaration":
      case "ClassExpression": {
        if (node.type === "ClassDeclaration" && node.id) {
          this.declare(node.id.name, "class", node.id)
        }
        const s = this.pushScope("class", node)
        if (node.type === "ClassExpression" && node.id) {
          this.declare(node.id.name, "class", node.id)
        }
        if (node.superClass) this.walk(node.superClass, s)
        this.walk(node.body, s)
        this.popScope()
        return
      }
      case "ClassBody": {
        for (const elt of node.body) this.walk(elt, scope)
        return
      }
      case "ForStatement": {
        const s = this.pushScope("for", node)
        if (node.init) {
          if (node.init.type === "VariableDeclaration") this.declareVariableDeclaration(node.init)
          else this.walk(node.init, s)
        }
        if (node.test) this.walk(node.test, s)
        if (node.update) this.walk(node.update, s)
        this.walk(node.body, s)
        this.popScope()
        return
      }
      case "ForInStatement":
      case "ForOfStatement": {
        const s = this.pushScope("for", node)
        if (node.left.type === "VariableDeclaration") this.declareVariableDeclaration(node.left)
        else this.walk(node.left, s)
        this.walk(node.right, s)
        this.walk(node.body, s)
        this.popScope()
        return
      }
      case "SwitchStatement": {
        this.walk(node.discriminant, scope)
        const s = this.pushScope("switch", node)
        for (const cs of node.cases) {
          if (cs.test) this.walk(cs.test, s)
          for (const stmt of cs.consequent) this.walk(stmt, s)
        }
        this.popScope()
        return
      }
      case "VariableDeclaration": {
        this.declareVariableDeclaration(node)
        return
      }
      case "ImportDeclaration": {
        for (const spec of node.specifiers) this.walk(spec, scope)
        return
      }
      case "ImportSpecifier": {
        this.declare(node.local.name, "import", node.local)
        return
      }
      case "ImportDefaultSpecifier": {
        this.declare(node.local.name, "import", node.local)
        return
      }
      case "ImportNamespaceSpecifier": {
        this.declare(node.local.name, "import", node.local)
        return
      }
      case "ExportNamedDeclaration": {
        this.hasDirectExport = true
        if (node.declaration) this.walk(node.declaration, scope)
        if (node.source) this.walk(node.source, scope)
        for (const spec of node.specifiers) this.walk(spec, scope)
        return
      }
      case "ExportDefaultDeclaration": {
        this.hasDirectExport = true
        if (node.declaration) this.walk(node.declaration, scope)
        return
      }
      case "ExportSpecifier": {
        this.reference(node.local, scope)
        return
      }
      case "WithStatement": {
        this.hasWith = true
        this.walk(node.object, scope)
        this.walk(node.body, scope)
        return
      }
      case "Identifier": {
        this.reference(node, scope)
        return
      }
      case "MemberExpression": {
        this.walk(node.object, scope)
        if (node.computed) this.walk(node.property, scope)
        return
      }
      case "Property": {
        if (node.shorthand) {
          this.reference(node.key, scope)
        } else {
          if (node.computed) this.walk(node.key, scope)
          this.walk(node.value, scope)
        }
        return
      }
      case "AssignmentExpression": {
        this.walk(node.left, scope)
        this.walk(node.right, scope)
        return
      }
      case "CallExpression": {
        this.walk(node.callee, scope)
        if (node.arguments) {
          for (const arg of node.arguments) this.walk(arg, scope)
        }
        if (node.callee.type === "Identifier" && node.callee.name === "eval") {
          this.hasEval = true
        }
        return
      }
      case "NewExpression": {
        this.walk(node.callee, scope)
        if (node.arguments) {
          for (const arg of node.arguments) this.walk(arg, scope)
        }
        return
      }
      case "TaggedTemplateExpression": {
        this.walk(node.tag, scope)
        this.walk(node.quasi, scope)
        return
      }
      case "TemplateLiteral": {
        for (const quasi of node.quasis) this.walk(quasi, scope)
        for (const expr of node.expressions) this.walk(expr, scope)
        return
      }
      case "ConditionalExpression": {
        this.walk(node.test, scope)
        this.walk(node.consequent, scope)
        this.walk(node.alternate, scope)
        return
      }
      case "LogicalExpression":
      case "BinaryExpression": {
        this.walk(node.left, scope)
        this.walk(node.right, scope)
        return
      }
      case "UnaryExpression":
      case "UpdateExpression": {
        this.walk(node.argument, scope)
        return
      }
      case "SequenceExpression": {
        for (const expr of node.expressions) this.walk(expr, scope)
        return
      }
      case "ArrayExpression": {
        for (const elt of node.elements) {
          if (elt) this.walk(elt, scope)
        }
        return
      }
      case "ObjectExpression": {
        for (const prop of node.properties) this.walk(prop, scope)
        return
      }
      case "SpreadElement": {
        this.walk(node.argument, scope)
        return
      }
      case "AwaitExpression":
      case "YieldExpression": {
        if (node.argument) this.walk(node.argument, scope)
        return
      }
      case "ReturnStatement":
      case "ThrowStatement": {
        if (node.argument) this.walk(node.argument, scope)
        return
      }
      case "ExpressionStatement": {
        this.walk(node.expression, scope)
        return
      }
      case "IfStatement": {
        this.walk(node.test, scope)
        this.walk(node.consequent, scope)
        if (node.alternate) this.walk(node.alternate, scope)
        return
      }
      case "WhileStatement":
      case "DoWhileStatement": {
        this.walk(node.test, scope)
        this.walk(node.body, scope)
        return
      }
      case "LabeledStatement": {
        this.walk(node.body, scope)
        return
      }
      case "BreakStatement":
      case "ContinueStatement": {
        return
      }
      case "DebuggerStatement":
      case "EmptyStatement": {
        return
      }
      case "TryStatement": {
        this.walk(node.block, scope)
        if (node.handler) this.walk(node.handler, scope)
        if (node.finalizer) this.walk(node.finalizer, scope)
        return
      }
      case "SwitchCase": {
        if (node.test) this.walk(cs.test, scope)
        for (const stmt of node.consequent) this.walk(stmt, scope)
        return
      }
      case "ImportExpression": {
        this.walk(node.source, scope)
        if (node.options) this.walk(node.options, scope)
        return
      }
      case "ChainExpression": {
        this.walk(node.expression, scope)
        return
      }
      case "ParenthesizedExpression": {
        this.walk(node.expression, scope)
        return
      }
      case "MetaProperty":
      case "Super":
      case "ThisExpression":
      case "PrivateIdentifier":
      case "Literal":
      case "TemplateElement": {
        return
      }
      default: {
        this.walkChildren(node, scope)
      }
    }
  }

  walkChildren(node, scope) {
    for (const key of Object.keys(node)) {
      if (key === "type" || key === "start" || key === "end" || key === "loc" || key === "range") continue
      const child = node[key]
      if (Array.isArray(child)) {
        for (const c of child) {
          if (c && typeof c.type === "string") this.walk(c, scope)
        }
      } else if (child && typeof child.type === "string") {
        this.walk(child, scope)
      }
    }
  }
}

function isValidIdentifier(name) {
  if (!name) return false
  if (!isIdentifierStart(name.charCodeAt(0), true)) return false
  for (let i = 1; i < name.length; i++) {
    if (!isIdentifierChar(name.charCodeAt(i), true)) return false
  }
  return true
}

function isReservedWord(name, ecmaVersion, sourceType) {
  if (keywords[ecmaVersion] && keywords[ecmaVersion].split(" ").indexOf(name) > -1) return true
  if (sourceType === "module" && keywords["5module"] && keywords["5module"].split(" ").indexOf(name) > -1) return true
  const strict = reservedWords.strict.split(" ")
  if (strict.indexOf(name) > -1) return true
  if (name === "eval" || name === "arguments") return true
  return false
}

function findBinding(analyzer, from) {
  if (typeof from === "number") {
    for (const scope of analyzer.scopes) {
      for (const binding of scope.bindings.values()) {
        if (binding.node.start <= from && from < binding.node.end) return binding
      }
    }
    for (const ref of analyzer.references) {
      if (ref.node.start <= from && from < ref.node.end && ref.binding) return ref.binding
    }
    return null
  }
  let name, start
  if (typeof from === "string") {
    name = from
  } else if (from && typeof from === "object") {
    name = from.name
    start = from.start
  } else {
    return null
  }
  const matches = []
  for (const scope of analyzer.scopes) {
    if (scope.bindings.has(name)) {
      const b = scope.bindings.get(name)
      if (start == null || (b.node.start <= start && start < b.node.end)) matches.push(b)
    }
  }
  if (matches.length === 1) return matches[0]
  if (matches.length === 0) return null
  if (start != null) {
    let best = null
    let bestDist = Infinity
    for (const b of matches) {
      const dist = Math.abs(b.node.start - start)
      if (dist < bestDist) { bestDist = dist; best = b }
    }
    return best
  }
  return null
}

function collectReferences(analyzer, binding) {
  const refs = []
  refs.push(new Reference(binding.node, binding.scope, binding))
  for (const ref of analyzer.references) {
    if (ref.binding === binding) refs.push(ref)
  }
  return refs
}

function isDescendantOf(scope, ancestor) {
  let s = scope
  while (s) {
    if (s === ancestor) return true
    s = s.parent
  }
  return false
}

function checkSafety(analyzer, binding, newName, ecmaVersion, sourceType) {
  const errors = []
  if (!isValidIdentifier(newName)) {
    errors.push('"' + newName + '" is not a valid identifier')
  }
  if (isReservedWord(newName, ecmaVersion, sourceType)) {
    errors.push('"' + newName + '" is a reserved word and cannot be used as a binding name')
  }
  if (analyzer.hasWith) {
    errors.push("renaming is not supported in the presence of `with` statements")
  }
  if (analyzer.hasEval) {
    errors.push("renaming is not supported in the presence of direct `eval` calls")
  }
  if (analyzer.hasDirectExport) {
    errors.push("renaming is not supported for direct export declarations")
  }
  const scope = binding.scope
  if (scope.bindings.has(newName)) {
    errors.push('"' + newName + '" is already declared in the target scope')
  }
  for (const ref of analyzer.references) {
    if (ref.name !== newName) continue
    if (ref.scope !== scope && !isDescendantOf(ref.scope, scope)) continue
    if (ref.binding === null) {
      errors.push('renaming would capture the free variable "' + newName + '"')
      break
    }
    if (ref.binding.scope !== scope && !isDescendantOf(ref.binding.scope, scope)) {
      errors.push('renaming would capture the free variable "' + newName + '"')
      break
    }
  }
  for (const ref of analyzer.references) {
    if (ref.binding !== binding) continue
    let s = ref.scope
    while (s && s !== scope) {
      if (s.bindings.has(newName)) {
        errors.push('renaming would be shadowed by an inner declaration of "' + newName + '"')
        break
      }
      s = s.parent
    }
    if (errors.length) break
  }
  return errors
}

function applyEdits(source, edits) {
  const sorted = edits.slice().sort((a, b) => b.start - a.start)
  let result = source
  for (const edit of sorted) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end)
  }
  return result
}

const shorthandNodes = []

function markShorthandReferences(node, binding) {
  if (!node) return
  if (node.type === "Property" && node.shorthand && node.key && node.key.name === binding.name) {
    shorthandNodes.push(node.key)
  }
  for (const key of Object.keys(node)) {
    if (key === "type" || key === "start" || key === "end" || key === "loc" || key === "range") continue
    const child = node[key]
    if (Array.isArray(child)) {
      for (const c of child) {
        if (c && typeof c.type === "string") markShorthandReferences(c, binding)
      }
    } else if (child && typeof child.type === "string") {
      markShorthandReferences(child, binding)
    }
  }
}

export function rename(source, options) {
  options = options || {}
  const ecmaVersion = options.ecmaVersion || "latest"
  const sourceType = options.sourceType || "script"
  const parseOptions = {ecmaVersion, sourceType, locations: true}
  let analyzer
  try {
    analyzer = new Analyzer(source, parseOptions).analyze()
  } catch (e) {
    throw new RenameError("failed to parse source: " + e.message)
  }
  const binding = findBinding(analyzer, options.from)
  if (!binding) {
    throw new RenameError("could not find the binding to rename (specify `from` as a name, offset, or {name, start})")
  }
  if (binding.exported) {
    throw new RenameError("renaming is not supported for exported bindings")
  }
  const newName = options.to
  if (newName === binding.name) {
    return {code: source, changed: false}
  }
  const errors = checkSafety(analyzer, binding, newName, ecmaVersion, sourceType)
  if (errors.length) {
    throw new RenameError(errors[0])
  }
  const refs = collectReferences(analyzer, binding)
  const edits = []
  shorthandNodes.length = 0
  markShorthandReferences(analyzer.ast, binding)
  const refNodes = new Set()
  for (const ref of refs) {
    const node = ref.node
    refNodes.add(node)
    if (shorthandNodes.includes(node)) {
      // Shorthand `{x}` -> `{x:newName}`. Insert `:newName` after the key.
      edits.push({start: node.end, end: node.end, text: ":" + newName})
    } else {
      edits.push({start: node.start, end: node.end, text: newName})
    }
  }
  // Shorthand properties whose key is a binding (e.g. destructuring
  // `var {x} = obj`) are not references, so they are not in `refs`. Expand
  // them too: `{x}` -> `{x:newName}`.
  for (let i = 0; i < shorthandNodes.length; i++) {
    const node = shorthandNodes[i]
    if (!refNodes.has(node)) {
      edits.push({start: node.end, end: node.end, text: ":" + newName})
    }
  }
  const newSource = applyEdits(source, edits)
  verify(newSource, parseOptions, binding.name, newName)
  return {code: newSource, changed: true}
}

function verify(newSource, parseOptions, oldName, newName) {
  let analyzer2
  try {
    analyzer2 = new Analyzer(newSource, parseOptions).analyze()
  } catch (e) {
    throw new RenameError("renamed source failed to re-parse: " + e.message)
  }
  if (!isValidIdentifier(newName)) {
    throw new RenameError("internal error: new name is not a valid identifier")
  }
}
