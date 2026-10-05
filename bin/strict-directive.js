#!/usr/bin/env node
// CLI for the explicit "use strict" directive insertion planner.
//
// Usage:
//   node bin/strict-directive.js [options] [file]
//
// If no file is given, source is read from standard input.
//
// Options:
//   -e, --ecmaVersion <ver>   ECMAScript version (default: 2022)
//   -s, --sourceType <type>   script | module | commonjs (default: script)
//       --script              Insert at the script top-level instead of
//                             individual function scopes.
//       --functions           Insert into each non-strict function (default).
//   -o, --output <file>        Write rewritten source to <file>.
//       --json                Print the full result as JSON.
//   -h, --help                 Show this help.

import {readFileSync, writeFileSync} from "fs"
import {insertStrictDirectives} from "../acorn/src/index.js"

function usage() {
  process.stdout.write(readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(2, 18).join("\n") + "\n")
}

function parseArgs(argv) {
  const opts = {ecmaVersion: 2022, sourceType: "script", script: false, json: false, output: null, file: null}
  let i = 0
  while (i < argv.length) {
    const arg = argv[i]
    if (arg === "-h" || arg === "--help") {
      opts.help = true
      i++
    } else if (arg === "-e" || arg === "--ecmaVersion") {
      opts.ecmaVersion = argv[++i]
      i++
    } else if (arg === "-s" || arg === "--sourceType") {
      opts.sourceType = argv[++i]
      i++
    } else if (arg === "--script") {
      opts.script = true
      i++
    } else if (arg === "--functions") {
      opts.script = false
      i++
    } else if (arg === "-o" || arg === "--output") {
      opts.output = argv[++i]
      i++
    } else if (arg === "--json") {
      opts.json = true
      i++
    } else if (arg.startsWith("-")) {
      process.stderr.write("Unknown option: " + arg + "\n")
      process.exit(2)
    } else {
      opts.file = arg
      i++
    }
  }
  return opts
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    usage()
    process.exit(0)
  }

  let source
  if (opts.file) {
    source = readFileSync(opts.file, "utf8")
  } else {
    source = readFileSync(0, "utf8")
  }

  const ecmaVersion = opts.ecmaVersion === "latest" ? "latest" : Number(opts.ecmaVersion)
  const result = insertStrictDirectives(source, {
    ecmaVersion,
    sourceType: opts.sourceType,
    script: opts.script
  })

  if (opts.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n")
    return
  }

  if (!result.ok) {
    process.stderr.write("strict directive insertion failed:\n")
    for (const err of result.errors) {
      process.stderr.write("  [" + err.phase + "] " + err.message + "\n")
      if (err.originalPos != null) {
        process.stderr.write("    original position: " + err.originalPos + "\n")
      }
    }
    process.exit(1)
  }

  if (opts.output) {
    writeFileSync(opts.output, result.code, "utf8")
    process.stderr.write("wrote " + result.changes.length + " directive(s) to " + opts.output + "\n")
  } else {
    process.stdout.write(result.code)
  }
}

main()
