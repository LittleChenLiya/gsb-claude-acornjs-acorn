#!/usr/bin/env node
// Command-line interface for the explicit lexical binding renamer.
//
// Usage:
//   node bin/rename.js --from <name> --to <newName> [--module] [--ecmaVersion <n>] <file>
//   node bin/rename.js --from <name> --to <newName> [--module] [--ecmaVersion <n>] < file.js
//
// Reads a JavaScript source file, renames the binding identified by --from
// to --to, and writes the result to stdout. On failure the original source
// is written to stdout unchanged and an error message is printed to stderr.

"use strict"

const fs = require("fs")
const path = require("path")

// Resolve acorn from the local build or source.
let acorn
try {
  acorn = require("../acorn/dist/acorn.js")
} catch (e) {
  try {
    acorn = require("../acorn/src/index.js")
  } catch (e2) {
    console.error("Could not load acorn. Run `npm run build:main` first.")
    process.exit(2)
  }
}

function help(status) {
  const print = status === 0 ? console.log : console.error
  print("usage: rename --from <name> --to <newName> [--module] [--ecmaVersion <n>] <file>")
  print("       rename --from <name> --to <newName> [--module] [--ecmaVersion <n>] < <file.js>")
  print("")
  print("  --from <name>       Name of the binding to rename (must be unique)")
  print("  --to <newName>      New name for the binding")
  print("  --module            Parse as an ES module")
  print("  --ecmaVersion <n>   ECMAScript version to parse (default: latest)")
  print("  --help              Show this help")
  process.exit(status)
}

const argv = process.argv.slice(2)
let from = null
let to = null
let sourceType = "script"
let ecmaVersion = "latest"
let inputFile = null

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]
  if (arg === "--from") {
    from = argv[++i]
  } else if (arg === "--to") {
    to = argv[++i]
  } else if (arg === "--module") {
    sourceType = "module"
  } else if (arg === "--ecmaVersion") {
    ecmaVersion = +argv[++i]
  } else if (arg === "--help" || arg === "-h") {
    help(0)
  } else if (arg[0] !== "-") {
    inputFile = arg
  } else {
    console.error("Unknown option: " + arg)
    help(1)
  }
}

if (!from || !to) {
  console.error("Both --from and --to are required.")
  help(1)
}

let source
if (inputFile) {
  try {
    source = fs.readFileSync(inputFile, "utf8")
  } catch (e) {
    console.error("Could not read file: " + inputFile)
    process.exit(2)
  }
} else {
  try {
    source = fs.readFileSync(0, "utf8")
  } catch (e) {
    console.error("Could not read from stdin.")
    process.exit(2)
  }
}

let result
try {
  result = acorn.rename(source, {from: from, to: to, ecmaVersion: ecmaVersion, sourceType: sourceType})
} catch (e) {
  console.error("Rename failed: " + e.message)
  process.stdout.write(source)
  process.exit(1)
}

process.stdout.write(result.code)
