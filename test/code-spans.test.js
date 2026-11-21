// SPEC.md §3.5 (v1.12): a closed inline code span is content, not markup.
//
// A port of impl/py/tests/test_code_spans.py. The case that opened it: a review
// quoted one example marker twice on a line, and every tool reading the file
// reported a duplicate id that no restamp could clear. The rule is a line scan
// and is allowed to read MORE markers than a renderer does, never fewer, so most
// cases below pin where it stops: each one is a document where CommonMark could
// read the marker as a live comment.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  bodyHash,
  codeLines,
  lintDocument,
  parseDocument,
  repairDuplicates,
  restamp,
  stamp,
} from "../src/index.js";
import { markerOutsideCode, scanMarkerRecords } from "../src/markers.js";

/** A deterministic id factory: n0, n1, ... */
function ids(prefix = "n") {
  let i = 0;
  return () => `${prefix}${i++}`;
}

const blockIds = (md) => parseDocument(md).map((b) => b.markers.map((m) => m.id));

// --- what the span mask hides ----------------------------------------------

const HIDDEN = [
  "Shows `<!-- stay:demo -->` inline.\n",
  "Shows `{/* stay:demo */}` inline.\n",
  "Shows ``a ` <!-- stay:demo --> b`` with a longer run.\n",
  "Shows `<!-- stay:demo -->` and `<!-- stay:demo -->` twice.\n",
  "- an item quoting `<!-- stay:demo -->` here\n",
  "> a quote showing `<!-- stay:demo -->` here\n",
  "Shows `<!-- stay:demo -->` inline.\r\n",
  // An ordinary link before the span is passed over, and so is a checkbox.
  "See [doc](u) and `<!-- stay:demo -->` here.\n",
  "See [doc][ref] and `<!-- stay:demo -->` here.\n",
  "- [ ] an item quoting `<!-- stay:demo -->` here\n",
  // A full reference link: the label `[b]` is passed over and its `]` re-read.
  "[a][b] `<!-- stay:q -->`\n",
];

for (const md of HIDDEN) {
  test(`a marker in a closed span is content: ${JSON.stringify(md)}`, () => {
    assert.deepEqual(blockIds(md), [[]]);
  });
}

test("two identical quotes are not a duplicate", () => {
  const md = "Quote `<!-- stay:Nested01 -->` and `<!-- stay:Nested01 -->` here.\n";
  assert.deepEqual(lintDocument(md).findings, []);
});

test("a quoted marker is hashed with the body", () => {
  const body = "Shows `<!-- stay:demo -->` inline.";
  const good = `${body}\n<!-- stay:live hash=sha256:${bodyHash(body, 12)} -->\n`;
  assert.deepEqual(lintDocument(good).findings, []);
  const stripped = "Shows `` inline.";
  const old = `${body}\n<!-- stay:live hash=sha256:${bodyHash(stripped, 12)} -->\n`;
  assert.deepEqual(lintDocument(old).findings.map((f) => f.code), ["HASH_DRIFT"]);
});

test("a real marker beside a span still counts", () => {
  assert.deepEqual(blockIds("Shows `code` beside it. <!-- stay:live -->\n"), [["live"]]);
  const md = "Shows `<!-- stay:demo -->` then a real one. <!-- stay:live -->\n";
  assert.deepEqual(blockIds(md), [["live"]]);
});

test("the mask is by column, not by line", () => {
  const md = "Shows `<!-- stay:demo -->` then <!-- stay:live -->\n";
  const code = codeLines(md);
  assert.equal(code.size, 0);
  assert.deepEqual([...code.spans], [[1, [[7, 25]]]]);
  const records = scanMarkerRecords(md);
  assert.deepEqual(records.map((r) => markerOutsideCode(r, code)), [false, true]);
});

test("a span's columns and a marker's column are measured in one unit", () => {
  // Each astral character before the span is one code point and two UTF-16 code
  // units. Twenty of them shift one measure past the other by more than the
  // marker's own length, so a span scan and a marker column counted in different
  // units would put this marker outside its own span.
  const md = `${"\u{1F600}".repeat(20)} \`<!-- stay:demo -->\` then <!-- stay:live -->\n`;
  assert.deepEqual(blockIds(md), [["live"]]);
});

test("a `<` inside a marker-shaped string does not stop the scan", () => {
  // The `<` stop is for a tag or autolink that could open before a backtick. The
  // opener of a marker outside every span is neither, so the span after it closes
  // as usual and the quoted example in it is content.
  const md = "A <!-- stay:live --> then `<!-- stay:demo -->` quoted.\n";
  assert.deepEqual(blockIds(md), [["live"]]);
});

// --- where the scan stops, so the marker stays live -------------------------

const LIVE = [
  // pandoc's native writer: raw-inline HTML, not code.
  ["Shows `<!-- stay:demo -->`{=html} raw.\n", [["demo"]]],
  // GFM splits a table row's cells before any inline scan.
  ["Shows `a | <!-- stay:demo -->` with a pipe.\n", [["demo"]]],
  // A span holding a `|` stops the scan: in a table the cells split first, so
  // pairing on after it would mask a comment a renderer keeps live.
  ["a ` | x ` ` <!-- stay:live --> `\n|---|---|\n", [["live"]]],
  // An MDX-form marker is ordinary text to CommonMark: it is read, not passed
  // over, so a tag or a label opening in its value stops the scan, and so does
  // its own `{`.
  ["{/* stay:x a=\"<a b='\" */}`'> <!-- stay:live --> `\n", [["x", "live"]]],
  ["{/* stay:x a=[ */}`<!-- stay:live -->`x`\n", [["x", "live"]]],
  ["Text {/* stay:x */} `<!-- stay:demo -->`\n", [["x", "demo"]]],
  // An HTML-form marker is passed over only when its body could open nothing.
  ['Text <!-- stay:x a="<b" --> `<!-- stay:demo -->`\n', [["x", "demo"]]],
  ['Text <!-- stay:x a="b]" --> `<!-- stay:demo -->`\n', [["x", "demo"]]],
  ['Text <!-- stay:x a="{b" --> `<!-- stay:demo -->`\n', [["x", "demo"]]],
  ['Text <!-- stay:x a="a--b" --> `<!-- stay:demo -->`\n', [["x", "demo"]]],
  // A raw-text tag name not continued by a tag-name character opens a block
  // that runs across the blank line, whatever follows the name.
  ["<pre\u00a0>\n\n`<!-- stay:live -->`\n", [[], ["live"]]],
  // markdown-it folds the raw-text names by Unicode: U+017F for `s`, U+0130 and
  // U+0131 for `i`.
  ["<\u017fcript>\n\n`<!-- stay:live -->`\n", [[], ["live"]]],
  ["<scr\u0130pt>\n\n`<!-- stay:live -->`\n", [[], ["live"]]],
  ["<scr\u0131pt>\n\n`<!-- stay:live -->`\n", [[], ["live"]]],
  ["<\u017ftyle>\n\n`<!-- stay:live -->`\n", [[], ["live"]]],
  // An escaped backtick opens nothing for CommonMark.
  ["Shows \\`<!-- stay:demo -->` escaped.\n", [["demo"]]],
  // A run left open on one line may close on the next and re-pair it.
  ["A lone ` here\nthen `<!-- stay:demo -->` there.\n", [["demo"]]],
  // An HTML tag or autolink opening first outranks a code span.
  ['Text <a title="`"> `<!-- stay:demo -->`\n', [["demo"]]],
  ["Text <http://x.y/`> `<!-- stay:demo -->`\n", [["demo"]]],
  // A backtick inside a marker-shaped string stops the scan, as an opener or as
  // a closer: markdown-it does not always close a span inside a comment.
  ['Shows `<!-- stay:demo quote="`" --> after.\n', [["demo"]]],
  // A link destination or title takes a backtick before any span is looked for.
  ["[x](`) <!-- stay:live --> `\n", [["live"]]],
  ['[x](u "`") <!-- stay:live --> `\n', [["live"]]],
  // A link label still open, a reference definition, an MDX expression.
  ["[ `<!-- stay:live -->`\n", [["live"]]],
  ["[a]: /u `<!-- stay:live -->`\n", [["live"]]],
  ["{/* ` */} {/* stay:live */} {/* ` */}\n", [["live"]]],
  // A destination or label holding an unsafe character is not passed over.
  ["[x](a(b) `<!-- stay:demo -->`\n", [["demo"]]],
  ["[x][a(b] `<!-- stay:demo -->`\n", [["demo"]]],
  // A label is closed only by a `]` with no `[` or backslash before it.
  ["[[]`<!-- stay:live -->`x`\n", [["live"]]],
  ["[a\\]`<!-- stay:live -->`x`\n", [["live"]]],
  // A destination holding `{` is not ordinary: the MDX comment it opens is live.
  ["[x]({/* foo) ` */} {/* stay:live */} `\n", [["live"]]],
  // Passing over a label ends ON its `]`, which may open a destination.
  ["[a][x](`) <!-- stay:live --> `\n", [["live"]]],
  // A backtick inside a marker-shaped string stops the scan.
  ['A <!-- stay:live quote="`" --> then `<!-- stay:demo -->`\n', [["live", "demo"]]],
  // A line starting with a comment is an HTML block: no inline content.
  ["Para.\n<!-- stay:live --> `<!-- stay:demo -->`\n", [["live", "demo"]]],
];

for (const [md, expected] of LIVE) {
  test(`the scan leaves a possibly live marker alone: ${JSON.stringify(md)}`, () => {
    assert.deepEqual(blockIds(md), expected);
  });
}

// The cases above keep the marker live even if their stop is removed, because the
// pairing they would otherwise make leaves it outside every span anyway. These
// shift the pairing so that removing the stop would hide a live comment.
const SHIFTED = [
  ['Text <a title="`"> `x` <!-- stay:demo --> `\n', [["demo"]]],
  ["Text <http://x.y/`> `x` <!-- stay:demo --> `\n", [["demo"]]],
  ['A <!-- stay:live quote="`" --> `x` <!-- stay:demo --> `\n', [["live", "demo"]]],
];

for (const [md, expected] of SHIFTED) {
  test(`a stop keeps a shifted pairing from hiding a live marker: ${JSON.stringify(md)}`, () => {
    assert.deepEqual(blockIds(md), expected);
  });
}

test("a block opened after its container ends is tracked", () => {
  // The `<div>` block ends with its list item, and `<pre>` opens a new block
  // that runs to `</pre>` across the blank line, so the comment is raw HTML.
  const md = "- <div>\n<pre>\n\n`<!-- stay:live -->`\n";
  assert.deepEqual(blockIds(md), [[], ["live"]]);
});

test("the scan resumes once every tracked block has ended", () => {
  const md = "- <div>\n<pre>\n</pre>\n\nAfter `<!-- stay:demo -->`.\n";
  assert.deepEqual(blockIds(md), [[], []]);
});

test("an HTML-form marker whose body could open nothing is passed over", () => {
  assert.deepEqual(blockIds("Text <!-- stay:x --> `<!-- stay:demo -->`\n"), [["x"]]);
});

test("a tag name continued by a name character is no raw-text block", () => {
  // `<prefix>` is not `<pre`, so it is an ordinary HTML block ending at the
  // blank line, and the scan resumes after it.
  assert.deepEqual(blockIds("<prefix>\n\n`<!-- stay:demo -->`\n"), [[], []]);
});

test("a blank line restarts the scan", () => {
  const md = "A lone ` here\n\nthen `<!-- stay:demo -->` there.\n";
  assert.deepEqual(blockIds(md), [[], []]);
});

test("spans before a stop on the same line stand", () => {
  const md = "Shows `<!-- stay:demo -->` then <b> `<!-- stay:demo -->`\n";
  assert.deepEqual(blockIds(md), [["demo"]]);
});

test("a run-on HTML block runs across blank lines", () => {
  const md = "Intro.\n\n<pre>\n\n`<!-- stay:demo -->`\n\n</pre>\n\nAfter `<!-- stay:x -->`.\n";
  assert.deepEqual(blockIds(md), [[], [], ["demo"], [], []]);
});

test("fence lines neither pair nor get scanned", () => {
  const md = "Intro `x\n```\ncode\n```\nthen `<!-- stay:demo -->`.\n";
  assert.deepEqual(blockIds(md), [[]]);
});

// --- writing ----------------------------------------------------------------

test("stamp gives a paragraph quoting a marker a stay of its own", () => {
  const md = "Shows `<!-- stay:demo hash=sha256:7a9c -->` inline.\n";
  const out = stamp(md, { newId: ids() });
  const body = "Shows `<!-- stay:demo hash=sha256:7a9c -->` inline.";
  assert.equal(out.text, `${md}<!-- stay:n0 hash=sha256:${bodyHash(body, 12)} -->\n`);
});

test("restamp leaves a quoted example alone", () => {
  const md =
    "Shows `<!-- stay:demo hash=sha256:7a9c -->` inline.\n" +
    "<!-- stay:live hash=sha256:0000 -->\n";
  const out = restamp(md);
  assert.ok(out.text.includes("`<!-- stay:demo hash=sha256:7a9c -->`"));
  assert.equal(out.text.split("hash=sha256:7a9c").length - 1, 1);
  assert.deepEqual(lintDocument(out.text).findings, []);
});

test("repair leaves two identical quotes alone", () => {
  const md = "Quote `<!-- stay:demo -->` and `<!-- stay:demo -->` here.\n";
  assert.equal(repairDuplicates(md, { newId: ids() }).text, md);
});
