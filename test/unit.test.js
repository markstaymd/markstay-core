// Behavioral unit tests, ported from linter/test_lint.py and
// eval/attachment/test_attach.py. These assert behavioral parity beyond the
// shared corpus: the lint codes, the regeneration-diff codes
// (DROPPED_ID / DUPLICATED_ID / RELOCATED_ID), and the resolver ladder
// (marker -> hash -> quote -> detached) including the "surface, don't guess"
// margin guard. CommonMark-mode cases (SPEC.md §5.2) are deferred from JS v1.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  bodyHash, parseDocument, lintDocument, lintDiff, hasErrors,
  bestMatch, buildAnchors, resolve,
} from "../src/index.js";

const codes = (findings) => findings.map((f) => f.code).sort();

// --- linter: well-formedness + intra-doc (ported from test_lint.py) -------

test("clean doc with correct hash has no findings", () => {
  const body = "The order pipeline ingests messages and normalizes them.";
  const h = bodyHash(body, 4);
  const md =
    `${body}\n<!-- stay:8f24 hash=sha256:${h} -->\n\n` +
    "A second paragraph that is also identified.\n<!-- stay:a1b2 -->\n";
  const { findings } = lintDocument(md);
  assert.deepEqual(codes(findings), []);
  assert.ok(!hasErrors(findings));
});

test("uppercase hex hash does not report drift (SPEC.md §8)", () => {
  const body = "Users authenticate with an API key in the Authorization header.";
  const h = bodyHash(body, 4).toUpperCase();
  const md = `${body}\n<!-- stay:8f24 hash=sha256:${h} -->\n`;
  const { findings } = lintDocument(md);
  assert.deepEqual(codes(findings), []);
  assert.ok(!hasErrors(findings));
});

test("marker with no blank line attaches to the block above", () => {
  const blocks = parseDocument("Just one paragraph.\n<!-- stay:p1 -->\n");
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].content, "Just one paragraph.");
  assert.deepEqual(blocks[0].markers.map((m) => m.id), ["p1"]);
});

test("marker-only chunk attaches to the previous content block", () => {
  const blocks = parseDocument("Some content.\n\n<!-- stay:x -->\n");
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].content, "Some content.");
  assert.deepEqual(blocks[0].markers.map((m) => m.id), ["x"]);
});

test("duplicate id is an error", () => {
  const md = "Block one.\n<!-- stay:dup -->\n\nBlock two.\n<!-- stay:dup -->\n";
  const { findings } = lintDocument(md);
  assert.ok(codes(findings).includes("DUPLICATE_ID"));
  assert.ok(hasErrors(findings));
});

test("malformed marker (no id) is reported", () => {
  const { findings } = lintDocument("A paragraph.\n<!-- stay:note=hello -->\n");
  assert.ok(codes(findings).includes("MALFORMED_MARKER"));
});

test("orphan marker at top is reported", () => {
  const { findings } = lintDocument("<!-- stay:loose -->\n\nReal content below.\n");
  assert.ok(codes(findings).includes("ORPHAN_MARKER"));
});

test("hash drift is a warning, not an error", () => {
  const { findings } = lintDocument("Edited content.\n<!-- stay:z9 hash=sha256:dead -->\n");
  assert.deepEqual(codes(findings), ["HASH_DRIFT"]);
  assert.ok(!hasErrors(findings));
});

test("MDX marker is parsed with mdx syntax", () => {
  const blocks = parseDocument("An MDX block.\n{/* stay:mdx1 hash=sha256:abcd */}\n");
  assert.equal(blocks[0].markers[0].id, "mdx1");
  assert.equal(blocks[0].markers[0].syntax, "mdx");
});

test("unknown parse mode is rejected (CommonMark deferred from v1)", () => {
  assert.throws(() => parseDocument("x\n", "bogus"));
  assert.throws(() => parseDocument("x\n", "commonmark"));
});

// --- regeneration diff (ported from test_lint.py) -------------------------

test("diff reports a dropped id", () => {
  const before = "A.\n<!-- stay:a -->\n\nB.\n<!-- stay:b -->\n";
  const after = "A.\n<!-- stay:a -->\n\nB rewritten without its marker.\n";
  const findings = lintDiff(before, after);
  assert.deepEqual(findings.filter((f) => f.code === "DROPPED_ID").map((f) => f.id), ["b"]);
  assert.ok(hasErrors(findings));
});

test("diff reports a duplicated id", () => {
  const before = "A.\n<!-- stay:a -->\n";
  const after = "A.\n<!-- stay:a -->\n\nCopy of A.\n<!-- stay:a -->\n";
  assert.ok(codes(lintDiff(before, after)).includes("DUPLICATED_ID"));
});

test("diff reports a new id as info, not an error", () => {
  const before = "A.\n<!-- stay:a -->\n";
  const after = "A.\n<!-- stay:a -->\n\nBrand new block.\n<!-- stay:c -->\n";
  const findings = lintDiff(before, after);
  assert.deepEqual(findings.filter((f) => f.code === "NEW_ID").map((f) => f.id), ["c"]);
  assert.ok(!hasErrors(findings));
});

test("diff reports an exact-content relocation swap", () => {
  const before = "Alpha content.\n<!-- stay:aaa -->\n\nBeta content.\n<!-- stay:bbb -->\n";
  const after = "Beta content.\n<!-- stay:aaa -->\n\nAlpha content.\n<!-- stay:bbb -->\n";
  const findings = lintDiff(before, after);
  assert.deepEqual(findings.filter((f) => f.code === "RELOCATED_ID").map((f) => f.id).sort(), ["aaa", "bbb"]);
  assert.ok(hasErrors(findings));
});

test("diff treats an in-place edit as drift, not relocation", () => {
  const before = "Alpha content.\n<!-- stay:aaa -->\n";
  const after = "Alpha content, now revised.\n<!-- stay:aaa -->\n";
  assert.deepEqual(codes(lintDiff(before, after)), ["HASH_DRIFT"]);
});

// --- resolver ladder (ported / adapted from test_attach.py) ---------------

const REORDER_BEFORE =
  "The order pipeline ingests and normalizes partner messages.\n<!-- stay:ing -->\n\n" +
  "Invalid payloads route to a dead-letter queue for replay.\n<!-- stay:dlq -->\n";

test("marker tier: markers kept means every id resolves by marker", () => {
  const after =
    "Invalid payloads route to a dead-letter queue for replay.\n<!-- stay:dlq -->\n\n" +
    "The order pipeline ingests and normalizes partner messages.\n<!-- stay:ing -->\n";
  const res = resolve(buildAnchors(REORDER_BEFORE), after);
  assert.equal(res.ing.method, "marker");
  assert.equal(res.dlq.method, "marker");
});

test("hash tier: stripped + reordered verbatim recovers by hash", () => {
  const after =
    "Invalid payloads route to a dead-letter queue for replay.\n\n" +
    "The order pipeline ingests and normalizes partner messages.\n";
  const res = resolve(buildAnchors(REORDER_BEFORE), after);
  assert.equal(res.ing.method, "hash");
  assert.equal(res.dlq.method, "hash");
  assert.equal(res.ing.target, 1);
  assert.equal(res.dlq.target, 0);
});

test("quote tier: a paraphrased block recovers via the quote selector", () => {
  const before =
    "The quick brown fox jumps over the lazy dog.\n<!-- stay:a -->\n\n" +
    "An entirely unrelated sentence about relational databases.\n<!-- stay:b -->\n";
  const after =
    "The quick brown fox leaps over the lazy dog.\n\n" +
    "An entirely unrelated sentence about relational databases.\n";
  const res = resolve(buildAnchors(before), after);
  assert.equal(res.b.method, "hash"); // verbatim survivor
  assert.equal(res.a.method, "quote"); // paraphrased, recovered by quote
  assert.equal(res.a.target, 0);
});

test("deleted block resolves to detached", () => {
  const before = "Only block here.\n<!-- stay:solo -->\n";
  const res = resolve(buildAnchors(before), "");
  assert.equal(res.solo.method, "detached");
  assert.equal(res.solo.target, null);
});

test("clone refuses to guess: identical twins detach, never false-attach", () => {
  const before = "Same body.\n<!-- stay:a -->\n\nSame body.\n<!-- stay:b -->\n";
  const after = "Same body.\n\nSame body.\n";
  const res = resolve(buildAnchors(before), after);
  assert.equal(res.a.method, "detached");
  assert.equal(res.b.method, "detached");
});

test("margin guard: lowering threshold/margin exposes a near-dup false attach", () => {
  const before = "Same body.\n<!-- stay:a -->\n\nSame body.\n<!-- stay:b -->\n";
  const after = "Same body.\n\nSame body.\n";
  const anchors = buildAnchors(before);
  const guarded = resolve(anchors, after, { threshold: 0.5, margin: 0.05 });
  const unguarded = resolve(anchors, after, { threshold: 0.3, margin: 0.0 });
  // guard on -> both detach; guard off -> the twins now attach (the guard's point)
  assert.ok(guarded.a.method === "detached" && guarded.b.method === "detached");
  assert.ok(unguarded.a.method === "quote" || unguarded.b.method === "quote");
});

// --- quote matcher units (ported from test_attach.py) ---------------------

test("quote matcher: exact quote wins with score 1.0", () => {
  const cands = [
    "the quick brown fox jumps",
    "a totally different sentence here",
    "the quick brown fox leaps high",
  ];
  const { index, score } = bestMatch({ quote: "the quick brown fox jumps" }, cands);
  assert.equal(index, 0);
  assert.equal(score, 1.0);
});

test("quote matcher: no good match scores below threshold", () => {
  const cands = ["the quick brown fox jumps", "a totally different sentence here"];
  const { score } = bestMatch({ quote: "completely unrelated text xyz" }, cands);
  assert.ok(score < 0.5);
});
