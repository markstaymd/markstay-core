// CLI drift-channel tests, ported from linter/test_lint.py. HASH_DRIFT is
// load-bearing in the structured channel (the RAG chunker treats it as fatal; the
// Plate contrast counts it) but noise in the default human render (it never
// blocks, only ever says "you edited things"). The `lint` text render hides it by
// default behind --show-drift; the finding, its warn level, and --json are
// untouched. These tests drive the real `bin/cli.js` binary so the published
// `markstay lint` behaves identically to the Python reference.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { lintDocument, lintDiff, PRESERVE_INSTRUCTION, preserveWrap } from "../src/index.js";

const CLI = fileURLToPath(new URL("../bin/cli.js", import.meta.url));

// Run the CLI and capture stdout. `lint` exits 1 on any error-level finding, so
// capture the output on a non-zero exit instead of letting execFileSync throw.
function runCli(args) {
  try {
    return execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
  } catch (e) {
    return e.stdout ?? "";
  }
}

// Run the CLI for its exit status only (2 is the shared argument-error code).
function exitCode(args) {
  try {
    execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8", stdio: "pipe" });
    return 0;
  } catch (e) {
    return e.status;
  }
}

// Write each text to a fresh temp dir, hand the paths to fn, then clean up.
function withTmp(texts, fn) {
  const dir = mkdtempSync(join(tmpdir(), "markstay-cli-"));
  try {
    const paths = texts.map((t, i) => {
      const p = join(dir, `f${i}.md`);
      writeFileSync(p, t);
      return p;
    });
    return fn(...paths);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const DRIFT_DOC = "Edited.\n<!-- stay:z9 hash=sha256:dead -->\n";
const MIXED_DOC =
  "Edited.\n<!-- stay:z9 hash=sha256:dead -->\n\nA para.\n<!-- stay:note=hello -->\n";

test("lint render hides drift by default, lists it with --show-drift", () => {
  withTmp([DRIFT_DOC], (p) => {
    const hidden = runCli(["lint", p]);
    const shown = runCli(["lint", "--show-drift", p]);
    assert.ok(!hidden.includes("HASH_DRIFT"), "drift line dropped by default");
    assert.ok(
      hidden.includes("hash-drift") && hidden.includes("--show-drift"),
      "collapsed receipt present",
    );
    assert.ok(shown.includes("HASH_DRIFT"), "drift listed on request");
    assert.ok(!shown.includes("hidden (--show-drift"), "no collapsed line when shown");
    // The summary counts the real totals either way (a hidden drift still happened).
    assert.ok(hidden.includes("0 error, 1 warn, 0 info"));
    assert.ok(shown.includes("0 error, 1 warn, 0 info"));
  });
});

test("lint keeps real findings and the counts with a mixed finding set", () => {
  withTmp([MIXED_DOC], (p) => {
    const hidden = runCli(["lint", p]);
    const shown = runCli(["lint", "--show-drift", p]);
    for (const r of [hidden, shown]) {
      assert.ok(r.includes("1 error, 1 warn, 0 info"), "counts unchanged");
      assert.ok(r.includes("MALFORMED_MARKER"), "the actionable line stays");
    }
    assert.ok(!hidden.includes("HASH_DRIFT"));
    assert.ok(hidden.includes("1 hash-drift finding hidden"), "singular, collapsed");
  });
});

test("--json output is byte-identical with and without --show-drift", () => {
  withTmp([DRIFT_DOC], (p) => {
    const a = runCli(["lint", "--json", p]);
    const b = runCli(["lint", "--json", "--show-drift", p]);
    assert.equal(a, b, "structured channel untouched by the flag");
    assert.ok(a.includes("HASH_DRIFT"), "drift still carried in --json");
  });
});

test("--before diff text path hides drift by default, lists it with --show-drift", () => {
  withTmp(
    ["Alpha content.\n<!-- stay:aaa -->\n", "Alpha content, now revised.\n<!-- stay:aaa -->\n"],
    (before, after) => {
      const hidden = runCli(["lint", "--before", before, after]);
      const shown = runCli(["lint", "--show-drift", "--before", before, after]);
      assert.ok(!hidden.includes("HASH_DRIFT"));
      assert.ok(hidden.includes("hash-drift"), "collapsed line on the diff path");
      assert.ok(shown.includes("HASH_DRIFT"));
    },
  );
});

test("guardrail: HASH_DRIFT stays warn in the structured return tuples", () => {
  // The invariant the whole change hinges on: the structured channel must keep
  // HASH_DRIFT at warn, because the RAG chunker's fatal check and the Plate
  // contrast both read these return values, not the printed text.
  const doc = lintDocument(DRIFT_DOC).findings.filter((f) => f.code === "HASH_DRIFT");
  assert.ok(doc.length && doc.every((f) => f.level === "warn"));
  const diff = lintDiff("Alpha.\n<!-- stay:a -->\n", "Alpha, revised.\n<!-- stay:a -->\n").filter(
    (f) => f.code === "HASH_DRIFT",
  );
  assert.ok(diff.length && diff.every((f) => f.level === "warn"));
});

// --- preserve (SPEC.md §11) -------------------------------------------------
//
// The verb the eval says matters most: an instructed rewrite keeps ~96-100% of
// markers against ~5% for a naive one. Its CLI contract is deliberately dull, no
// parsing and no git, so these pin the shape rather than the content (the text
// itself is held byte-identical to Python and Rust by the conformance corpus).

test("preserve prints the instruction verbatim and exits 0", () => {
  assert.equal(runCli(["preserve"]), PRESERVE_INSTRUCTION + "\n");
});

test("preserve --wrap composes the measured prompt shape", () => {
  withTmp(["# Title\n\nA paragraph.\n"], (doc) => {
    const out = runCli(["preserve", "--wrap", doc, "--task", "Tighten it."]);
    assert.equal(out, preserveWrap("# Title\n\nA paragraph.\n", "Tighten it.") + "\n");
    // task first, then the instruction, then the document behind the rule
    assert.ok(out.indexOf("Tighten it.") < out.indexOf(PRESERVE_INSTRUCTION));
    assert.ok(out.indexOf(PRESERVE_INSTRUCTION) < out.indexOf("A paragraph."));
  });
});

test("preserve rejects a bare FILE and a --task without --wrap", () => {
  // A bare FILE is the plausible mistake (every other verb takes one), so it has
  // to fail loudly rather than silently print the instruction and ignore the doc.
  assert.equal(exitCode(["preserve", "doc.md"]), 2);
  assert.equal(exitCode(["preserve", "--task", "Tighten it."]), 2);
});

test("a value flag in final position is an error, not an absent flag", () => {
  // Storing undefined here reads downstream as "flag absent", so the CLI would
  // run a different command at exit 0 while Python and Rust both exit 2.
  assert.equal(exitCode(["preserve", "--wrap"]), 2);
  assert.equal(exitCode(["preserve", "--task"]), 2);
  assert.equal(exitCode(["lint", "--before"]), 2);
});

test("preserve rejects input that is not valid UTF-8", () => {
  // Node substitutes U+FFFD and Python surrogate-escapes, so a lenient read is
  // precisely how three implementations stop emitting the same bytes. All three
  // exit 2 instead.
  const dir = mkdtempSync(join(tmpdir(), "markstay-cli-"));
  try {
    const p = join(dir, "bad.md");
    writeFileSync(p, Buffer.from([0x42, 0xff, 0x0a]));
    assert.equal(exitCode(["preserve", "--wrap", p]), 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
