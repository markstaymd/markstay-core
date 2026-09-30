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
  bestMatch, buildAnchors, checkEntries, resolve,
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

test("subhash markers stay lexical for duplicate ids but never bind to containers", () => {
  const md =
    "<!-- stay:child subhash=bogus hash=sha256:dead -->\n\n" +
    "Body.\n<!-- stay:child subhash=bogus hash=sha256:dead -->\n";
  const { findings } = lintDocument(md);
  assert.deepEqual(codes(findings), ["DUPLICATE_ID", "ORPHAN_MARKER"]);
});

test("x-subhash is an ordinary block attribute", () => {
  const { findings } = lintDocument(
    "Body.\n<!-- stay:block x-subhash=sha256:abcd hash=sha256:dead -->\n",
  );
  assert.deepEqual(codes(findings), ["HASH_DRIFT"]);
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

test("diff reports a lost child id as a child drop, never as container identity", () => {
  const before = "Body.\n<!-- stay:child subhash=bogus -->\n";
  assert.deepEqual(
    lintDiff(before, "Body.\n").map((f) => [f.level, f.code, f.id]),
    [["error", "DROPPED_CHILD_ID", "child"]]
  );
  // Kept on the item it moved to, or carried by any marker at all, it is not lost.
  assert.deepEqual(lintDiff(before, "Body.\n<!-- stay:child -->\n").map((f) => f.code), ["NEW_ID"]);
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

test("anchors and MARKER lookup exclude exact-key subhash markers", () => {
  const before =
    "Body.\n" +
    "<!-- stay:child subhash=bogus -->\n" +
    "<!-- stay:custom x-subhash=bogus -->\n" +
    "<!-- stay:parent -->\n";
  assert.deepEqual(buildAnchors(before).map((a) => a.id), ["custom", "parent"]);

  const ordinary = "Body.\n<!-- stay:c -->\n";
  const child = "Body.\n<!-- stay:c subhash=bogus -->\n";
  assert.equal(resolve(buildAnchors(ordinary), child).c.method, "hash");
});

test("staged pairing ignores overlap supplied only by child ids", () => {
  const result = checkEntries([
    {
      status: "D", src: "old.md", dst: "old.md",
      before: "Old.\n<!-- stay:c subhash=bogus -->\n", after: null,
    },
    {
      status: "A", src: "new.md", dst: "new.md", before: null,
      after: "New.\n<!-- stay:c subhash=bogus -->\n",
    },
  ]);
  assert.deepEqual(result.pairings, [{ path: "new.md", baseline: null }]);
  assert.deepEqual(result.notes, []);
  assert.deepEqual(result.reports, []);
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

// --- leading YAML frontmatter is metadata, not a block (SPEC.md §5) -------

const FM_DOC = "---\nstatus: active\nowner: tim\n---\n\n# Heading\n\nBody para.\n";
const contents = (md) => parseDocument(md).map((b) => b.content);

test("frontmatter is not a block", () => {
  assert.deepEqual(contents(FM_DOC), ["# Heading", "Body para."]);
});

test("frontmatter does not shift line numbers", () => {
  // blanking is line-for-line, so reported lines stay true to the source
  assert.deepEqual(
    parseDocument(FM_DOC).map((b) => [b.index, b.line]),
    [[0, 6], [1, 8]]
  );
});

test("a metadata-only edit does not drift a content hash", () => {
  const before = parseDocument(FM_DOC).map((b) => bodyHash(b.content));
  const after = parseDocument(FM_DOC.replace("status: active", "status: complete"))
    .map((b) => bodyHash(b.content));
  assert.deepEqual(after, before);
});

test("a leading --- with no closing fence is a thematic break", () => {
  assert.deepEqual(contents("---\n\n# Heading\n\nBody para.\n"), [
    "---", "# Heading", "Body para.",
  ]);
});

test("frontmatter does not swallow a paragraph between two thematic breaks", () => {
  // Regression, found by external review of the reference: the naive
  // first-closing-fence rule silently ate `Intro paragraph.`
  assert.deepEqual(contents("---\n\nIntro paragraph.\n\n---\n\nBody.\n"), [
    "---", "Intro paragraph.", "---", "Body.",
  ]);
});

test("frontmatter does not swallow a setext heading", () => {
  // `---` / `Title` / `---` is a thematic break plus a setext H2; the payload has
  // to look like YAML before the span is treated as metadata.
  assert.ok(contents("---\nTitle\n---\n\nBody.\n").join("\n").includes("Title"));
});

test("frontmatter does not swallow an ATX heading", () => {
  // Regression, found by external review: a YAML comment and an ATX heading are
  // byte-identical, so `#` cannot be the evidence that a span is frontmatter.
  assert.ok(contents("---\n# Heading\n---\nBody.\n").join("\n").includes("# Heading"));
  assert.ok(
    contents("---\n# just a comment\n---\n\nBody.\n").join("\n").includes("# just a comment")
  );
});

test("a payload with a blank line is not frontmatter", () => {
  // Fails towards ordinary Markdown: not skipping is a stray drift warning, while
  // over-skipping silently destroys content.
  assert.ok(contents("---\nstatus: active\n\nowner: tim\n---\n\nBody.\n")
    .some((c) => c.includes("status: active")));
});

test("an empty payload is not frontmatter", () => {
  assert.ok(contents("---\n---\n\nBody.\n").some((c) => c.includes("---")));
});

test("yaml-ish payload forms are recognized", () => {
  for (const payload of ["status: active", "- one\n- two", "empty:", "nested:\n  a: 1"]) {
    assert.deepEqual(contents(`---\n${payload}\n---\n\nBody.\n`), ["Body."], payload);
  }
});

test("the closing fence tolerates trailing whitespace and accepts ...", () => {
  assert.deepEqual(contents("---\nkey: v\n---   \n\nBody.\n"), ["Body."]);
  assert.deepEqual(contents("---\ntitle: t\n...\n\n# Heading\n\nBody.\n"), [
    "# Heading", "Body.",
  ]);
});

test("CRLF is normalized before frontmatter detection", () => {
  assert.deepEqual(contents("---\r\nkey: v\r\n---\r\n\r\n# H\r\n\r\nBody.\r\n"), [
    "# H", "Body.",
  ]);
});

test("frontmatter is only recognized at document start", () => {
  const md = "# Heading\n\n---\ntitle: not frontmatter\n---\n\nBody.\n";
  assert.ok(contents(md).join("\n").includes("title: not frontmatter"));
});

test("no blank line after the closing fence still splits correctly", () => {
  // A filter-the-chunks-afterwards implementation gets this one wrong.
  assert.deepEqual(contents("---\ntitle: t\n---\n# Heading\n\nBody.\n"), [
    "# Heading", "Body.",
  ]);
});

test("frontmatter: the yaml-ish test is ASCII-pinned, not runtime whitespace", () => {
  // Cross-language agreement, found by external review of the port: `\S` means
  // three different things in Python, ECMAScript and Rust, so the rule spells the
  // ASCII set out. An ASCII control character is not a key start (the span stays
  // ordinary Markdown); an exotic non-ASCII space is, exactly as for hashing (§8),
  // where NBSP is content rather than whitespace.
  assert.ok(
    contents("---\n\x1ckey: v\n---\n\nBody.\n").some((c) => c.includes("key: v")),
    "an ASCII control is not a key start"
  );
  for (const ch of [" ", "", "﻿"]) {
    assert.deepEqual(contents(`---\n${ch}key: v\n---\n\nBody.\n`), ["Body."], JSON.stringify(ch));
    assert.deepEqual(contents(`---\n- ${ch}\n---\n\nBody.\n`), ["Body."], JSON.stringify(ch));
  }
});

test("a marker after the closing fence is an orphan", () => {
  // The visible consequence for a doc stamped before this change.
  const { findings } = lintDocument("---\nkey: v\n---\n<!-- stay:x -->\n\nBody.\n");
  assert.ok(codes(findings).includes("ORPHAN_MARKER"));
});

test("a marker inside the frontmatter payload is dropped", () => {
  // Pins actual behaviour: the marker is blanked with the rest of the metadata and
  // raises nothing. No tool writes one there (the stamper writes after the block).
  const { findings } = lintDocument("---\nkey: v\n<!-- stay:x -->\n---\n\nBody.\n");
  assert.deepEqual(codes(findings), []);
});
