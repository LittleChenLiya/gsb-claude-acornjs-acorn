#!/usr/bin/env node
// Command line front end for the Acorn-based lexical binding renamer.
//
// Local Node command (no install / build step needed):
//   node tools/rename-binding/cli.js --old x --new p file.js
//   node tools/rename-binding/cli.js --old x --new p --module --at 12 -w file.mjs
//   node tools/rename-binding/cli.js --list --old x file.js
//
// Reads the file once, prints the rewritten source to stdout. With --write it
// replaces the file in place; that only happens after every check (including
// the reparse verification) has succeeded, so a failed rename never touches
// the original source.

import {readFileSync, writeFileSync} from "node:fs"
import {renameBinding, listReferences, RenameError} from "./index.js"

function usage() {
  return `usage:
  rename --old <name> --new <name> [options] <file>
  rename --list --old <name> [options] <file>

options:
  --old <name>     binding to rename
  --new <name>     desired name
  --at <offset>    byte offset on the binding (disambiguates shadowed names)
  --module         parse the input as an ES module (default: script)
  --list           list the declaration sites and genuine references, then exit
  -w, --write      write the result back to the file instead of stdout
  -h, --help       show this help
`
}

function parseArgs(argv) {
  const args = {options: {sourceType: "script"}}
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    switch (a) {
    case "--old": args.old = argv[++i]; break
    case "--new": args.new = argv[++i]; break
    case "--at": args.options.atOffset = Number(argv[++i]); break
    case "--module": args.options.sourceType = "module"; break
    case "--list": args.list = true; break
    case "-w":
    case "--write": args.write = true; break
    case "-h":
    case "--help": args.help = true; break
    default:
      if (a.startsWith("--")) throw new Error(`unknown option: ${a}`)
      rest.push(a)
    }
  }
  args.file = rest[0] || null
  return args
}

function main(argv) {
  let args
  try { args = parseArgs(argv) } catch (e) {
    process.stderr.write(`${e.message}\n${usage()}`)
    return 2
  }
  if (args.help) { process.stdout.write(usage()); return 0 }
  if (!args.old) { process.stderr.write("--old is required\n"); return 2 }
  if (!args.list && !args.new) { process.stderr.write("--new is required\n"); return 2 }
  if (!args.file) { process.stderr.write("an input file is required\n"); return 2 }

  const code = readFileSync(args.file, "utf8")

  try {
    if (args.list) {
      const info = listReferences(code, args.old, args.options)
      const out = {
        binding: {name: info.binding.name, kind: info.binding.kind},
        declarations: info.declarations,
        references: info.references
      }
      process.stdout.write(JSON.stringify(out, null, 2) + "\n")
      return 0
    }

    const result = renameBinding(code, args.old, args.new, args.options)
    if (args.write) {
      if (result.changed) writeFileSync(args.file, result.code)
      process.stderr.write(
        result.changed
          ? `renamed '${args.old}' -> '${args.new}' (${result.edits.length} edits)\n`
          : `nothing to do ('${args.old}' already named '${args.new}')\n`)
    } else {
      process.stdout.write(result.code)
      if (!result.code.endsWith("\n")) process.stdout.write("\n")
    }
    return 0
  } catch (err) {
    if (err instanceof RenameError) {
      process.stderr.write(`rename refused: ${err.message}\n`)
      return 1
    }
    throw err
  }
}

process.exit(main(process.argv.slice(2)))
