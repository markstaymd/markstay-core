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
  PRESERVE_INSTRUCTION, PRESERVE_RETURN_ONLY, preserveWrap,
  checkEntries,
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

// Phase 2 adds parsed key-presence fields to the public Marker. Keep the v1.5
// corpus projection stable until the v1.6 vectors change the shared schema.
const markerDict = (m) => ({
  id: m.id,
  hash: m.hash,
  raw: m.raw,
  syntax: m.syntax,
  line: m.line,
  malformed: m.malformed,
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
  const got = findMarkers(v.text).map(markerDict);
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

// What `buildAnchors` STORES (§9), as opposed to what `resolve` decides. A
// separate category because resolution cannot see it: an implementation storing
// whole neighbour blocks and one storing §9's 48-character window resolve
// identically, since both window at match time. §9 constrains the stored field.
function vAnchors(v) {
  const got = buildAnchors(v.document).map((a) => ({
    id: a.id, hash: a.hash, quote: a.selector.quote,
    prefix: a.selector.prefix, suffix: a.selector.suffix,
  }));
  return { ok: approx(got, v.anchors), got };
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

// §11 preservation-instruction vectors. The instruction text ships as a constant
// in this package (an installed package has no corpus on disk), so this is what
// holds that copy byte-identical to the Python and Rust ones.
function vPreserve(v) {
  let got;
  if (v.fn === "instruction") got = PRESERVE_INSTRUCTION;
  else if (v.fn === "return_only") got = PRESERVE_RETURN_ONLY;
  else if (v.fn === "wrap") got = preserveWrap(v.doc, v.task ?? null);
  else return { ok: false, got: `unknown preserve fn: ${v.fn}` };
  return { ok: approx(got, v.expected), got };
}

// Commit-shaped baseline pairing and findings, with Git already materialized.
function vCheck(v) {
  const result = checkEntries(v.entries, { scope: v.scope ?? [] });
  const got = {
    pairings: result.pairings,
    reports: result.reports.map(([label, findings]) => ({
      label,
      findings: sortFindings(findings).map((f) => findingDict(f, true)),
    })),
    notes: result.notes,
    hasErrors: result.hasErrors,
  };
  return { ok: approx(got, v.expected), got };
}

const VERIFIERS = {
  hash: vHash, markers: vMarkers, parse: vParse, lint: vLint,
  diff: vDiff, seqmatch: vSeqmatch, score: vScore, resolve: vResolve,
  stamp: vStamp, mint: vMint, preserve: vPreserve, check: vCheck,
  anchors: vAnchors,
};

// --- drive the corpus ------------------------------------------------------

// Optional profiles a corpus file may declare with a top-level `profile` key.
// Every full runner knows the whole set; each advertises only what it
// implements. A profile this runner has never HEARD of is a failure rather than
// a skip, so a category added to the corpus without touching the runners cannot
// pass as silence.
//
// §16 keeps §5.5 and §5.6 child segmentation OPTIONAL, and only the Python
// reference implements it, so declining `rows` is conforming. Running 419 of
// the 420 core vectors would not be, which is why the core count is asserted
// below rather than left to whatever happens to be on disk.
const KNOWN_PROFILES = new Set(["rows"]);
const ADVERTISED_PROFILES = new Set();
const CORE_VECTORS = 420;

function corpusFiles() {
  const files = [];
  for (const tier of ["spec", "gen", "rows"]) {
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

const all = corpusFiles().map((f) => ({
  ...f,
  data: JSON.parse(readFileSync(f.path, "utf8")),
}));
assert.ok(all.length > 0, "no corpus files found under conformance/spec or conformance/gen");

const unknownProfile = all.filter(
  ({ data }) => data.profile != null && !KNOWN_PROFILES.has(data.profile),
);
const files = all.filter(
  ({ data }) => data.profile == null || ADVERTISED_PROFILES.has(data.profile),
);
const declinedFiles = all.filter(
  ({ data }) =>
    data.profile != null &&
    KNOWN_PROFILES.has(data.profile) &&
    !ADVERTISED_PROFILES.has(data.profile),
);

test("no corpus file declares a profile this runner has never heard of", () => {
  assert.deepEqual(
    unknownProfile.map(({ data }) => data.profile),
    [],
    "a new optional profile must be added to KNOWN_PROFILES, then advertised or " +
      "deliberately declined; silently skipping it is the failure this asserts",
  );
});

test("every core vector runs here, and every declined one is accounted for", () => {
  const core = files.reduce((n, { data }) => n + data.vectors.length, 0);
  assert.equal(core, CORE_VECTORS, "core corpus vector count");
  const declined = declinedFiles.map(
    ({ data }) => `${data.profile}:${data.vectors.length}`,
  );
  assert.deepEqual(declined, ["rows:23"], "declined optional profiles");
});

// A verifier with no vectors is a check that silently is not running, and the
// hundreds of unrelated vectors keep the suite green while it does nothing. That
// is the failure class this project exists to catch, so a category missing from
// the corpus fails here rather than passing quietly.
test("every verifier has vectors in the corpus", () => {
  const seen = new Set(files.map(({ data }) => data.category));
  const missing = Object.keys(VERIFIERS).filter((c) => !seen.has(c)).sort();
  assert.deepEqual(missing, [], `verifiers with no vectors: ${missing.join(", ")}`);
});

for (const { tier, data } of files) {
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
