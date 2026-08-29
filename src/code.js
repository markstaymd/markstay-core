// Fenced code blocks (SPEC.md §3.3, v1.5): text inside a fence is content, not
// markup. Port of `fence_state` / `code_lines` / `strip_markers_outside_code`
// from impl/py/src/markstay/lint.py, which is the reference spelling.
//
// The rule is document-level, computed once and threaded, on the
// `blankFrontmatter` precedent (§5.3). It cannot live in segmentation, because
// the blank-line segmenter has no concept of a fence (a maximal run of non-blank
// lines is exactly why §5.2 exists), and it cannot live in `findMarkers`, which
// is handed *chunks*: a chunk that begins inside a fence carries no opener, so a
// chunk-local fence scan answers confidently and wrongly. Unlike frontmatter
// blanking this is a mask rather than a removal, because a fence's content must
// still be hashed (§8).

import { COMBINED_MARKER_SRC, stripMarkers } from "./markers.js";

// An opening fence may carry an info string; a *closing* fence may not, and a
// backtick fence's info string may not contain a backtick (CommonMark 4.5).
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/**
 * Fence geometry for one document (SPEC.md §3.3): `{ inside, openAfter }`, both
 * Sets of 1-based line numbers. `inside` is the lines that lie within a fenced
 * code block; `openAfter` is the lines a fence is still open *after*.
 *
 * The second set is what the write path needs and it is not derivable from the
 * first: a marker appended after line L lands on a new line inside the fence
 * exactly when a fence is open at the end of L, and an unclosed fence runs to the
 * end of the document, where there is no later line to test.
 *
 * Recognition is line-based and deliberately narrow, so both segmenters (§5) and
 * every tool agree on it without a block parser:
 *
 *   - the scan runs on LF-split lines, so a CRLF document and its LF twin give
 *     the same answer (§8);
 *   - an opening fence has at most three leading **spaces** and then three or
 *     more backticks or tildes. A tab is not one of the three: CommonMark expands
 *     it to the next four-column stop, which needs a column model this rule
 *     deliberately does not have. A backtick fence's info string may not contain
 *     a backtick;
 *   - it closes at the first later line with at most three leading spaces that is
 *     a run of the **same** character, **at least as long** as the opener,
 *     followed by nothing but spaces and tabs. A longer opener is what lets a
 *     fence contain a shorter one, and the whitespace set is named rather than
 *     left to "whitespace" because three implementations picking three sets is
 *     the way this rule fails quietly;
 *   - an unclosed fence runs to the end of the document.
 *
 * The fence lines themselves are inside the block, deliberately rather than as an
 * edge case: a marker-shaped string can sit in an opening fence's info string,
 * where before §3.3 it was read as a marker and bound to whatever block preceded
 * it.
 */
export function fenceState(text) {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const inside = new Set();
  const openAfter = new Set();
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const num = i + 1;
    const line = lines[i];
    if (fence === null) {
      const opener = FENCE_OPEN_RE.exec(line);
      if (opener === null || (opener[1][0] === "`" && opener[2].includes("`"))) continue;
      fence = opener[1];
      inside.add(num);
      openAfter.add(num);
      continue;
    }
    inside.add(num);
    const closer = FENCE_CLOSE_RE.exec(line);
    if (closer && closer[1][0] === fence[0] && closer[1].length >= fence.length) {
      fence = null;
    } else {
      openAfter.add(num);
    }
  }
  return { inside, openAfter };
}

/**
 * The 1-based line numbers inside a fenced code block (SPEC.md §3.3). Text there
 * is content: a marker-shaped string on one of these lines identifies no block,
 * is hashed with the body (§8), and does not make its block stamped.
 */
export function codeLines(text) {
  return fenceState(text).inside;
}

function countNewlines(s, end) {
  let n = 0;
  for (let i = 0; i < end; i++) if (s[i] === "\n") n++;
  return n;
}

/**
 * Remove markers from `text`, leaving marker-shaped strings inside a fenced code
 * block in place (SPEC.md §3.3: they are content, and §8 hashes them with the
 * body). `code` is the document-level mask and `lineOffset` the 0-based line
 * index at which `text` begins in the document it was computed over.
 *
 * A marker is judged by the line it *opens* on, which is the only line a reader
 * can see it start on; the grammar spans newlines, so one match can cross lines.
 */
export function stripMarkersOutsideCode(text, code, lineOffset = 0) {
  if (!code || code.size === 0) return stripMarkers(text);
  const re = new RegExp(COMBINED_MARKER_SRC, "gs");
  const out = [];
  let prev = 0;
  for (const m of text.matchAll(re)) {
    if (code.has(lineOffset + countNewlines(text, m.index) + 1)) continue;
    out.push(text.slice(prev, m.index));
    prev = m.index + m[0].length;
  }
  out.push(text.slice(prev));
  return out.join("");
}
