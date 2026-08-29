// SPEC.md §3.3 (v1.5): text inside a fenced code block is content, not markup.
//
// A port of impl/py/tests/test_fenced_code.py, minus the cases that need a
// segmenter this core does not have: the §5.2 CommonMark cases and the §5.5
// child-block cases are Python-only, and are noted where they would sit. The
// four symptoms below were all observed on this project's own SPEC.md, which is
// the document the rule exists for: a tool's own specification is exactly where
// marker examples live.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  bodyHash,
  codeLines,
  lintDocument,
  normalizeBody,
  parseDocument,
  repairDuplicates,
  restamp,
  stamp,
} from "../src/index.js";

/** A deterministic id factory: n0, n1, ... */
function ids(prefix = "n") {
  let i = 0;
  return () => `${prefix}${i++}`;
}

const setOf = (...ns) => new Set(ns);
const markerIds = (blocks) => blocks.flatMap((b) => b.markers.map((m) => m.id));

// --- fence recognition (§3.3, the line rule) ------------------------------

const RECOGNITION = [
  ["a\n```\ncode\n```\nb\n", setOf(2, 3, 4)],
  ["a\n~~~\ncode\n~~~\nb\n", setOf(2, 3, 4)],
  // Up to three leading spaces opens and closes.
  ["a\n   ```\ncode\n   ```\nb\n", setOf(2, 3, 4)],
  // Four does not: that is an indented code block, which §3.3 leaves alone.
  ["a\n    ```\ncode\n    ```\nb\n", setOf()],
  // A tab is not one of the three spaces: CommonMark expands it against a column
  // model this rule deliberately does not have.
  ["a\n\t```\ncode\n\t```\nb\n", setOf()],
  // A longer opener contains a shorter run.
  ["````\n```\ninner\n```\n````\n", setOf(1, 2, 3, 4, 5)],
  // A shorter run cannot close a longer one, so this never closes.
  ["````\ncode\n```\nstill code\n", setOf(1, 2, 3, 4, 5)],
  // Different character cannot close.
  ["```\ncode\n~~~\nstill code\n", setOf(1, 2, 3, 4, 5)],
  // An unclosed fence runs to the end of the document.
  ["a\n```\ncode\n", setOf(2, 3, 4)],
  // A closing fence takes space or tab and nothing else after the run.
  ["```\ncode\n``` \nafter\n", setOf(1, 2, 3)],
  ["```\ncode\n```x\nstill code\n", setOf(1, 2, 3, 4, 5)],
  // A backtick fence's info string may not contain a backtick.
  ["a\n```md `x`\nnot a fence\n", setOf()],
  // A tilde fence's info string may.
  ["a\n~~~md `x`\ncode\n~~~\n", setOf(2, 3, 4)],
];

test("codeLines recognises the fences the line rule can see", () => {
  for (const [md, expected] of RECOGNITION) {
    assert.deepEqual(codeLines(md), expected, JSON.stringify(md));
  }
});

test("CRLF and LF twins give the same mask", () => {
  const lf = "a\n```\ncode\n```\nb\n";
  assert.deepEqual(codeLines(lf.replaceAll("\n", "\r\n")), codeLines(lf));
});

test("a fence carrying a blockquote marker is not covered", () => {
  // §3.3 names this as the rule's real limit rather than hiding it: seeing this
  // fence means knowing the container, which is the parser §5.2 exists to avoid.
  assert.deepEqual(codeLines("> ```\n> code\n> ```\n"), setOf());
});

// --- reading (§3.3 reader rules, §8) --------------------------------------

test("a marker in a fence identifies no block", () => {
  const md = "Intro.\n\n```md\nThe paragraph.\n<!-- stay:demo hash=sha256:7a9c -->\n```\n";
  assert.deepEqual(
    parseDocument(md).map((b) => b.markers),
    [[], []]
  );
});

test("a marker in a fence is hashed with the body", () => {
  const fence = "```md\nThe paragraph.\n<!-- stay:demo hash=sha256:7a9c -->\n```";
  const blocks = parseDocument(fence + "\n");
  assert.ok(blocks[0].content.includes("stay:demo"));
  assert.equal(blocks[0].content, normalizeBody(fence));
});

test("two fences sharing an example id are not a duplicate", () => {
  // Symptom 3: SPEC.md reported a DUPLICATE_ID under its own linter that no
  // restamp could clear, because restamp resolves an id to the first block
  // carrying it and hands the second that block's digest.
  const md =
    "```md\n<!-- stay:8f24 hash=sha256:7a9c -->\n```\n\n" +
    "```mdx\n{/* stay:8f24 hash=sha256:7a9c */}\n```\n";
  assert.deepEqual(lintDocument(md).findings, []);
});

test("a marker in an opening fence info string is not a marker", () => {
  // The fence lines are part of the block deliberately: before §3.3 this bound to
  // whatever block preceded it.
  const md = "Intro.\n\n~~~md <!-- stay:demo -->\ncode\n~~~\n";
  assert.deepEqual(
    parseDocument(md).map((b) => b.markers),
    [[], []]
  );
});

test("an inline code span still carries a marker", () => {
  // §3.3 declines inline spans on purpose: that is the shape pandoc's native
  // markdown writer produces when it mangles a trailing marker, and a mangled
  // marker a tool can still see beats one that has silently stopped existing.
  const md = "A line showing `<!-- stay:demo -->` inline.\n";
  assert.deepEqual(markerIds(parseDocument(md)), ["demo"]);
});

// --- writing (§3.3 writer rules) ------------------------------------------

test("restamp leaves an illustrative hash alone", () => {
  // Symptom 1, and the one that shipped: a restamp of SPEC.md rewrote §3.1's and
  // §3.2's example `hash=` values to the digest of the fence around them.
  const md = "```md\nThe paragraph being identified.\n<!-- stay:8f24 hash=sha256:7a9c -->\n```\n";
  const result = restamp(md);
  assert.equal(result.text, md);
  assert.deepEqual(result.refreshed, []);
});

test("restamp leaves an example alone even when the id is live", () => {
  // The mask is load-bearing rather than belt-and-braces: with a real block
  // carrying the same id, the example is reachable through `contentById`.
  const body = "Live content.";
  const md =
    `${body}\n<!-- stay:demo hash=sha256:${bodyHash(body, 4)} -->\n\n` +
    "```md\n<!-- stay:demo hash=sha256:7a9c -->\n```\n";
  assert.equal(restamp(md).text, md);
});

test("a fence showing a marker now gets a stay of its own", () => {
  // Symptom 2: the example counted as the fence's stay, so the block a tutorial
  // most wants addressable was the one block that was not. (Python asserts this
  // under §5.2; here the fence has no internal blank line, so the baseline
  // segmenter reads it as one block and reaches the same answer.)
  const md = "```md\nThe paragraph.\n<!-- stay:demo hash=sha256:7a9c -->\n```\n";
  const result = stamp(md, { newId: ids() });
  const fence = md.replace(/\n+$/, "");
  assert.equal(result.text, `${fence}\n<!-- stay:n0 hash=sha256:${bodyHash(fence, 12)} -->\n`);
  assert.deepEqual(result.minted, [{ id: "n0", line: 4 }]);
});

test("the stamper refuses to write into a listing", () => {
  // Symptom 4, and the worst one: under the baseline segmenter a fence with an
  // internal blank line splits into ordinary blocks, and a stamping run put a
  // real marker inside this specification's own §4 ABNF grammar.
  const md = "```text\nfirst = a\n\nsecond = b\n```\n";
  const result = stamp(md, { newId: ids() });
  assert.equal(result.text, md);
  assert.deepEqual(result.minted, []);
});

test("repair does not rename an example id", () => {
  const body = "Live content.";
  const md =
    `${body}\n<!-- stay:demo hash=sha256:${bodyHash(body, 4)} -->\n\n` +
    "```md\n<!-- stay:demo -->\n```\n";
  const result = repairDuplicates(md, { newId: ids() });
  assert.equal(result.text, md);
  assert.deepEqual(result.renamed, []);
});

// --- migration (§3.3, the two shapes) -------------------------------------

test("migration one: the block drifts once and restamps clean", () => {
  const fence = "```md\nExample.\n<!-- stay:demo -->\n```";
  const stale = bodyHash("```md\nExample.\n\n```", 12); // what v1.4 hashed
  const md = `${fence}\n<!-- stay:live hash=sha256:${stale} -->\n`;
  assert.deepEqual(
    lintDocument(md).findings.map((f) => f.code),
    ["HASH_DRIFT"]
  );
  assert.deepEqual(lintDocument(restamp(md).text).findings, []);
});

test("migration two: the block is silently unstamped and needs minting", () => {
  // A restamp does not fix this one: the block needs a stay minted, so it gets a
  // new id rather than a corrected hash, and no linter finding fires on the way
  // because an unstamped block is not an error.
  const md = "```md\nExample.\n<!-- stay:demo hash=sha256:7a9c -->\n```\n";
  assert.deepEqual(lintDocument(md).findings, []);
  assert.equal(restamp(md).text, md);
  assert.deepEqual(stamp(md, { newId: ids() }).minted, [{ id: "n0", line: 4 }]);
});

// --- the line rule's sharpest limit ---------------------------------------

test("a fence opening on a list-marker line swallows the rest of the document", () => {
  // §3.3's limit, in the shape that costs the most. The opening fence shares a
  // line with the list marker, so the line scan never sees it open; the closing
  // "  ```" is the first fence-shaped line it does see and reads as an *opener*,
  // and with no later fence-shaped line it runs to EOF. Every marker after it goes
  // silent: no drift is reported because nothing is compared, and the block simply
  // looks unstamped. It fails closed rather than corrupting anything, and it is
  // pinned here so a later reader meets it as a decision rather than as a
  // surprise. The variant where a later fence-shaped line *does* close the phantom
  // is the test below.
  const md =
    "- ```txt\n  code\n  ```\n\nA later paragraph.\n<!-- stay:live hash=sha256:dead -->\n";
  assert.deepEqual(codeLines(md), setOf(3, 4, 5, 6, 7));
  assert.deepEqual(markerIds(parseDocument(md)), []);
  assert.deepEqual(lintDocument(md).findings, []);
  assert.deepEqual(stamp(md, { newId: ids() }).minted, []);
});

test("a fence on its own line inside a list item is seen correctly", () => {
  // The common shape is fine, which is why the case above is a limit rather than a
  // defect in the rule: a balanced pair at one to three spaces of indent opens and
  // closes exactly where CommonMark puts it.
  const md = "- item:\n\n  ```py\n  code\n  ```\n\nAfter.\n<!-- stay:live -->\n";
  assert.deepEqual(codeLines(md), setOf(3, 4, 5));
  assert.deepEqual(markerIds(parseDocument(md)), ["live"]);
});

test("a phantom fence that later closes still refuses the block it straddles", () => {
  // The phantom opener from the case above is closed by the next fence-shaped
  // line, so the mask ends and later lines are ordinary content again. What does
  // not come back is the block that *straddles* the close: it begins inside the
  // phantom fence and ends outside it, and `stamp` refuses it even though the
  // marker would land on an unmasked line.
  //
  // That refusal is the rule working rather than over-reaching, and the case below
  // shows why: the same shape occurs with a perfectly real fence, where the
  // straddling block's body is half a listing and §5.2 already says such a half
  // cannot reliably carry a stay. Refusing on "a fence was open before this block
  // started" is the fail-closed side of a question the line scan cannot answer,
  // not a proxy that happens to be wrong here.
  const md = "- ```txt\n  code\n  ```\n\nA paragraph.\n```\nAfter.\n";
  assert.deepEqual(codeLines(md), setOf(3, 4, 5, 6));
  assert.deepEqual(stamp(md, { newId: ids() }).minted, []);
});

test("a real blank-line fence refuses the half that straddles its close", () => {
  // No phantom anywhere: a genuine fence with an internal blank line, which the
  // baseline segmenter splits. The second half runs past the closing fence into
  // the prose after it, so its body would be `b`, the closing fence, and a line of
  // prose. §3.3: "under the baseline segmenter the halves of such a fence are
  // simply not stampable, which is where §5.2 already arrives." (Python pins the
  // §5.2 half of this case; that segmenter is deferred from this core.)
  const md = "```text\na\n\nb\n```\nprose\n";
  assert.deepEqual(
    parseDocument(md).map((b) => b.content),
    ["```text\na", "b\n```\nprose"]
  );
  assert.deepEqual(stamp(md, { newId: ids() }).minted, []);
});
