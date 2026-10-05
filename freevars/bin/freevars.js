#!/usr/bin/env node
"use strict"

import {readFileSync} from "fs"
import {basename} from "path"
import {analyze} from "../src/index.js"

function help(status) {
  const print = status === 0 ? console.log : console.error
  print("usage: " + basename(process.argv[1]) + " [--json] [--module] [--ecmaVersion N] [--globals a,b] [--help] [--] <file>...")
  print("")
  print("Free variable analysis for JavaScript, built on Acorn.")
  print("Resolves bindings by function, parameter, block and catch scopes.")
  print("Member names and object keys are not variables; references in")
  print("destructuring defaults and computed keys are counted; `with` and")
  print("dynamic `eval` are reported as unknowns.")
  process.exit(status)
}

const filePaths = []
let asJson = false
let sourceType = "script"
let ecmaVersion = "latest"
let globals = []

for (let i = 2; i < process.argv.length; ++i) {
  const arg = process.argv[i]
  if (arg[0] !== "-" || arg === "-") filePaths.push(arg)
  else if (arg === "--") {
    filePaths.push(...process.argv.slice(i + 1))
    break
  } else if (arg === "--json") asJson = true
  else if (arg === "--module") sourceType = "module"
  else if (arg === "--ecmaVersion" || arg === "--ecma") ecmaVersion = process.argv[++i]
  else if (arg === "--globals") globals = process.argv[++i].split(",").map(s => s.trim()).filter(Boolean)
  else if (arg === "--help" || arg === "-h") help(0)
  else help(1)
}

if (filePaths.length === 0) help(1)

function loc(l) {
  if (!l) return "?:?"
  return l.start.line + ":" + l.start.column
}

function printReport(file, result) {
  if (asJson) {
    console.log(JSON.stringify({file, ...result}, null, 2))
    return
  }
  console.log("free variable analysis: " + file)
  console.log("")
  for (const s of result.scopes) {
    const owner = s.ownerId ? " owner=" + s.ownerId : ""
    console.log("scope #" + s.id + " " + s.type + " (" + loc(s.loc) + ")" + owner)
    if (s.bindings.length) {
      console.log("  bindings:")
      for (const b of s.bindings) {
        console.log("    " + b.name + "  " + b.kind + (b.implicit ? " (implicit)" : "") + "  " + loc(b.loc))
      }
    }
    if (s.references.length) {
      console.log("  references:")
      for (const r of s.references) {
        const extra = r.bindingLoc ? " -> binding " + loc(r.bindingLoc) : ""
        console.log("    " + r.name + "  " + r.resolution + (r.predefined ? " (predefined global)" : "") + extra + "  " + loc(r.loc))
      }
    }
    if (s.unknowns.length) {
      console.log("  unknowns:")
      for (const u of s.unknowns) console.log("    " + u.kind + "  " + loc(u.loc))
    }
  }
  console.log("")
  for (const f of result.functions) {
    console.log("function " + (f.name || "(anonymous)") + " scope #" + f.scopeId + " (" + loc(f.loc) + ")")
    if (f.freeVars.length === 0) console.log("  free variables: (none)")
    else {
      console.log("  free variables:")
      for (const v of f.freeVars) {
        console.log("    " + v.name + "  " + v.resolution.type + "  " + loc(v.loc))
      }
    }
  }
  if (result.topGlobals.length) {
    console.log("")
    console.log("top-level globals (unresolved):")
    for (const g of result.topGlobals) {
      console.log("  " + g.name + (g.predefined ? " (predefined)" : "") + "  " + loc(g.loc))
    }
  }
  if (result.unknowns.length) {
    console.log("")
    console.log("unknowns (analysis may be incomplete):")
    for (const u of result.unknowns) {
      console.log("  " + u.kind + "  scope #" + u.scopeId + "  " + loc(u.loc))
    }
  }
}

let failed = false
for (const file of filePaths) {
  try {
    const code = readFileSync(file, "utf8")
    const result = analyze(code, {sourceType, ecmaVersion, globals})
    printReport(file, result)
  } catch (e) {
    console.error("error analyzing " + file + ": " + e.message)
    failed = true
  }
}
process.exit(failed ? 1 : 0)
