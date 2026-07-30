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
import { execFileSync } from "node:child_process";
import { relative, resolve as resolvePath } from "node:path";
import {
  lintDocument,
  lintDiff,
  parseDocument,
  sortFindings,
  hasErrors,
  stamp,
  restamp,
  repairDuplicates,
} from "../src/index.js";
import { idIndex } from "../src/lint.js";

const USAGE = `markstay <command> [options]

Commands:
  lint     FILE...                  lint for well-formedness + intra-doc invariants
  lint     --before OLD.md NEW.md   regeneration diff between two versions
  check-staged [FILE...]            lint the staged commit against its baseline
                                    (for husky / lint-staged; FILE... scopes output)
  stamp    FILE...                  mint ids for unmarked blocks
  restamp  FILE...                  refresh hashes that drifted
  repair   FILE...                  mint fresh ids for duplicate ids

Options:
  -w, --write        edit files in place (write verbs; required for >1 file)
      --json         machine-readable output (lint)
      --show-drift   list HASH_DRIFT findings in lint text output (hidden by
                     default; --json always carries them)
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
    else if (a === "--show-drift") flags.showDrift = true;
    else if (a === "--mdx") flags.mdx = true;
    else if (a === "--no-hash") flags.noHash = true;
    else if (a === "--add-missing") flags.addMissing = true;
    else if (valueFlags.has(a)) flags[a.replace(/^--/, "")] = rest[++i];
    else if (a.startsWith("-") && a !== "-") fail(`unknown option ${a}`);
    else files.push(a);
  }
  return { files, flags };
}

// Human render. HASH_DRIFT is the dominant, non-actionable line in normal use
// (it never blocks; it only ever says "you edited things"), so it is hidden by
// default and collapsed to one discoverable line. `showDrift=true` lists it.
// `--json` and the return tuples always carry drift, so the structured channel
// is unaffected. The error/warn/info summary counts the real totals either way.
function renderText(label, findings, showDrift = false) {
  if (!findings.length) return `${label}: clean (no findings)`;
  const out = [`${label}:`];
  const shown = showDrift ? findings : findings.filter((f) => f.code !== "HASH_DRIFT");
  const nDriftHidden = findings.length - shown.length;
  for (const f of sortFindings(shown)) {
    const where = f.line ? `L${f.line}` : "-";
    out.push(`  [${f.level.padEnd(5)}] ${(f.code ?? "").padEnd(16)} ${where.padStart(5)}  ${f.message}`);
  }
  if (nDriftHidden) {
    const noun = nDriftHidden === 1 ? "finding" : "findings";
    out.push(`  -> ${nDriftHidden} hash-drift ${noun} hidden (--show-drift to list)`);
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
    process.stdout.write(results.map(([l, fs]) => renderText(l, fs, flags.showDrift)).join("\n") + "\n");
  }
  return results.some(([, fs]) => hasErrors(fs)) ? 1 : 0;
}

// --- check-staged: the git-aware verb husky / lint-staged call ----------------
// Everything above works on files. This works on a commit, which is what a hook
// needs: drop detection is a diff against the same document before the edit, and
// only git knows what that was.
//
// The baseline is resolved by stay id, not by filename. git's rename detection is
// content-similarity based, and similarity is anti-correlated with this failure
// mode: the more a rewrite destroys, the more stays it can drop AND the less git
// sees a rename. A measured real case scored 2% similarity, landed as delete +
// create, and every dropped stay went unreported. A surviving stay id is the
// stronger signal.
//
// An id that moved to another document in the same commit is reported as a move,
// not a loss, so reorganising documents does not block a commit.

const MD_RE = /\.(md|markdown)$/;

function git(args, { allowFail = false } = {}) {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      maxBuffer: 1 << 26,
      // Probing for a blob that may not exist is normal control flow here, so keep
      // git's own "fatal: path ... does not exist" off the user's screen.
      stdio: allowFail ? ["ignore", "pipe", "ignore"] : ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    if (allowFail) return null;
    throw e;
  }
}

function isMd(path) {
  // `.markstay/` holds a vendored linter and a PRESERVE.md that demonstrates the
  // marker form twice; linting it would report a duplicate id that is not the
  // repo's problem.
  if (path === ".markstay" || path.startsWith(".markstay/")) return false;
  return MD_RE.test(path);
}

/** Staged changes as [status, src, dst]. `-z` name-status: R/C carry two paths. */
function stagedEntries() {
  const fields = git([
    "diff", "--cached", "--name-status", "-z", "--find-renames",
  ]).split("\0");
  const out = [];
  for (let i = 0; i < fields.length && fields[i]; ) {
    const status = fields[i][0];
    if ((status === "R" || status === "C") && i + 2 < fields.length) {
      out.push([status, fields[i + 1], fields[i + 2]]);
      i += 3;
    } else if (i + 1 < fields.length) {
      out.push([status, fields[i + 1], fields[i + 1]]);
      i += 2;
    } else break;
  }
  return out;
}

const headText = (path) => git(["show", `HEAD:${path}`], { allowFail: true });
const idsOf = (text) =>
  text == null ? new Set() : new Set(idIndex(parseDocument(text)).keys());

function cmdCheckStaged(rest) {
  const { files, flags } = parseArgs(rest, new Set());
  const root = git(["rev-parse", "--show-toplevel"], { allowFail: true });
  if (!root) fail("check-staged must run inside a git work tree");
  const top = root.trim();

  // lint-staged appends the matched filenames (absolute by default). Treat them as
  // a reporting scope, not as the source of truth: the commit still has to be read
  // whole, because a deleted file is where a renamed document's baseline lives and
  // lint-staged never passes one.
  const scope = new Set(
    files.map((f) => relative(top, resolvePath(process.cwd(), f)).split("\\").join("/")),
  );

  const entries = stagedEntries();
  const changed = entries.filter(([st, , dst]) => st !== "D" && isMd(dst));
  const deleted = entries.filter(([st, src]) => st === "D" && isMd(src)).map(([, src]) => src);
  if (!changed.length && !deleted.length) return 0;

  const stagedText = new Map(
    changed.map(([, , dst]) => [dst, git(["show", `:${dst}`])]),
  );
  const stagedIds = new Map([...stagedText].map(([p, t]) => [p, idsOf(t)]));
  const committedIds = new Set();
  for (const s of stagedIds.values()) for (const id of s) committedIds.add(id);

  const deletedIds = new Map(deleted.map((p) => [p, idsOf(headText(p))]));
  const claimed = new Set();

  function baselineFor(status, src, dst) {
    if (status === "R") {
      const t = headText(src);
      if (t != null) return [t, src];
    } else if (status !== "C") {
      const t = headText(dst);
      if (t != null) return [t, dst];
    }
    // Nothing at this path in HEAD: added, or a rename git scored as delete +
    // create. Pair on shared stay ids instead of on the filename.
    const mine = stagedIds.get(dst) ?? new Set();
    let best = null;
    let bestN = 0;
    for (const [cand, candIds] of deletedIds) {
      if (claimed.has(cand)) continue;
      let n = 0;
      for (const id of mine) if (candIds.has(id)) n++;
      if (n > bestN) { best = cand; bestN = n; }
    }
    if (best !== null) {
      claimed.add(best);
      return [headText(best), best];
    }
    return [null, null];
  }

  const results = [];
  const notes = [];
  let anyError = false;
  for (const [status, src, dst] of changed) {
    const staged = stagedText.get(dst);
    const [baseline, origin] = baselineFor(status, src, dst);
    let findings = [...lintDocument(staged).findings];
    if (baseline != null) findings = findings.concat(lintDiff(baseline, staged));

    const kept = [];
    for (const f of findings) {
      if (f.code === "DROPPED_ID" && committedIds.has(f.id)) {
        const elsewhere = [...stagedIds]
          .filter(([p, s]) => p !== dst && s.has(f.id))
          .map(([p]) => p)
          .sort();
        notes.push(`  ${f.id}: moved out of ${origin ?? dst} into ${elsewhere.join(", ")}`
          + " (still in this commit, not blocking)");
        continue;
      }
      kept.push(f);
    }
    if (scope.size && !scope.has(dst)) continue;   // out of the caller's scope
    if (kept.length) {
      const label = origin == null || origin === dst ? dst : `${dst} (baseline ${origin})`;
      results.push([label, kept]);
      if (hasErrors(kept)) anyError = true;
    }
  }

  for (const path of deleted) {
    if (claimed.has(path)) continue;
    const gone = [...(deletedIds.get(path) ?? [])].filter((id) => !committedIds.has(id));
    if (gone.length) {
      notes.push(`  ${path}: deleted with ${gone.length} stay(s) that no staged file `
        + `carries (${gone.sort().slice(0, 6).join(", ")}${gone.length > 6 ? ", ..." : ""})`);
    }
  }

  if (flags.json) {
    const payload = {};
    for (const [label, fs] of results) payload[label] = sortFindings(fs);
    process.stdout.write(JSON.stringify({ findings: payload, notes }, null, 2) + "\n");
  } else {
    // A hook speaks only when there is something to act on. HASH_DRIFT says "you
    // edited a stamped block" and NEW_ID says "you added a stay"; neither blocks
    // and neither asks anything of the committer, so a commit carrying only those
    // prints nothing. --show-drift opts back in.
    const actionable = (f) =>
      f.level === "error" || (f.level === "warn" && f.code !== "HASH_DRIFT");
    const shown = results
      .filter(([, fs]) => (flags.showDrift ? fs.length : fs.some(actionable)))
      .map(([l, fs]) => renderText(l, fs, flags.showDrift));
    if (shown.length) process.stderr.write(shown.join("\n") + "\n");
    if (notes.length) {
      process.stderr.write("markstay: stays that changed document (not blocking):\n"
        + notes.join("\n") + "\n");
    }
  }
  if (anyError) {
    process.stderr.write("\nmarkstay: this commit breaks a stay (dropped / duplicated / "
      + "relocated / malformed). Fix it, or bypass once with `git commit --no-verify`.\n");
    return 1;
  }
  return 0;
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
    case "check-staged":
      return cmdCheckStaged(rest);
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
