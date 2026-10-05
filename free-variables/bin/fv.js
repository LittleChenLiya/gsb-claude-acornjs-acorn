#!/usr/bin/env node
// CLI for the Acorn-based free-variable analyzer.
//
//   node free-variables/bin/fv.js [options] [file.js ...]
//
// Reads stdin when no file is given. Prints a JSON report by default;
// --summary prints a compact human-readable listing with source locations.

import {readFileSync} from "node:fs"
import {analyze} from "../src/index.js"

function parseArgs(argv) {
  const opts = {files: [], globals: [], summary: false, compact: false,
                sourceType: null, help: false}
  for (const arg of argv) {
    if (arg === "--summary") opts.summary = true
    else if (arg === "--compact") opts.compact = true
    else if (arg === "--module") opts.sourceType = "module"
    else if (arg === "--script") opts.sourceType = "script"
    else if (arg === "--help" || arg === "-h") opts.help = true
    else if (arg.startsWith("--globals="))
      opts.globals.push(...arg.slice(10).split(",").map(s => s.trim()).filter(Boolean))
    else opts.files.push(arg)
  }
  return opts
}

const HELP = `Free-variable analysis (Acorn-based)

Usage:
  node free-variables/bin/fv.js [options] [file ...]
  cat file.js | node free-variables/bin/fv.js [options]

Options:
  --summary         Human-readable summary instead of full JSON
  --compact         Compact JSON (no indentation)
  --module          Parse as ES module
  --script          Parse as script
  --globals=a,b     Names treated as host-provided globals (neither free nor unknown)
  -h, --help        Show this help

The program only parses and analyzes; it never executes the input code and
never modifies the source or its AST.`

function pos(loc) {
  return loc ? `${loc.start.line}:${loc.start.column}` : "?"
}

function printSummary(report, label) {
  if (label) console.log(`# ${label}`)
  console.log(`sourceType: ${report.sourceType}, scopes: ${report.scopes.length}`)
  console.log("\nBindings:")
  for (const b of report.bindings) {
    const impl = b.implicit ? " (implicit)" : ""
    console.log(`  ${b.name} [${b.kind}${impl}] @${pos(b.loc)} scope#${b.scope.id}` +
      (b.references.length ? `  refs: ${b.references.map(pos).join(", ")}` : ""))
  }
  console.log("\nFree variables:")
  if (!report.freeVariables.length) console.log("  (none)")
  for (const f of report.freeVariables)
    console.log(`  ${f.name} @${pos(f.loc)}${f.assignmentTarget ? " (assignment target)" : ""}`)
  console.log("\nUnknown (with / direct eval — analysis cannot be complete):")
  if (!report.unknown.length && !report.dynamicEval.length) console.log("  (none)")
  for (const u of report.unknown)
    console.log(`  ${u.name} @${pos(u.loc)}  reasons: ${u.reasons.join(", ")}`)
  for (const d of report.dynamicEval)
    console.log(`  direct eval @${pos(d.loc)} taints scope#${d.taintedScope.id}`)
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) { console.log(HELP); return }
  const sources = opts.files.length
    ? opts.files.map(f => [readFileSync(f, "utf8"), f])
    : [[readFileSync(0, "utf8"), "<stdin>"]]
  const options = {globals: opts.globals}
  if (opts.sourceType) options.sourceType = opts.sourceType
  const reports = sources.map(([code, label]) => ({label, report: analyze(code, options)}))
  if (opts.summary) {
    reports.forEach(({label, report}, i) => {
      if (i) console.log("")
      printSummary(report, reports.length > 1 ? label : null)
    })
  } else if (reports.length === 1) {
    console.log(JSON.stringify(reports[0].report, null, opts.compact ? 0 : 2))
  } else {
    console.log(JSON.stringify(reports.map(({label, report}) => ({file: label, ...report})),
      null, opts.compact ? 0 : 2))
  }
}

main()
