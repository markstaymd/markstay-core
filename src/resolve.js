// The attachment resolver: the §9.1 evidence ladder (MARKER -> HASH -> QUOTE ->
// DETACHED). Port of eval/attachment/resolver.py: `Anchor`, `build_anchors`,
// `resolve`.

import { bodyHash } from "./hash.js";
import { parseDocument } from "./parse.js";
import { bestMatch } from "./quote.js";

// Default thresholds for the QUOTE tier (SPEC.md §9 commit rule). A recovery is
// committed only when the best candidate clears `threshold` AND beats the
// runner-up by `margin`.
export const DEFAULT_THRESHOLD = 0.5;
export const DEFAULT_MARGIN = 0.05;

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
    const selector = { quote: b.content, prefix: prevText, suffix: nextText };
    for (const mk of b.markers) {
      if (mk.id && !mk.malformed) {
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

/**
 * Resolve anchors against an already-segmented list of after-doc content blocks
 * (index >= 0, in document order). The segmentation-neutral core of `resolve`:
 * the tree adapter passes its tree-segmented content blocks here so the §9.1
 * ladder is single-sourced with the blank-line front end.
 */
export function resolveOverBlocks(anchors, afterBlocks, opts = {}) {
  const { threshold = DEFAULT_THRESHOLD, margin = DEFAULT_MARGIN } = opts;
  const bodies = afterBlocks.map((b) => b.content);

  // Tier 1 lookup: ids whose marker is still attached, mapped to block index.
  const surviving = new Map();
  for (let idx = 0; idx < afterBlocks.length; idx++) {
    for (const mk of afterBlocks[idx].markers) {
      if (mk.id && !mk.malformed && !surviving.has(mk.id)) surviving.set(mk.id, idx);
    }
  }

  // Tier 2 lookup: full-body hash -> block indices (list, to detect ambiguity).
  const hashToIdx = new Map();
  for (let idx = 0; idx < bodies.length; idx++) {
    const h = bodyHash(bodies[idx]);
    let arr = hashToIdx.get(h);
    if (arr === undefined) {
      arr = [];
      hashToIdx.set(h, arr);
    }
    arr.push(idx);
  }

  const out = {};
  for (const a of anchors) {
    // Tier 1: marker survived.
    if (surviving.has(a.id)) {
      out[a.id] = { id: a.id, method: "marker", target: surviving.get(a.id), score: 1.0 };
      continue;
    }
    // Tier 2: body hash uniquely identifies a surviving block.
    const hits = hashToIdx.get(a.hash) || [];
    if (hits.length === 1) {
      out[a.id] = { id: a.id, method: "hash", target: hits[0], score: 1.0 };
      continue;
    }
    // Tier 3: quote recovery, committed only on a clear winner.
    const { index, score, runnerUp } = bestMatch(a.selector, bodies);
    if (index >= 0 && score >= threshold && score - runnerUp >= margin) {
      out[a.id] = { id: a.id, method: "quote", target: index, score };
    } else {
      out[a.id] = { id: a.id, method: "detached", target: null, score };
    }
  }
  return out;
}
