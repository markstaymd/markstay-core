// Cross-implementation conformance: run the shared language-neutral corpus
// (conformance/spec/ + conformance/gen/) against the JS implementation. The
// Python runner (conformance/run_py.py) asserts the same vectors against the
// reference, so together they are the cross-impl regression sentinel.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import {
  normalizeBody, bodyHash, findMarkers, parseDocument,
  lintDocument, lintDiff, sortFindings, ratio, matchingBlocks,
  quoteRatio, bodyScore, contextBonus, bestMatch,
  buildAnchors, resolve as resolveAnchors,
  stamp, restamp, repairDuplicates, mintId,
} from "../src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS = resolve(HERE, "../conformance");
const TOL = 1e-9;

/** Deep equality with a 1e-9 float tolerance, mirroring run_py.py's approx. */
function approx(a, b) {
  if (typeof a === "boolean" || typeof b === "boolean") return a === b;
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) < TOL;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => approx(x, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => Object.hasOwn(b, k) && approx(a[k], b[k]));
  }
  return a === b;
}

const show = (x) => JSON.stringify(x);

// --- canonical shapes (mirror generate.py's *_dict helpers) ---------------

const blockDict = (b) => ({
  content: b.content,
  index: b.index,
  ids: b.markers.map((m) => m.id),
  line: b.line,
  orphan: b.index === -1,
});

const findingDict = (f, withLine) =>
  withLine
    ? { level: f.level, code: f.code, id: f.id ?? null, line: f.line ?? null }
    : { level: f.level, code: f.code, id: f.id ?? null };

// --- per-category verifiers: (vector) -> { ok, got } ----------------------

function vHash(v) {
  const got = {
    normalized: normalizeBody(v.body),
    sha256: bodyHash(v.body),
    truncations: Object.fromEntries(
      Object.keys(v.truncations).map((n) => [n, bodyHash(v.body, Number(n))])
    ),
  };
  const want = { normalized: v.normalized, sha256: v.sha256, truncations: v.truncations };
  return { ok: approx(got, want), got };
}

function vMarkers(v) {
  const got = findMarkers(v.text);
  return { ok: approx(got, v.markers), got };
}

function vParse(v) {
  const got = parseDocument(v.doc).map(blockDict);
  return { ok: approx(got, v.blocks), got };
}

function vLint(v) {
  const got = sortFindings(lintDocument(v.doc).findings).map((f) => findingDict(f, true));
  return { ok: approx(got, v.findings), got };
}

function vDiff(v) {
  const got = sortFindings(lintDiff(v.before, v.after)).map((f) => findingDict(f, false));
  return { ok: approx(got, v.findings), got };
}

function vSeqmatch(v) {
  const got = { ratio: ratio(v.a, v.b), matching_blocks: matchingBlocks(v.a, v.b) };
  return { ok: approx(got, { ratio: v.ratio, matching_blocks: v.matching_blocks }), got };
}

function vScore(v) {
  if (v.fn === "ratio") {
    const got = quoteRatio(v.a, v.b);
    return { ok: approx(got, v.score), got };
  }
  if (v.fn === "body_score") {
    const got = bodyScore({ quote: v.quote }, v.candidate);
    return { ok: approx(got, v.score), got };
  }
  if (v.fn === "context_bonus") {
    const got = contextBonus({ quote: "q", prefix: v.prefix, suffix: v.suffix }, v.prev, v.next);
    return { ok: approx(got, v.bonus), got };
  }
  if (v.fn === "best_match") {
    const r = bestMatch({ quote: v.quote, prefix: v.prefix, suffix: v.suffix }, v.candidates);
    const got = { index: r.index, score: r.score, runner_up: r.runnerUp };
    const want = { index: v.index, score: v.score, runner_up: v.runner_up };
    return { ok: approx(got, want), got };
  }
  return { ok: false, got: `unknown score fn: ${v.fn}` };
}

function vResolve(v) {
  const anchors = buildAnchors(v.before);
  const res = resolveAnchors(anchors, v.after, { threshold: v.threshold, margin: v.margin });
  const got = {};
  for (const id of Object.keys(res)) {
    got[id] = { method: res[id].method, target: res[id].target, score: res[id].score };
  }
  return { ok: approx(got, v.resolutions), got };
}

const seqFactory = (ids) => {
  let i = 0;
  return () => ids[i++];
};

// Id-minting vectors (§6): a fixed byte array is the injected source, consumed
// in order across the rejection loop's random(n) draws, so rejection sampling is
// exercised identically in all three impls.
function vMint(v) {
  let i = 0;
  const random = (n) => {
    const out = Uint8Array.from(v.bytes.slice(i, i + n));
    i += n;
    return out;
  };
  const got = mintId({
    length: v.length,
    ...(v.alphabet !== undefined ? { alphabet: v.alphabet } : {}),
    random,
  });
  return { ok: approx(got, v.expected), got };
}

function vStamp(v) {
  const op = v.op;
  const o = v.options ?? {};
  let got;
  if (op === "stamp") {
    const r = stamp(v.input, {
      syntax: o.syntax ?? "html",
      hash: o.hash ?? true,
      ...(o.hashLength !== undefined ? { hashLength: o.hashLength } : {}),
      newId: seqFactory(v.ids),
    });
    got = { text: r.text, minted: r.minted };
  } else if (op === "restamp") {
    const r = restamp(v.input, {
      ...(o.hashLength !== undefined ? { hashLength: o.hashLength } : {}),
      addMissing: o.addMissing ?? false,
    });
    got = { text: r.text, refreshed: r.refreshed };
  } else if (op === "repair") {
    const r = repairDuplicates(v.input, { newId: seqFactory(v.ids) });
    got = { text: r.text, renamed: r.renamed };
  } else {
    return { ok: false, got: `unknown stamp op: ${op}` };
  }
  return { ok: approx(got, v.expected), got };
}

const VERIFIERS = {
  hash: vHash, markers: vMarkers, parse: vParse, lint: vLint,
  diff: vDiff, seqmatch: vSeqmatch, score: vScore, resolve: vResolve,
  stamp: vStamp, mint: vMint,
};

// --- drive the corpus ------------------------------------------------------

function corpusFiles() {
  const files = [];
  for (const tier of ["spec", "gen"]) {
    const dir = join(CORPUS, tier);
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      continue; // tier dir may not exist yet
    }
    for (const name of names.sort()) {
      if (name.endsWith(".json")) files.push({ tier, path: join(dir, name) });
    }
  }
  return files;
}

const files = corpusFiles();
assert.ok(files.length > 0, "no corpus files found under conformance/spec or conformance/gen");

for (const { tier, path } of files) {
  const data = JSON.parse(readFileSync(path, "utf8"));
  const verify = VERIFIERS[data.category];
  test(`${tier}/${data.category}`, async (t) => {
    assert.ok(verify, `unknown category: ${data.category}`);
    for (const v of data.vectors) {
      await t.test(v.name ?? "?", () => {
        const { ok, got } = verify(v);
        assert.ok(ok, `mismatch: got=${show(got)}`);
      });
    }
  });
}
