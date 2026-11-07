// Cost of SPEC.md §11's relocation scan (v1.11), ported from
// linter/test_relocation_cost.py. N kept ids, each block rewritten in a
// vocabulary the old text does not share (so clause 1 holds for every id and the
// window is always scanned), and RUN unmarked blocks of the old vocabulary and
// length typed directly above each marker. A document-wide scan would score every
// drifted id against all N * RUN free blocks; the window scores each against its
// own RUN. The documents come from the same fixed LCG as the other cores' tests.
// The module's internals cannot be counted from here, so this asserts wall time:
// doubling N should roughly double it, where a quadratic scan quadruples it.

import { test } from "node:test";
import assert from "node:assert/strict";

import { lintDiff } from "../src/index.js";

const WORDS = (
  "apple orchard fence river stone market window lantern harbor meadow " +
  "copper silver ledger anchor thistle bramble cedar willow quarry summit " +
  "garden basket candle mirror saddle kettle needle pebble ribbon timber"
).split(" ");
const OTHER = (
  "zebra quokka yak vulture jaguar ibex hyena gnu ferret dingo " +
  "koala lemur mink narwhal ocelot puma quail raven sloth tapir"
).split(" ");
const RUN = 2;

function relocationDocs(n, run = RUN) {
  let x = n;
  const para = (words) => {
    const out = [];
    for (let k = 0; k < 30; k++) {
      x = (Math.imul(x, 1103515245) + 12345) & 0x7fffffff;
      out.push(words[(x >>> 16) % words.length]);
    }
    const s = out.join(" ");
    return s[0].toUpperCase() + s.slice(1) + ".";
  };
  const ids = Array.from({ length: n }, (_, k) => `i${String(k).padStart(5, "0")}`);
  const before = ids.map((i) => `${para(WORDS)}\n<!-- stay:${i} -->\n\n`).join("");
  const after = ids
    .map((i) => {
      let free = "";
      for (let r = 0; r < run; r++) free += `${para(WORDS)}\n\n`;
      return `${free}${para(OTHER)}\n<!-- stay:${i} -->\n\n`;
    })
    .join("");
  return [before, after];
}

function best(n) {
  const [before, after] = relocationDocs(n);
  let out = Infinity;
  for (let k = 0; k < 3; k++) {
    const t = process.hrtime.bigint();
    lintDiff(before, after);
    out = Math.min(out, Number(process.hrtime.bigint() - t) / 1e9);
  }
  return out;
}

test("every drifted id stays HASH_DRIFT on the cost shape", () => {
  const [before, after] = relocationDocs(200);
  const codes = lintDiff(before, after).map((f) => f.code);
  assert.deepEqual(codes, Array(200).fill("HASH_DRIFT"));
});

test("the window scan's wall time roughly doubles with N", () => {
  best(100); // warm the JIT before measuring
  const small = best(200);
  const large = best(400);
  // Linear doubles, quadratic quadruples; 3.0 leaves room for a loaded machine.
  assert.ok(large / small < 3.0, `200: ${small}s, 400: ${large}s`);
});
