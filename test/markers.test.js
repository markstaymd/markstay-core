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
