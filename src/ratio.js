// Ratcliff/Obershelp similarity ratio, a faithful port of CPython
// `difflib.SequenceMatcher(None, a, b, autojunk=False).ratio()` (SPEC.md §9).
//
// This is the conformance-critical module: the markstay quote recovery scores
// candidate blocks with this ratio, so the JS and Python implementations must
// agree on it bit-for-bit. The port reproduces three things CPython does that a
// naive ratio would get wrong:
//
//  1. **Code points, not UTF-16 code units.** Python indexes Unicode scalar
//     values; a naive JS string indexes UTF-16 units, so any non-BMP character
//     (emoji, astral CJK) would diverge. Both inputs are converted to code-point
//     arrays (`Array.from`) before matching, and lengths are measured on those.
//  2. **`autojunk=False` / `isjunk=None`** means no junk and no popularity
//     heuristic: every element of `b` stays in the `b2j` index. The autojunk
//     purge (n >= 200) is therefore never implemented here.
//  3. **Tie-break is earliest-in-a, then earliest-in-b.** `findLongestMatch`
//     only adopts a new best on a *strictly* longer run, so the first maximal
//     match in iteration order wins, exactly as CPython does. This is what keeps
//     the block decomposition (`matchingBlocks`) identical, not just the scalar.

/** Build the `b2j` index: element -> ascending list of indices in `b`. */
function buildB2j(b) {
  const b2j = new Map();
  for (let i = 0; i < b.length; i++) {
    const elt = b[i];
    let idxs = b2j.get(elt);
    if (idxs === undefined) {
      idxs = [];
      b2j.set(elt, idxs);
    }
    idxs.push(i);
  }
  return b2j;
}

/**
 * Longest matching block of `a[alo:ahi]` against `b[blo:bhi]`.
 * Returns [besti, bestj, bestsize]. Direct port of CPython's
 * `find_longest_match` with junk handling removed (autojunk=False, isjunk=None).
 */
function findLongestMatch(a, b2j, alo, ahi, blo, bhi) {
  let besti = alo;
  let bestj = blo;
  let bestsize = 0;
  let j2len = new Map();
  for (let i = alo; i < ahi; i++) {
    const newj2len = new Map();
    const idxs = b2j.get(a[i]);
    if (idxs !== undefined) {
      for (const j of idxs) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) || 0) + 1;
        newj2len.set(j, k);
        if (k > bestsize) {
          besti = i - k + 1;
          bestj = j - k + 1;
          bestsize = k;
        }
      }
    }
    j2len = newj2len;
  }
  // With no junk the DP already yields a maximal run, so CPython's junk and
  // non-junk extension passes are provable no-ops and are omitted.
  return [besti, bestj, bestsize];
}

/** Lexicographic tuple comparison, mirroring Python list.sort() on tuples. */
function tupleCmp(x, y) {
  return (x[0] - y[0]) || (x[1] - y[1]) || (x[2] - y[2]);
}

/**
 * Matching blocks for two code-point arrays, port of `get_matching_blocks()`:
 * recursive longest-match over a queue, sort, adjacent-block merge, terminated
 * by the (la, lb, 0) sentinel. Returns an array of [a_index, b_index, size].
 */
function matchingBlocksOf(a, b) {
  const b2j = buildB2j(b);
  const la = a.length;
  const lb = b.length;
  const queue = [[0, la, 0, lb]];
  const blocks = [];
  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop();
    const [i, j, k] = findLongestMatch(a, b2j, alo, ahi, blo, bhi);
    if (k) {
      blocks.push([i, j, k]);
      if (alo < i && blo < j) queue.push([alo, i, blo, j]);
      if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
    }
  }
  blocks.sort(tupleCmp);

  let i1 = 0;
  let j1 = 0;
  let k1 = 0;
  const nonAdjacent = [];
  for (const [i2, j2, k2] of blocks) {
    if (i1 + k1 === i2 && j1 + k1 === j2) {
      k1 += k2;
    } else {
      if (k1) nonAdjacent.push([i1, j1, k1]);
      i1 = i2;
      j1 = j2;
      k1 = k2;
    }
  }
  if (k1) nonAdjacent.push([i1, j1, k1]);
  nonAdjacent.push([la, lb, 0]);
  return nonAdjacent;
}

function calculateRatio(matches, length) {
  if (length) return (2.0 * matches) / length;
  return 1.0;
}

/**
 * The matching blocks of `a` against `b` as [a_index, b_index, size] tuples
 * over Unicode code points (the sentinel block is included, as in CPython).
 */
export function matchingBlocks(a, b) {
  return matchingBlocksOf(Array.from(a), Array.from(b));
}

/**
 * Raw Ratcliff/Obershelp ratio in [0, 1], equal to
 * `difflib.SequenceMatcher(None, a, b, autojunk=False).ratio()`.
 * Note empty/empty returns 1.0 (length 0 path), matching the raw matcher; the
 * markstay wrapper in quote.js floors empty input to 0.0 instead.
 */
export function ratio(a, b) {
  const aa = Array.from(a);
  const bb = Array.from(b);
  const blocks = matchingBlocksOf(aa, bb);
  let matches = 0;
  for (const blk of blocks) matches += blk[2];
  return calculateRatio(matches, aa.length + bb.length);
}
