// Write-path tests (SPEC.md §3 / §4 / §6 / §7 / §8): id minting, marker
// serialization, stamping an unmarked corpus, hash refresh, and duplicate repair.
// The strong invariants checked here are: stamping never changes block bodies,
// the result lints clean, and every write op is idempotent.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  mintId,
  ID_CHARSET,
  formatMarker,
  formatAttrValue,
  stamp,
  restamp,
  repairDuplicates,
  parseDocument,
  lintDocument,
  findMarkers,
  bodyHash,
} from "../src/index.js";

// Deterministic id factory for reproducible assertions. Collision-avoidance in
// the write helpers wraps this, so plain sequential ids are fine.
function counter(prefix = "id") {
  let n = 0;
  return () => `${prefix}${String(n++).padStart(2, "0")}`;
}

const bodies = (md) => parseDocument(md).filter((b) => b.index >= 0).map((b) => b.content);
const errorCodes = (md) => lintDocument(md).findings.filter((f) => f.level === "error").map((f) => f.code);

// --- mintId (§6) ---

test("mintId: default ids match the §6 charset and length", () => {
  for (let i = 0; i < 200; i++) {
    const id = mintId();
    assert.equal(id.length, 8);
    assert.ok(ID_CHARSET.test(id), `${id} not in charset`);
  }
});

test("mintId: injectable byte source makes it deterministic", () => {
  const zeros = (k) => Buffer.alloc(k, 0); // every byte 0 -> alphabet[0] = 'A'
  assert.equal(mintId({ random: zeros }), "AAAAAAAA");
  assert.equal(mintId({ length: 3, random: zeros }), "AAA");
});

test("mintId: rejects degenerate parameters", () => {
  assert.throws(() => mintId({ length: 0 }));
  assert.throws(() => mintId({ alphabet: "x" }));
});

// --- formatAttrValue / formatMarker (§3 / §4) ---

test("formatAttrValue: bare vs quoted with escaping", () => {
  assert.equal(formatAttrValue("sha256:7a9c"), "sha256:7a9c");
  assert.equal(formatAttrValue("two words"), '"two words"');
  assert.equal(formatAttrValue('a"b\\c'), '"a\\"b\\\\c"');
});

test("formatMarker: html and mdx forms round-trip through findMarkers", () => {
  const html = formatMarker({ id: "8f24", hash: "7a9c" });
  assert.equal(html, "<!-- stay:8f24 hash=sha256:7a9c -->");
  const mdx = formatMarker({ id: "8f24", hash: "7a9c", syntax: "mdx" });
  assert.equal(mdx, "{/* stay:8f24 hash=sha256:7a9c */}");
  for (const raw of [html, mdx]) {
    const [mk] = findMarkers(raw);
    assert.equal(mk.id, "8f24");
    assert.equal(mk.hash, "7a9c");
    assert.equal(mk.malformed, false);
  }
});

test("formatMarker: extension attrs, and uppercase hash folds to lowercase", () => {
  const m = formatMarker({ id: "x1", hash: "ABCD", attrs: { "x-acme-note": "hi there" } });
  assert.equal(m, '<!-- stay:x1 hash=sha256:abcd x-acme-note="hi there" -->');
});

test("formatMarker: rejects bad id, non-hex hash, and terminator-bearing values", () => {
  assert.throws(() => formatMarker({ id: "bad id" }));
  assert.throws(() => formatMarker({ id: "ok", hash: "zz" }));
  assert.throws(() => formatMarker({ id: "ok", attrs: { "x-k": "a-->b" } }));
  assert.throws(() => formatMarker({ id: "ok", attrs: { "x-k": "a*/}b" }, syntax: "mdx" }));
});

// --- stamp (§5 / §6 / §8) ---

const DOC = `# Title

First paragraph.

Second paragraph.

- a
- b
`;

test("stamp: marks every unmarked block, leaves bodies unchanged, lints clean", () => {
  const before = bodies(DOC);
  const { text, minted } = stamp(DOC, { newId: counter() });
  assert.equal(minted.length, before.length); // one id per content block
  assert.deepEqual(bodies(text), before); // bodies untouched
  assert.deepEqual(errorCodes(text), []); // clean
  // every block now carries exactly one well-formed id
  for (const b of parseDocument(text).filter((x) => x.index >= 0)) {
    const ids = b.markers.filter((m) => m.id && !m.malformed);
    assert.equal(ids.length, 1);
  }
});

test("stamp: canonical §3.1 trailing shape, with a fresh matching hash", () => {
  const { text } = stamp("Hello world.", { newId: () => "abc12345" });
  assert.equal(text, `Hello world.\n<!-- stay:abc12345 hash=sha256:${bodyHash("Hello world.", 12)} -->`);
});

test("stamp: idempotent and leaves already-marked blocks alone", () => {
  const once = stamp(DOC, { newId: counter("a") }).text;
  const twice = stamp(once, { newId: counter("b") });
  assert.equal(twice.minted.length, 0);
  assert.equal(twice.text, once);
});

test("stamp: a marker-only chunk after a block already identifies it", () => {
  const md = "Para body.\n\n<!-- stay:keep hash=sha256:0000 -->\n\nOther.";
  const { text, minted } = stamp(md, { newId: () => "new0" });
  assert.equal(minted.length, 1); // only "Other." is unmarked
  assert.equal(minted[0].id, "new0");
  assert.ok(text.includes("stay:keep"));
});

test("stamp: minted ids never collide with existing ids", () => {
  const md = "A.\n<!-- stay:id00 -->\n\nB.";
  // factory would re-propose id00; collision-avoidance must skip it
  const proposals = ["id00", "id00", "id01"];
  let i = 0;
  const { minted } = stamp(md, { newId: () => proposals[i++] });
  assert.equal(minted.length, 1);
  assert.equal(minted[0].id, "id01");
});

test("stamp: mdx syntax and --no-hash", () => {
  const { text } = stamp("Body.", { newId: () => "m1", syntax: "mdx", hash: false });
  assert.equal(text, "Body.\n{/* stay:m1 */}");
});

test("stamp: hashLength controls the written precision", () => {
  const { text } = stamp("Body.", { newId: () => "h1", hashLength: 4 });
  const [mk] = findMarkers(text);
  assert.equal(mk.hash.length, 4);
  assert.equal(mk.hash, bodyHash("Body.", 4));
});

// --- restamp (§8) ---

test("restamp: refreshes a drifted hash and then lints clean", () => {
  const stamped = stamp("Original body.", { newId: () => "r1" }).text;
  const edited = stamped.replace("Original body.", "Edited body now.");
  assert.deepEqual(lintDocument(edited).findings.map((f) => f.code), ["HASH_DRIFT"]);
  const { text, refreshed } = restamp(edited);
  assert.deepEqual(refreshed, ["r1"]);
  assert.deepEqual(lintDocument(text).findings, []);
});

test("restamp: no-op when nothing drifted", () => {
  const stamped = stamp(DOC, { newId: counter() }).text;
  const { text, refreshed } = restamp(stamped);
  assert.deepEqual(refreshed, []);
  assert.equal(text, stamped);
});

test("restamp: preserves each marker's stored hash precision", () => {
  // stored 4-char hash, content changed -> refreshed value is still 4 chars
  const md = "New text here.\n<!-- stay:p1 hash=sha256:0000 -->";
  const { text } = restamp(md);
  const [mk] = findMarkers(text);
  assert.equal(mk.hash.length, 4);
  assert.equal(mk.hash, bodyHash("New text here.", 4));
});

test("restamp: addMissing gives a hashless marker a hash", () => {
  const md = "Body text.\n<!-- stay:n1 -->";
  const { text, refreshed } = restamp(md, { addMissing: true });
  assert.deepEqual(refreshed, ["n1"]);
  const [mk] = findMarkers(text);
  assert.equal(mk.hash, bodyHash("Body text.", 12));
});

// --- repairDuplicates (§7) ---

test("repairDuplicates: first occurrence kept, later ones re-minted, lints clean", () => {
  const md =
    "Para one.\n<!-- stay:dup hash=sha256:0000 -->\n\n" +
    "Para two.\n<!-- stay:dup hash=sha256:1111 -->";
  assert.ok(errorCodes(md).includes("DUPLICATE_ID"));
  const { text, renamed } = repairDuplicates(md, { newId: () => "fresh1" });
  assert.deepEqual(renamed, [{ from: "dup", to: "fresh1" }]);
  assert.ok(text.includes("stay:dup")); // first kept
  assert.ok(text.includes("stay:fresh1")); // second re-minted
  assert.deepEqual(errorCodes(text), []);
});

test("repairDuplicates: no-op when there are no duplicates", () => {
  const md = stamp(DOC, { newId: counter() }).text;
  const { text, renamed } = repairDuplicates(md);
  assert.deepEqual(renamed, []);
  assert.equal(text, md);
});

test("repairDuplicates: a re-minted id never collides with an existing id", () => {
  const md =
    "One.\n<!-- stay:dup -->\n\nTwo.\n<!-- stay:dup -->\n\nThree.\n<!-- stay:taken -->";
  const proposals = ["taken", "ok1"]; // first proposal clashes, must be skipped
  let i = 0;
  const { renamed } = repairDuplicates(md, { newId: () => proposals[i++] });
  assert.deepEqual(renamed, [{ from: "dup", to: "ok1" }]);
});
