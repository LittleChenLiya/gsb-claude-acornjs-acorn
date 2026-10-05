// Free variable analysis built on top of Acorn.
//
// Resolves identifier references against the real binding structure of the
// program: function scopes (including parameters and `arguments`), block
// scopes (let/const/for), catch scopes, class scopes and the top-level
// global/module scope. Member property names (`obj.x`) and object literal
// keys (`{x: 1}`) are never treated as variables; references in destructuring
// defaults (`{a = y}`) and computed keys (`obj[k]`, `{[k]: v}`) are counted.
//
// `with` statements and dynamic `eval` calls are reported as unknowns: their
// effect on binding resolution cannot be decided statically, so the analysis
// does not pretend to be complete.
//
// The input AST is never mutated and no code is executed.

import * as acorn from "../../acorn/src/index.js"

let nextScopeId = 1

function createScope(type, parent, node, owner = null, extra = {}) {
  return {
    id: nextScopeId++,
    type,
    parent,
    node,
    owner: owner || (parent ? parent.owner : null),
    bindings: new Map(),
    references: [],
    unknowns: [],
    tainted: false,
    ...extra
  }
}

function locOf(node) {
  if (node.loc) {
    return {
      start: {line: node.loc.start.line, column: node.loc.start.column},
      end: {line: node.loc.end.line, column: node.loc.end.column}
    }
  }
  return null
}

function bind(scope, name, kind, node, extra = {}) {
  let list = scope.bindings.get(name)
  if (!list) {
    list = []
    scope.bindings.set(name, list)
  }
  list.push({name, kind, loc: locOf(node), start: node.start, end: node.end, node, ...extra})
}

// The scope that hosts `var` hoisting: functions (and the top level).
function varScopeOf(scope) {
  let s = scope
  while (s && s.type !== "function" && s.type !== "global" &&
         s.type !== "module" && s.type !== "static-block") {
    s = s.parent
  }
  return s || scope
}

export function analyzeAst(ast, options = {}) {
  nextScopeId = 1
  const scopes = []
  const unknowns = []
  const globals = new Set(
    options.globals
      ? (Array.isArray(options.globals) ? options.globals : Object.keys(options.globals))
      : []
  )
  // References are recorded during the walk and resolved afterwards: bindings
  // are a property of the whole scope (hoisting/TDZ), not of execution order.
  const pendingRefs = []
  const evalCandidates = []

  function registerScope(scope) {
    scopes.push(scope)
    return scope
  }

  function resolve(name, scope) {
    let s = scope
    while (s) {
      if (s.tainted) return {type: "unknown", scope: null, binding: null}
      const binding = s.bindings.get(name)
      if (binding) {
        return {
          type: s === scope ? "local" : "outer",
          scope: s,
          binding: binding[binding.length - 1]
        }
      }
      s = s.parent
    }
    if (globals.has(name)) return {type: "global", scope: null, binding: null, predefined: true}
    return {type: "global", scope: null, binding: null}
  }

  function addReference(name, node, scope) {
    const ref = {name, node, scope, loc: locOf(node), start: node.start, end: node.end, resolution: null}
    scope.references.push(ref)
    pendingRefs.push(ref)
    return ref
  }

  function addUnknown(kind, node, scope) {
    const entry = {kind, loc: locOf(node), start: node.start, end: node.end}
    scope.unknowns.push(entry)
    unknowns.push({...entry, scopeId: scope.id})
  }

  // Walk a binding/assignment pattern. When `asBinding` is true the pattern
  // introduces bindings (declarations, parameters, catch); otherwise it is an
  // assignment target whose identifiers are references.
  function walkPattern(node, scope, asBinding, kind = "binding") {
    if (!node || typeof node.type !== "string") return
    switch (node.type) {
    case "Identifier":
      if (asBinding) bind(scope, node.name, kind, node)
      else addReference(node.name, node, scope)
      return
    case "ObjectPattern":
      for (const prop of node.properties) {
        if (prop.type === "RestElement") {
          walkPattern(prop.argument, scope, asBinding, kind)
        } else {
          if (prop.computed) {
            if (prop.key.type === "Identifier") addReference(prop.key.name, prop.key, scope)
            else walkExpr(prop.key, scope)
          }
          walkPattern(prop.value, scope, asBinding, kind)
        }
      }
      return
    case "ArrayPattern":
      for (const el of node.elements) {
        if (el) walkPattern(el, scope, asBinding, kind)
      }
      return
    case "RestElement":
      walkPattern(node.argument, scope, asBinding, kind)
      return
    case "AssignmentPattern":
      walkPattern(node.left, scope, asBinding, kind)
      walkExpr(node.right, scope)
      return
    case "MemberExpression":
      walkExpr(node, scope)
      return
    default:
      walkNode(node, scope)
    }
  }

  function walkVarDeclaration(node, scope) {
    const target = node.kind === "var" ? varScopeOf(scope) : scope
    for (const decl of node.declarations) {
      if (decl.id) {
        if (decl.id.type === "Identifier") bind(target, decl.id.name, node.kind, decl.id)
        else walkPattern(decl.id, target, true, node.kind)
      }
      if (decl.init) walkExpr(decl.init, scope)
    }
  }

  function walkFunction(node, parentScope, nameOverride) {
    const fnScope = registerScope(createScope("function", parentScope, node))
    const isArrow = node.type === "ArrowFunctionExpression"
    if (!isArrow) bind(fnScope, "arguments", "arguments", node, {implicit: true})

    const selfName = nameOverride || (node.id && node.id.name)
    if (selfName) bind(fnScope, selfName, "function-self", node.id || node)

    const paramsScope = registerScope(createScope("params", fnScope, node, fnScope))
    for (const param of node.params) walkPattern(param, paramsScope, true, "param")

    if (node.body.type === "BlockStatement") {
      const bodyScope = registerScope(createScope("block", paramsScope, node.body, fnScope))
      for (const stmt of node.body.body) walkNode(stmt, bodyScope)
    } else {
      walkExpr(node.body, paramsScope)
    }
    return fnScope
  }

  function walkClass(node, scope, isDeclaration) {
    if (isDeclaration && node.id) bind(scope, node.id.name, "class", node.id)
    const classScope = registerScope(createScope("class", scope, node))
    if (node.id) bind(classScope, node.id.name, "class-self", node.id)
    if (node.superClass) walkExpr(node.superClass, scope)

    for (const member of node.body.body) {
      if (member.type === "MethodDefinition") {
        if (member.computed) {
          if (member.key.type === "Identifier") addReference(member.key.name, member.key, scope)
          else walkExpr(member.key, scope)
        }
        walkFunction(member.value, classScope)
      } else if (member.type === "PropertyDefinition") {
        if (member.computed) {
          if (member.key.type === "Identifier") addReference(member.key.name, member.key, scope)
          else walkExpr(member.key, scope)
        }
        if (member.value) {
          const fieldScope = registerScope(createScope("field", classScope, member, classScope))
          walkExpr(member.value, fieldScope)
        }
      } else if (member.type === "StaticBlock") {
        const staticScope = registerScope(createScope("static-block", classScope, member, classScope))
        for (const stmt of member.body) walkNode(stmt, staticScope)
      }
    }
  }

  function walkBlock(node, scope) {
    const blockScope = registerScope(createScope("block", scope, node))
    for (const stmt of node.body) walkNode(stmt, blockScope)
  }

  function walkFor(node, scope) {
    const forScope = registerScope(createScope("for", scope, node))
    if (node.init) {
      if (node.init.type === "VariableDeclaration") walkVarDeclaration(node.init, forScope)
      else walkExpr(node.init, forScope)
    }
    if (node.test) walkExpr(node.test, forScope)
    if (node.update) walkExpr(node.update, forScope)
    walkBody(node.body, forScope)
  }

  function walkForInOf(node, scope) {
    const forScope = registerScope(createScope("for", scope, node))
    if (node.left.type === "VariableDeclaration") walkVarDeclaration(node.left, forScope)
    else walkPattern(node.left, forScope, false)
    walkExpr(node.right, forScope)
    walkBody(node.body, forScope)
  }

  function walkBody(body, scope) {
    if (body.type === "BlockStatement") walkBlock(body, scope)
    else walkNode(body, scope)
  }

  function walkSwitch(node, scope) {
    const switchScope = registerScope(createScope("block", scope, node))
    walkNode(node.discriminant, scope)
    for (const c of node.cases) {
      if (c.test) walkExpr(c.test, switchScope)
      for (const stmt of c.consequent) walkNode(stmt, switchScope)
    }
  }

  function walkCatch(node, scope) {
    const catchScope = registerScope(createScope("catch", scope, node))
    if (node.param) walkPattern(node.param, catchScope, true, "catch")
    walkBody(node.body, catchScope)
  }

  function walkWith(node, scope) {
    addUnknown("with", node, scope)
    const withScope = registerScope(createScope("with", scope, node, null, {tainted: true}))
    walkBody(node.body, withScope)
  }

  function walkImport(node, scope) {
    for (const spec of node.specifiers) {
      if (spec.local) bind(scope, spec.local.name, "import", spec.local)
    }
  }

  function walkExportNamed(node, scope) {
    if (node.declaration) {
      if (node.declaration.type === "VariableDeclaration") walkVarDeclaration(node.declaration, scope)
      else walkNode(node.declaration, scope)
    }
    for (const spec of node.specifiers) {
      if (spec.local) addReference(spec.local.name, spec.local, scope)
    }
  }

  function walkExportDefault(node, scope) {
    if (node.declaration.type === "Identifier") addReference(node.declaration.name, node.declaration, scope)
    else walkNode(node.declaration, scope)
  }

  function walkNode(node, scope) {
    if (!node || typeof node.type !== "string") return
    switch (node.type) {
    case "BlockStatement": walkBlock(node, scope); return
    case "VariableDeclaration": walkVarDeclaration(node, scope); return
    case "FunctionDeclaration":
      if (node.id) bind(scope, node.id.name, "function", node.id)
      walkFunction(node, scope, node.id ? node.id.name : null)
      return
    case "ClassDeclaration": walkClass(node, scope, true); return
    case "ForStatement": walkFor(node, scope); return
    case "ForInStatement":
    case "ForOfStatement": walkForInOf(node, scope); return
    case "SwitchStatement": walkSwitch(node, scope); return
    case "CatchClause": walkCatch(node, scope); return
    case "WithStatement": walkWith(node, scope); return
    case "ImportDeclaration": walkImport(node, scope); return
    case "ExportNamedDeclaration": walkExportNamed(node, scope); return
    case "ExportDefaultDeclaration": walkExportDefault(node, scope); return
    case "ExportAllDeclaration": return
    case "LabeledStatement": walkNode(node.body, scope); return
    case "BreakStatement":
    case "ContinueStatement": return
    case "EmptyStatement": return
    default:
      walkExpr(node, scope)
    }
  }

  function walkProperty(node, scope) {
    if (node.computed) {
      if (node.key.type === "Identifier") addReference(node.key.name, node.key, scope)
      else walkExpr(node.key, scope)
    }
    walkExpr(node.value, scope)
  }

  function walkMember(node, scope) {
    walkExpr(node.object, scope)
    if (node.computed) {
      if (node.property.type === "Identifier") addReference(node.property.name, node.property, scope)
      else walkExpr(node.property, scope)
    }
    // Non-computed member names (`obj.x`) are never variables.
  }

  function walkCall(node, scope) {
    walkExpr(node.callee, scope)
    if (node.callee.type === "Identifier" && node.callee.name === "eval") {
      evalCandidates.push({node, scope})
    }
    for (const arg of node.arguments) walkExpr(arg, scope)
  }

  function walkAssignment(node, scope) {
    walkPattern(node.left, scope, false)
    walkExpr(node.right, scope)
  }

  function walkExpr(node, scope) {
    if (!node || typeof node.type !== "string") return
    switch (node.type) {
    case "Identifier":
      addReference(node.name, node, scope)
      return
    case "MemberExpression": walkMember(node, scope); return
    case "Property": walkProperty(node, scope); return
    case "AssignmentExpression": walkAssignment(node, scope); return
    case "UpdateExpression":
      if (node.argument.type === "Identifier") addReference(node.argument.name, node.argument, scope)
      else walkExpr(node.argument, scope)
      return
    case "CallExpression":
    case "NewExpression": walkCall(node, scope); return
    case "FunctionExpression":
    case "ArrowFunctionExpression": walkFunction(node, scope); return
    case "ClassExpression": walkClass(node, scope, false); return
    case "ObjectPattern":
    case "ArrayPattern":
    case "RestElement":
    case "AssignmentPattern":
      walkPattern(node, scope, false)
      return
    case "Literal":
    case "ThisExpression":
    case "Super":
    case "MetaProperty":
    case "TemplateElement":
      return
    default:
      walkChildren(node, scope)
    }
  }

  function walkChildren(node, scope) {
    for (const key in node) {
      if (key === "loc" || key === "start" || key === "end" || key === "range") continue
      const value = node[key]
      if (Array.isArray(value)) {
        for (const child of value) {
          if (child && typeof child.type === "string") {
            if (isStatementLike(child)) walkNode(child, scope)
            else walkExpr(child, scope)
          }
        }
      } else if (value && typeof value.type === "string") {
        if (isStatementLike(value)) walkNode(value, scope)
        else walkExpr(value, scope)
      }
    }
  }

  function isStatementLike(node) {
    return node.type === "VariableDeclaration" || node.type === "FunctionDeclaration" ||
           node.type === "ClassDeclaration" || node.type === "BlockStatement" ||
           node.type === "ForStatement" || node.type === "ForInStatement" ||
           node.type === "ForOfStatement" || node.type === "SwitchStatement" ||
           node.type === "CatchClause" || node.type === "WithStatement" ||
           node.type === "ImportDeclaration" || node.type === "ExportNamedDeclaration" ||
           node.type === "ExportDefaultDeclaration" || node.type === "ExportAllDeclaration" ||
           node.type === "LabeledStatement" || node.type === "StaticBlock"
  }

  const topType = ast.sourceType === "module" ? "module" : "global"
  const topScope = registerScope(createScope(topType, null, ast, null))
  topScope.owner = topScope
  for (const stmt of ast.body) walkNode(stmt, topScope)

  // Resolve all recorded references now that every binding is in place.
  for (const ref of pendingRefs) {
    ref.resolution = resolve(ref.name, ref.scope)
  }
  for (const candidate of evalCandidates) {
    const resolution = resolve("eval", candidate.scope)
    if (resolution.type === "global") addUnknown("eval", candidate.node, candidate.scope)
  }

  function isFreeIn(ref, fnScope) {
    if (ref.resolution.type === "global") return !ref.resolution.predefined
    if (ref.resolution.type !== "outer") return false
    // `outer` means: bound in an ancestor scope of the reference's scope.
    // It is free in fnScope only when the binding lives above fnScope.
    let s = ref.resolution.scope
    while (s) {
      if (s === fnScope) return false
      s = s.parent
    }
    return true
  }

  const functions = []
  for (const scope of scopes) {
    if (scope.type !== "function") continue
    const freeVars = []
    for (const s of scopes) {
      if (s.owner !== scope) continue
      for (const ref of s.references) {
        if (isFreeIn(ref, scope)) {
          freeVars.push({
            name: ref.name,
            loc: ref.loc,
            start: ref.start,
            end: ref.end,
            resolution: ref.resolution
          })
        }
      }
    }
    functions.push({
      scopeId: scope.id,
      name: scope.node.id ? scope.node.id.name : null,
      loc: locOf(scope.node),
      freeVars
    })
  }

  const topGlobals = []
  for (const ref of topScope.references) {
    if (ref.resolution.type === "global") {
      topGlobals.push({
        name: ref.name,
        loc: ref.loc,
        start: ref.start,
        end: ref.end,
        predefined: !!ref.resolution.predefined
      })
    }
  }

  return {
    scopes: scopes.map(s => ({
      id: s.id,
      type: s.type,
      ownerId: s.owner ? s.owner.id : null,
      loc: locOf(s.node),
      bindings: [...s.bindings.values()].flat().map(b => ({
        name: b.name,
        kind: b.kind,
        loc: b.loc,
        start: b.start,
        end: b.end,
        implicit: !!b.implicit
      })),
      references: s.references.map(r => ({
        name: r.name,
        loc: r.loc,
        start: r.start,
        end: r.end,
        resolution: r.resolution.type,
        bindingKind: r.resolution.binding ? r.resolution.binding.kind : null,
        bindingLoc: r.resolution.binding ? r.resolution.binding.loc : null,
        predefined: !!r.resolution.predefined
      })),
      unknowns: s.unknowns.map(u => ({kind: u.kind, loc: u.loc, start: u.start, end: u.end}))
    })),
    functions,
    topGlobals,
    unknowns
  }
}

export function analyze(code, options = {}) {
  const parseOptions = {
    ecmaVersion: options.ecmaVersion || "latest",
    sourceType: options.sourceType || "script",
    locations: true,
    allowHashBang: true,
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
    allowImportExportEverywhere: true,
    ...options.parseOptions
  }
  const ast = acorn.parse(code, parseOptions)
  return analyzeAst(ast, {globals: options.globals})
}

export {acorn}
