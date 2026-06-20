#!/usr/bin/env node
// markstay CLI (npm `markstay`). Subcommand grammar so the write verbs read
// naturally:
//
//   markstay lint    FILE...            well-formedness + intra-doc checks
//   markstay lint    --before OLD NEW   regeneration diff (SPEC.md §11)
//   markstay stamp   FILE... [-w]       mint ids for unmarked blocks (§6)
//   markstay restamp FILE... [-w]       refresh drifted hashes (§8)
//   markstay repair  FILE... [-w]       mint fresh ids for duplicates (§7)
//
// `lint` exits non-zero when any error-level finding is reported, so it gates a
// commit hook or an agent's post-edit step. The write verbs print the result to
// stdout by default; `-w`/`--write` edits files in place.
//
// NOTE: the PyPI `markstay` console script is lint-only and takes a bare
// positional FILE (`markstay FILE`). This JS CLI uses an explicit `lint`
// subcommand because it also carries the write verbs; the grammars are meant to
// converge on this subcommand form (see the umbrella adoption plan).

import { readFileSync, writeFileSync } from "node:fs";
import {
  lintDocument,
  lintDiff,
  sortFindings,
  hasErrors,
  stamp,
  restamp,
  repairDuplicates,
} from "../src/index.js";

const USAGE = `markstay <command> [options]

Commands:
  lint     FILE...                  lint for well-formedness + intra-doc invariants
  lint     --before OLD.md NEW.md   regeneration diff between two versions
  stamp    FILE...                  mint ids for unmarked blocks
  restamp  FILE...                  refresh hashes that drifted
  repair   FILE...                  mint fresh ids for duplicate ids

Options:
  -w, --write        edit files in place (write verbs; required for >1 file)
      --json         machine-readable output (lint)
      --before FILE  baseline for a regeneration diff (lint)
      --mdx          emit the MDX comment form {/* ... */} (stamp)
      --no-hash      do not write a hash attribute (stamp)
      --hash-length N  hex-prefix length for written hashes (stamp/restamp)
      --add-missing  add a hash to markers that lack one (restamp)
  -h, --help         show this help
`;

function fail(msg) {
  process.stderr.write(`markstay: ${msg}\n`);
  process.exit(2);
}

/** Minimal flag parser: splits FILE args from --flags (with optional values). */
function parseArgs(rest, valueFlags) {
  const files = [];
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "-w" || a === "--write") flags.write = true;
    else if (a === "--json") flags.json = true;
    else if (a === "--mdx") flags.mdx = true;
    else if (a === "--no-hash") flags.noHash = true;
    else if (a === "--add-missing") flags.addMissing = true;
    else if (valueFlags.has(a)) flags[a.replace(/^--/, "")] = rest[++i];
    else if (a.startsWith("-") && a !== "-") fail(`unknown option ${a}`);
    else files.push(a);
  }
  return { files, flags };
}

function renderText(label, findings) {
  if (!findings.length) return `${label}: clean (no findings)`;
  const out = [`${label}:`];
  for (const f of sortFindings(findings)) {
    const where = f.line ? `L${f.line}` : "-";
    out.push(`  [${f.level.padEnd(5)}] ${(f.code ?? "").padEnd(16)} ${where.padStart(5)}  ${f.message}`);
  }
  const n = (lvl) => findings.filter((x) => x.level === lvl).length;
  out.push(`  -> ${n("error")} error, ${n("warn")} warn, ${n("info")} info`);
  return out.join("\n");
}

function cmdLint(rest) {
  const { files, flags } = parseArgs(rest, new Set(["--before"]));
  if (!files.length) fail("lint needs at least one FILE");
  const results = [];
  if (flags.before) {
    if (files.length !== 1) fail("--before takes exactly one NEW file");
    const beforeMd = readFileSync(flags.before, "utf8");
    const afterMd = readFileSync(files[0], "utf8");
    results.push([`${flags.before} -> ${files[0]}`, lintDiff(beforeMd, afterMd)]);
  } else {
    for (const f of files) results.push([f, lintDocument(readFileSync(f, "utf8")).findings]);
  }
  if (flags.json) {
    const payload = {};
    for (const [label, fs] of results) payload[label] = sortFindings(fs);
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
  } else {
    process.stdout.write(results.map(([l, fs]) => renderText(l, fs)).join("\n") + "\n");
  }
  return results.some(([, fs]) => hasErrors(fs)) ? 1 : 0;
}

/** Shared driver for the write verbs: run `op(text)` per file, emit or write. */
function runWrite(verb, rest, op) {
  const valueFlags = new Set(["--hash-length"]);
  const { files, flags } = parseArgs(rest, valueFlags);
  if (!files.length) fail(`${verb} needs at least one FILE`);
  if (files.length > 1 && !flags.write) fail(`${verb} on multiple files requires -w/--write`);
  if (flags["hash-length"] !== undefined) {
    flags.hashLength = Number(flags["hash-length"]);
    if (!Number.isInteger(flags.hashLength) || flags.hashLength < 1) {
      fail("--hash-length must be a positive integer");
    }
  }
  for (const f of files) {
    const { text, note } = op(readFileSync(f, "utf8"), flags);
    if (flags.write) {
      writeFileSync(f, text);
      process.stderr.write(`${f}: ${note}\n`);
    } else {
      process.stdout.write(text);
      if (note) process.stderr.write(`${f}: ${note}\n`);
    }
  }
  return 0;
}

function cmdStamp(rest) {
  return runWrite("stamp", rest, (md, flags) => {
    const { text, minted } = stamp(md, {
      syntax: flags.mdx ? "mdx" : "html",
      hash: !flags.noHash,
      ...(flags.hashLength !== undefined ? { hashLength: flags.hashLength } : {}),
    });
    return { text, note: `${minted.length} id(s) minted` };
  });
}

function cmdRestamp(rest) {
  return runWrite("restamp", rest, (md, flags) => {
    const { text, refreshed } = restamp(md, {
      addMissing: !!flags.addMissing,
      ...(flags.hashLength !== undefined ? { hashLength: flags.hashLength } : {}),
    });
    return { text, note: `${refreshed.length} hash(es) refreshed` };
  });
}

function cmdRepair(rest) {
  return runWrite("repair", rest, (md) => {
    const { text, renamed } = repairDuplicates(md);
    return { text, note: `${renamed.length} duplicate id(s) re-minted` };
  });
}

function main(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
    process.stdout.write(USAGE);
    return cmd ? 0 : 2;
  }
  switch (cmd) {
    case "lint":
      return cmdLint(rest);
    case "stamp":
      return cmdStamp(rest);
    case "restamp":
      return cmdRestamp(rest);
    case "repair":
      return cmdRepair(rest);
    default:
      fail(`unknown command ${JSON.stringify(cmd)} (try: markstay --help)`);
  }
}

process.exit(main(process.argv.slice(2)));
