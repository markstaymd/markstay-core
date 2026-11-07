import { test } from "node:test";
import assert from "node:assert/strict";

import {
  findMarkers,
  lintBlocks,
  lintDocument,
  parseDocument,
  rewriteMarkers,
  stripMarkers,
} from "../src/index.js";

test("strict marker grammar normalizes LF but preserves raw and line geometry", () => {
  const raw = '<!-- stay:x x-note="a\r\nb" -->';
  const [marker] = findMarkers(`one\rtwo\r${raw}`);
  assert.equal(marker.id, "x");
  assert.equal(marker.raw, raw);
  assert.equal(marker.line, 3);
  assert.equal(marker.malformed, false);
});

test("line count runs across skipped openers, CRLF, and lineOffset", () => {
  // Skipped: a non-marker comment, an unclosed MDX opener, a `--!>` close.
  const text =
    "a\r\n<!-- note -->\r\n<!-- stay:x -->\r\n{/* stay:bad\r\n\r<!-- stay:y --!>\n<!-- stay:z -->";
  assert.deepEqual(
    findMarkers(text, 10).map((marker) => [marker.id, marker.line]),
    [["x", 13], ["z", 17]],
  );
  // lineOffset + (lines before + 1), one rounding, as a count from zero gives.
  const [far] = findMarkers("\n\n<!-- stay:A -->", Number.MAX_SAFE_INTEGER);
  assert.equal(far.line, Number.MAX_SAFE_INTEGER + 3);
});

test("complete body validation rejects malformed attrs, escapes, and LF separators", () => {
  for (const text of [
    "<!-- stay:x broken -->",
    '<!-- stay:x x-note="a\\q" -->',
    "<!-- stay:x\nhash=sha256:aa -->",
    "<!-- stay:x hash=sha256:deadZ -->",
  ]) {
    const found = findMarkers(text);
    if (text.includes("deadZ")) {
      assert.equal(found.length, 1);
      assert.equal(found[0].hash, null, text);
    } else {
      assert.deepEqual(found, [], text);
    }
  }
});

test("HTML discovery obeys the first host closer and resumes after rejection", () => {
  for (const bad of [
    '<!-- stay:bad x-note="a-->b" -->',
    '<!-- stay:bad x-note="a--!>b" -->',
  ]) {
    const text = `${bad}\n<!-- stay:good -->`;
    assert.deepEqual(findMarkers(text).map((m) => m.id), ["good"]);
    assert.equal(stripMarkers(text), `${bad}\n`);
  }
});

test("MDX discovery stops at the first block-comment closer", () => {
  const bad = '{/* stay:bad x-note="a*/b" */}';
  const text = `${bad}\n{/* stay:good */}`;
  assert.deepEqual(findMarkers(text).map((m) => m.id), ["good"]);
  assert.equal(stripMarkers(text), `${bad}\n`);
});

test("every opener is independent, including one nested in a valid marker", () => {
  const accepted = '<!-- stay:outer x-note="{/* stay:inner */}" -->';
  assert.deepEqual(findMarkers(accepted).map((m) => m.id), ["outer", "inner"]);
  assert.equal(stripMarkers(accepted), "");
  assert.equal(rewriteMarkers(accepted, () => "changed"), accepted);

  const rejected = "<!-- stay:bad broken {/* stay:inner */} -->";
  assert.deepEqual(findMarkers(rejected).map((m) => m.id), ["inner"]);
});

test("overlapping rejection caches distinguish grammar states and host closers", () => {
  const multiline = '<!--stay:outer a="line\\\"one\r\n{/*stay:inner */}\rline\\\\two" -->';
  const text = [
    '<!--stay:bad a="<!--stay:recovered -->',
    '{/*stay:bad a="{/*stay:mdx */}',
    '<!--stay:bad a="{/*stay:other */} -->',
    multiline,
    '<!--stay:next empty="" hash=sha256:ABCD -->',
    '<!--stay:bad a="tab\tvalue" -->',
    '<!--stay:note=value --!>',
    '{/*stay:note=value */x',
  ].join("\r\n");
  const markers = findMarkers(text, 7);
  assert.deepEqual(markers.map((m) => m.id), [
    "recovered", "mdx", "other", "outer", "inner", "next", null, null,
  ]);
  assert.deepEqual(markers.map((m) => m.line), [8, 9, 10, 11, 12, 14, 16, 17]);
  assert.equal(markers[3].raw, multiline);
  assert.equal(markers[5].hash, "abcd");
  assert.ok(markers.slice(-2).every((m) => m.malformed));
});

test("4000 overlapping attribute suffixes reject and preserve later valid markers", () => {
  for (const [prefix, closer] of [["<!--stay:x a=", "-->"], ["{/*stay:x a=", "*/}"]]) {
    const rejected = prefix.repeat(4000) + "\n" + closer;
    // Both the preflight and body parser read char codes. Count their work
    // rather than relying on a wall-clock limit; removing memoization must fail.
    const original = String.prototype.charCodeAt;
    let reads = 0;
    let markers;
    try {
      String.prototype.charCodeAt = function (index) {
        reads += 1;
        return original.call(this, index);
      };
      markers = findMarkers(rejected);
    } finally {
      String.prototype.charCodeAt = original;
    }
    assert.deepEqual(markers, []);
    assert.ok(reads >= rejected.length && reads <= 9 * rejected.length, `parser character reads: ${reads}`);
    const text = `${rejected}\r\n<!--stay:after note="a\r\n\r\nb" -->`;
    const [marker] = findMarkers(text);
    assert.equal(marker.id, "after");
    assert.equal(marker.line, 3);
    assert.equal(stripMarkers(text), `${rejected}\r\n`);
  }
});

test("malformed no-id diagnostics remain body text and are never rewritten", () => {
  const malformed = "<!-- stay:note=hello -->";
  let calls = 0;
  assert.equal(stripMarkers(malformed), malformed);
  assert.equal(rewriteMarkers(malformed, () => { calls += 1; return "changed"; }), malformed);
  assert.equal(calls, 0);

  const block = parseDocument(`Body.\n${malformed}`)[0];
  assert.equal(block.content, `Body.\n${malformed}`);
  assert.equal(block.markers[0].malformed, true);
  assert.deepEqual(lintDocument(`Body.\n${malformed}`).findings.map((f) => f.code), [
    "MALFORMED_MARKER",
  ]);
});

test("parseDocument keeps a marker's original CRLF serialization", () => {
  const raw = '<!-- stay:x x-note="a\r\nb" -->';
  const [block] = parseDocument(`Body.\r\n${raw}\r\n`);
  assert.equal(block.markers[0].raw, raw);
  assert.equal(block.content, "Body.");
});

test("parseDocument discovers a quoted marker spanning a blank line", () => {
  const raw = '<!-- stay:x x-note="a\r\n\r\nb" -->';
  const [block] = parseDocument(`Body.\r\n${raw}\r\n`);
  assert.equal(block.content, "Body.");
  assert.equal(block.markers[0].raw, raw);
});

test("the required key-first diagnostic survives an invalid marker closer", () => {
  const text = "<!-- stay:note=hello --!>\n{/* stay:note=hello */x";
  const markers = findMarkers(text);
  assert.equal(markers.length, 2);
  assert.ok(markers.every((marker) => marker.malformed && marker.id === null));
  assert.deepEqual(markers.map((marker) => marker.raw), [
    "<!-- stay:note=hello --!>",
    "{/* stay:note=hello */",
  ]);
  assert.equal(
    lintDocument(text).findings.filter((finding) => finding.code === "MALFORMED_MARKER").length,
    2,
  );
});

test("exact parsed subhash key presence is independent of digest validity", () => {
  const text = [
    "<!-- stay:a subhash=bogus -->",
    '<!-- stay:b subhash="sha256:abcd" -->',
    "<!-- stay:c x-subhash=sha256:abcd -->",
    '<!-- stay:d x-note="a subhash=bogus" -->',
  ].join("\n");
  const markers = findMarkers(text);
  assert.deepEqual(markers.map((m) => m.hasSubhash), [true, true, false, false]);
  assert.deepEqual(markers.map((m) => m.subhash), [null, null, null, null]);
});

test("orphan attribution precedes subhash exclusion and hash drift", () => {
  for (const attribute of [
    "subhash=sha256:dead",
    "subhash=bogus",
    'subhash="sha256:dead"',
    "x-subhash=bogus",
  ]) {
    const [marker] = findMarkers(
      `<!-- stay:orphan ${attribute} hash=sha256:dead -->`,
    );
    const findings = lintBlocks([
      { content: "Different body.", markers: [marker], line: 1, index: -1 },
    ]);
    assert.deepEqual(
      findings.map((finding) => finding.code),
      ["ORPHAN_MARKER"],
      attribute,
    );
  }
});
