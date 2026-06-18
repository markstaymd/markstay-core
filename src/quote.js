// Quote / selector recovery scoring (SPEC.md §9). Port of
// eval/attachment/quote.py: `normalize`, `_ratio`, `body_score`,
// `context_bonus`, `best_match`.

import { ratio as rawRatio } from "./ratio.js";
import { asciiTrim, asciiCollapse, asciiLower } from "./text.js";

// How much neighbour context to keep on each side (SPEC.md §9). Code points.
export const CONTEXT_CHARS = 48;

/**
 * §9 matching normalization: lowercase ASCII letters and collapse ASCII
 * whitespace runs to a single space, then trim. Capitalization and reflowed line
 * breaks (common after an LLM edit) must not register as differences.
 *
 * Pinned to ASCII (mirrors the Python reference, SPEC.md §9 / SPEC_DECISIONS.md):
 * non-ASCII characters pass through unchanged and identical in both languages,
 * so this avoids the Unicode `casefold` vs `toLowerCase` and Unicode-`\s`
 * divergences. Recovery is evidence, not identity (§2.1), so an ASCII-only fold
 * is sufficient.
 */
export function normalize(text) {
  return asciiLower(asciiCollapse(asciiTrim(text)));
}

/** Code-point length (Python `len` over Unicode scalars). */
function cpLen(s) {
  let n = 0;
  // eslint-disable-next-line no-unused-vars
  for (const _ of s) n++;
  return n;
}

/** Code-point slice, mirroring Python string slicing semantics. */
function cpSlice(s, start, end) {
  return Array.from(s).slice(start, end).join("");
}

/** markstay ratio wrapper: empty input floors to 0.0 (raw ratio returns 1.0). */
export function quoteRatio(a, b) {
  if (!a || !b) return 0.0;
  return rawRatio(a, b);
}

/**
 * Similarity of a stored selector's quote to a candidate block body, in [0, 1].
 * Exact containment floors the score at the length ratio of shorter to longer,
 * so a surviving half of a split paragraph cannot score arbitrarily low.
 * `sel` is { quote, prefix?, suffix? }.
 */
export function bodyScore(sel, candidate) {
  const q = normalize(sel.quote);
  const c = normalize(candidate);
  if (!q || !c) return 0.0;
  if (q === c) return 1.0;
  let base = quoteRatio(q, c);
  const lq = cpLen(q);
  const lc = cpLen(c);
  const [short, long, ls, ll] = lq <= lc ? [q, c, lq, lc] : [c, q, lc, lq];
  if (short && long.includes(short)) base = Math.max(base, ls / ll);
  return base;
}

/**
 * Small additive bonus in [0, ~0.1] when the candidate's neighbours match the
 * stored prefix/suffix. Used only to break near-ties; not a primary key.
 */
export function contextBonus(sel, prevText, nextText) {
  let bonus = 0.0;
  if (sel.prefix) {
    bonus += 0.05 * quoteRatio(normalize(sel.prefix), normalize(cpSlice(prevText, -CONTEXT_CHARS)));
  }
  if (sel.suffix) {
    bonus += 0.05 * quoteRatio(normalize(sel.suffix), normalize(cpSlice(nextText, 0, CONTEXT_CHARS)));
  }
  return bonus;
}

/**
 * Rank candidate block bodies against a selector. Returns
 * { index, score, runnerUp }. On an exact score tie the later candidate wins
 * (Python sorts (score, index) descending), and the score ceiling is 1.0.
 */
export function bestMatch(sel, candidates) {
  const scored = [];
  for (let i = 0; i < candidates.length; i++) {
    const s = bodyScore(sel, candidates[i]);
    const prevText = i > 0 ? candidates[i - 1] : "";
    const nextText = i + 1 < candidates.length ? candidates[i + 1] : "";
    scored.push([s + contextBonus(sel, prevText, nextText), i]);
  }
  if (!scored.length) return { index: -1, score: 0.0, runnerUp: 0.0 };
  scored.sort((x, y) => (y[0] - x[0]) || (y[1] - x[1]));
  const [bestScore, bestIndex] = scored[0];
  const runnerUp = scored.length > 1 ? scored[1][0] : 0.0;
  return { index: bestIndex, score: Math.min(bestScore, 1.0), runnerUp: Math.min(runnerUp, 1.0) };
}
