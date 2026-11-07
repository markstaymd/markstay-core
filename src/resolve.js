// The attachment resolver: the §9.1 evidence ladder (MARKER -> HASH -> QUOTE ->
// DETACHED), assigning blocks exclusively (v1.11). Anchor construction ports
// eval/attachment/resolver.py's `build_anchors`; the exclusive ladder and the
// merge exemption are written from §9.1's text and the conformance vectors.

import { bodyHash } from "./hash.js";
import { isBlockStayMarker } from "./markers.js";
import { parseDocument } from "./parse.js";
import { normalize, rankMatches, windowPrefix, windowSuffix } from "./quote.js";

// Default thresholds for the QUOTE tier (SPEC.md §9 commit rule). A recovery is
// committed only when the best candidate clears `threshold` AND beats the
// runner-up by `margin`.
export const DEFAULT_THRESHOLD = 0.5;
export const DEFAULT_MARGIN = 0.05;

// §9.1's merge exemption fails outright when more than this many stays select
// one block at the QUOTE tier, before any other check.
export const MERGE_CONTENDER_CAP = 16;

/**
 * Extract anchors from an annotated baseline document. Each non-orphan block
 * with a well-formed marker contributes one anchor carrying the block's full
 * body hash and a quote selector built from the block and its neighbours.
 * The `mode` MUST match the mode passed to `resolve`.
 *
 * Returns anchor objects: { id, hash, selector: { quote, prefix, suffix } }.
 */
export function buildAnchors(beforeMd, mode = "blank-line") {
  return buildAnchorsFromBlocks(parseDocument(beforeMd, mode).filter((b) => b.index >= 0));
}

/**
 * Build anchors from an already-segmented list of content blocks (index >= 0, in
 * document order). The segmentation-neutral core of `buildAnchors`: the tree
 * adapter passes its tree-segmented content blocks here so anchor construction is
 * single-sourced with the blank-line front end.
 */
export function buildAnchorsFromBlocks(blocks) {
  const anchors = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const prevText = i > 0 ? blocks[i - 1].content : "";
    const nextText = i + 1 < blocks.length ? blocks[i + 1].content : "";
    // SPEC.md §9: the stored prefix/suffix carry up to 48 characters of the
    // neighbour on each side. Storing whole blocks caps the achievable ratio
    // near 2*48/(len+48), because the candidate side is windowed at match time.
    const selector = {
      quote: b.content,
      prefix: windowPrefix(prevText),
      suffix: windowSuffix(nextText),
    };
    for (const mk of b.markers) {
      if (mk.id && isBlockStayMarker(mk)) {
        anchors.push({ id: mk.id, hash: bodyHash(b.content), selector });
      }
    }
  }
  return anchors;
}

/**
 * Resolve every anchor id against the edited document via the evidence ladder.
 * Returns an object id -> { id, method, target, score }, where method is one of
 * 'marker' | 'hash' | 'quote' | 'detached' and target is the after-doc
 * content-block index or null. `mode` MUST match `buildAnchors`.
 */
export function resolve(anchors, afterMd, opts = {}) {
  const { mode = "blank-line", ...rest } = opts;
  const afterBlocks = parseDocument(afterMd, mode).filter((b) => b.index >= 0);
  return resolveOverBlocks(anchors, afterBlocks, rest);
}

/** Code-point length, the unit §9.1's merge exemption counts in. */
function cpLen(s) {
  let n = 0;
  // eslint-disable-next-line no-unused-vars
  for (const _ of s) n++;
  return n;
}

const isHigh = (c) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c) => c >= 0xdc00 && c <= 0xdfff;

/** Whether UTF-16 offset `i` of `s` falls between the two halves of a pair. */
function splitsPair(s, i) {
  return i > 0 && i < s.length && isHigh(s.charCodeAt(i - 1)) && isLow(s.charCodeAt(i));
}

/**
 * The first UTF-16 offset at or after `from` where `q` occurs in `s` as whole
 * code points, or -1. `indexOf` alone would match a lone surrogate in `q`
 * against half of a surrogate pair in `s`.
 */
function findAt(s, q, from) {
  for (let at = s.indexOf(q, from); at >= 0; at = s.indexOf(q, at + 1)) {
    if (!splitsPair(s, at) && !splitsPair(s, at + q.length)) return at;
  }
  return -1;
}

/**
 * §9.1's merge exemption: can every quote be placed in `body` at its own
 * occurrence, no two overlapping? Quotes and body are compared after §9's
 * quote normalization; an occurrence is a half-open span, so two may touch.
 * Each quote is a separate contender, so two equal quotes need two
 * occurrences. Fails with more than MERGE_CONTENDER_CAP quotes, then on any
 * empty quote, then when the quotes' total length exceeds the body's; with no
 * quotes it holds.
 *
 * The decision is the subset recurrence: end(S) is the smallest offset by
 * which every quote in S can be placed disjointly, end(empty) = 0, and end(S)
 * is the least find(q, end(S - q)) + len(q) over the q in S where both exist.
 * §9.1 states offsets in code points. The search here runs on UTF-16 offsets
 * (`findAt`), which decides the same thing: it accepts only an occurrence that
 * starts and ends on a code-point boundary of the body, the map from code-point
 * offsets to UTF-16 offsets is strictly increasing, and so it preserves every
 * comparison the recurrence makes. A code point is what `for...of` yields, so a
 * lone surrogate counts as one, as it does in §9's similarity here. The length
 * check counts code points, as the text says; it is a shortcut either way and
 * never decides.
 */
export function disjointIn(quotes, body) {
  const k = quotes.length;
  if (k > MERGE_CONTENDER_CAP) return false;
  if (k === 0) return true;
  const qs = quotes.map(normalize);
  if (qs.some((q) => q === "")) return false;
  const b = normalize(body);
  let total = 0;
  for (const q of qs) total += cpLen(q);
  if (total > cpLen(b)) return false;
  const full = (1 << k) - 1;
  // end[S], or -1 where undefined.
  const end = new Array(full + 1).fill(-1);
  end[0] = 0;
  for (let set = 1; set <= full; set++) {
    let best = -1;
    for (let i = 0; i < k; i++) {
      const bit = 1 << i;
      if ((set & bit) === 0) continue;
      const from = end[set ^ bit];
      if (from < 0) continue;
      const at = findAt(b, qs[i], from);
      if (at < 0) continue;
      const e = at + qs[i].length;
      if (best < 0 || e < best) best = e;
    }
    end[set] = best;
  }
  return end[full] >= 0;
}

/**
 * §9's commit rule over a ranked candidate list (best first, scores unclamped):
 * the first entry is the target, the second the runner-up (0 with none). Both
 * are clamped to 1.0 before the threshold and margin are applied, as
 * `bestMatch` reports them.
 */
function commitRule(target, runnerUp, threshold, margin) {
  const score = Math.min(target[0], 1.0);
  const second = runnerUp ? Math.min(runnerUp[0], 1.0) : 0.0;
  return { score, commits: score >= threshold && score - second >= margin };
}

/**
 * Resolve anchors against an already-segmented list of after-doc content blocks
 * (index >= 0, in document order). The segmentation-neutral core of `resolve`:
 * the tree adapter passes its tree-segmented content blocks here so the §9.1
 * ladder is single-sourced with the blank-line front end.
 *
 * §9.1 (v1.11) applies the tiers strongest-first and assigns exclusively: every
 * stay still unresolved is evaluated at a tier before any commit at that tier
 * takes effect, and a block committed at a tier is claimed for the weaker ones.
 * When the anchor list repeats an id (a §7 error in the baseline), the last
 * anchor read for it is the one resolved.
 */
export function resolveOverBlocks(anchors, afterBlocks, opts = {}) {
  const { threshold = DEFAULT_THRESHOLD, margin = DEFAULT_MARGIN } = opts;
  const bodies = afterBlocks.map((b) => b.content);
  const hashes = bodies.map((body) => bodyHash(body));

  const byId = new Map();
  for (const a of anchors) byId.set(a.id, a);
  const stays = [...byId.values()];

  // The blocks each id's block-stay marker sits on, distinct, in document order.
  const carriers = new Map();
  for (let idx = 0; idx < afterBlocks.length; idx++) {
    for (const mk of afterBlocks[idx].markers) {
      if (!mk.id || !isBlockStayMarker(mk)) continue;
      let arr = carriers.get(mk.id);
      if (arr === undefined) {
        arr = [];
        carriers.set(mk.id, arr);
      }
      if (arr[arr.length - 1] !== idx) arr.push(idx);
    }
  }

  // How many stays recorded each hash, for tier 2's historical uniqueness.
  const recorded = new Map();
  for (const a of stays) recorded.set(a.hash, (recorded.get(a.hash) || 0) + 1);

  // Settled stays by id. A Map, so an id that names an Object.prototype member
  // (`constructor`, `__proto__`) is never mistaken for a settled one.
  const out = new Map();
  const claimed = new Set();
  const settle = (a, method, target, score) => {
    out.set(a.id, { id: a.id, method, target, score });
  };
  // Commits made at one tier, claimed only once the whole tier is evaluated.
  const claimAll = (commits) => {
    for (const [a, method, target, score] of commits) {
      settle(a, method, target, score);
      claimed.add(target);
    }
  };

  // Tier 1: MARKER. One carrier commits. Several resolve among themselves only:
  // the one carrier whose hash is the stored hash, else §9's commit rule with the
  // carriers as the only candidates, else DETACHED. Never the weaker tiers.
  const tier1 = [];
  for (const a of stays) {
    const cs = carriers.get(a.id);
    if (cs === undefined) continue;
    if (cs.length === 1) {
      tier1.push([a, "marker", cs[0], 1.0]);
      continue;
    }
    const exact = cs.filter((i) => hashes[i] === a.hash);
    if (exact.length === 1) {
      tier1.push([a, "marker", exact[0], 1.0]);
      continue;
    }
    const ranked = rankMatches(a.selector, bodies).filter(([, i]) => cs.includes(i));
    const { score, commits } = commitRule(ranked[0], ranked[1], threshold, margin);
    if (commits) tier1.push([a, "marker", ranked[0][1], score]);
    else settle(a, "detached", null, score);
  }
  claimAll(tier1);

  // Tier 2: HASH. The stored hash was recorded by one stay and exactly one
  // unclaimed block has it.
  const tier2 = [];
  for (const a of stays) {
    if (out.has(a.id)) continue;
    if (recorded.get(a.hash) !== 1) continue;
    const hits = [];
    for (let i = 0; i < hashes.length; i++) {
      if (hashes[i] === a.hash && !claimed.has(i)) hits.push(i);
    }
    if (hits.length === 1) tier2.push([a, "hash", hits[0], 1.0]);
  }
  claimAll(tier2);

  // Tier 3: QUOTE. Every block is ranked, claimed or not. The target is the best
  // unclaimed block, the runner-up the best other block. Stays that select the
  // same target commit together only if their quotes fit it disjointly.
  const proposals = new Map(); // target -> [[anchor, score], ...]
  for (const a of stays) {
    if (out.has(a.id)) continue;
    const ranked = rankMatches(a.selector, bodies);
    const t = ranked.findIndex(([, i]) => !claimed.has(i));
    if (t < 0) {
      settle(a, "detached", null, 0.0);
      continue;
    }
    const runnerUp = t === 0 ? ranked[1] : ranked[0];
    const { score, commits } = commitRule(ranked[t], runnerUp, threshold, margin);
    if (!commits) {
      settle(a, "detached", null, score);
      continue;
    }
    const target = ranked[t][1];
    let group = proposals.get(target);
    if (group === undefined) {
      group = [];
      proposals.set(target, group);
    }
    group.push([a, score]);
  }
  for (const [target, group] of proposals) {
    const holds =
      group.length === 1 ||
      disjointIn(
        group.map(([a]) => a.selector.quote),
        bodies[target]
      );
    for (const [a, score] of group) {
      if (holds) settle(a, "quote", target, score);
      else settle(a, "detached", null, score);
    }
  }
  // In stay order, as own properties: `Object.fromEntries` defines `__proto__`
  // as a key rather than setting the prototype, which assignment would do.
  return Object.fromEntries(stays.map((a) => [a.id, out.get(a.id)]));
}
