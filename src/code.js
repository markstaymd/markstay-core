// Code is content, not markup: text inside a fenced code block (SPEC.md §3.3,
// v1.5) and inside a closed inline code span (§3.5, v1.12). Port of
// `fence_state` / `_inline_code_spans` / `code_lines` /
// `strip_markers_outside_code` from impl/py/src/markstay/lint.py, which is the
// reference spelling.
//
// The rule is document-level, computed once and threaded, on the
// `blankFrontmatter` precedent (§5.3). It cannot live in segmentation, because
// the blank-line segmenter has no concept of a fence (a maximal run of non-blank
// lines is exactly why §5.2 exists), and it cannot live in `findMarkers`, which
// is handed *chunks*: a chunk that begins inside a fence carries no opener, so a
// chunk-local fence scan answers confidently and wrongly. Unlike frontmatter
// blanking this is a mask rather than a removal, because a fence's content must
// still be hashed (§8).

import { markerOutsideCode, maskIsEmpty, scanMarkerRecords, stripMarkers } from "./markers.js";

// An opening fence may carry an info string; a *closing* fence may not, and a
// backtick fence's info string may not contain a backtick (CommonMark 4.5).
// `[\s\S]*` rather than `.*`: ECMAScript's `.` stops at U+2028 and U+2029,
// which Python's and Rust's info-string readers accept.
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})([\s\S]*)$/;
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

// --- closed inline code spans (SPEC.md §3.5, v1.12) -------------------------

const RAW_HTML_ATTRIBUTE = "{=html}";
// What a link destination, title or reference label must not hold for §3.5 to
// pass over it: anything that can open a title, nest, escape or reach a span or a
// tag.
const LINK_UNSAFE = new Set(["`", "<", "{", "(", "[", "\\", '"', "'"]);
// A container prefix in front of a line's content: a blockquote `>` or a list
// marker. Stripped repeatedly, so `> - <div>` reads as starting with `<`.
const SPAN_CONTAINER_RE = /^[ \t]*(?:>[ \t]?|[-+*][ \t]+|[0-9]{1,9}[.)][ \t]+)/;
// CommonMark's HTML block types 1 to 5, the ones that run on across blank lines,
// each with its end condition. Any other line whose content starts with `<` is
// treated as types 6 and 7 are, running to the next blank line. The opener is
// matched at the start of the prefix-stripped content and the end condition is
// searched over the whole line. The `i` flag without `u` folds ASCII only, as the
// Python `re.ASCII` twin does.
const SPAN_HTML_BLOCKS = [
  // Any of the four names not continued by a tag-name character: CommonMark wants
  // a space, tab, `>` or line end there, and markdown-it accepts any Unicode
  // whitespace, so recognising more than either is the safe side. markdown-it
  // also folds case by Unicode, under which U+017F matches `s` and U+0130 and
  // U+0131 match `i`; those are spelled out, and the `i` flag without `u` matches
  // them literally only, so every implementation matches the same strings
  // without a Unicode case table.
  [
    /^<(?:[s\u017f]cr[i\u0130\u0131]pt|pre|[s\u017f]tyle|textarea)(?![A-Za-z0-9-])/i,
    /<\/(?:script|pre|style|textarea)>/i,
  ],
  [/^<!--/, /-->/],
  [/^<\?/, /\?>/],
  [/^<![A-Za-z]/, />/],
  [/^<!\[CDATA\[/, /\]\]>/],
];
const isBlankLine = (line) => /^[ \t]*$/.test(line);

/**
 * The code mask for one document. As a Set it holds the 1-based line numbers
 * inside a fenced code block (SPEC.md §3.3), which is the question every
 * `code.has(line)` test asks, so those seams are unchanged. `spans` adds the
 * closed inline code spans §3.5 makes content: a Map from 1-based line number to
 * the `[start, end)` columns of each span's content, in UTF-16 code units of the
 * LF-normalized line. Only the marker test (`markerOutsideCode`) reads it.
 */
export class CodeMask extends Set {
  constructor(lines = [], spans = new Map()) {
    super(lines);
    this.spans = spans;
  }
}

/**
 * The closed inline code spans whose content SPEC.md §3.5 makes content, as a
 * Map from 1-based line number to `[start, end)` content columns.
 *
 * A left-to-right scan of each line, over stretches of lines that are neither
 * blank nor inside a §3.3 fence, since a code span crosses neither. A backtick
 * run opens a span that the next run of the same length on the same line closes,
 * and the scan resumes after the closer. Wherever the scan meets something
 * CommonMark could read before a backtick, it stops for the rest of the stretch,
 * and the spans it already closed stand:
 *
 *   - a run with no closer on its line, which CommonMark may close from a later
 *     line, re-pairing everything after it;
 *   - a `<` outside a span and outside a marker-shaped string, which can open an
 *     HTML tag or an autolink, and those outrank a code span by opening first
 *     (CommonMark 6.1), across lines for a tag;
 *   - a `{` there, which opens an MDX expression, an MDX comment included, whose
 *     backticks are no delimiters to an MDX parser;
 *   - a `]` there followed by `(`, `[` or `:`, where a link or image destination,
 *     a title, a reference label or a link reference definition consumes raw
 *     text, backticks included, before any span is looked for, unless the part up
 *     to the first `)` or `]` closes before the next run and holds none of
 *     `LINK_UNSAFE`, so an ordinary link is passed over;
 *   - a `[` there with no `]` after it before the next run, a link label still
 *     open, which markdown-it scans ahead in a way that can leave a span unclosed
 *     where CommonMark closes it;
 *   - a backtick run inside a marker-shaped string, as an opener, a closer or
 *     anything between them, which is a delimiter or not depending on whether a
 *     renderer accepts that string as a comment, and on which renderer;
 *   - a backtick run directly behind a backslash, which CommonMark escapes;
 *   - a line whose content, after any `>` or list-marker prefix, starts with `<`:
 *     an HTML block, which has no inline content at all. Types 1 to 5 run to
 *     their end condition, across blank lines, and the rest to a blank line. The
 *     scan resumes only after a blank line, even past an end condition, because a
 *     block inside a list item ends with the item, and the line holding the end
 *     condition is then paragraph text that runs on into the next. For the same
 *     reason every type 1 to 5 opener met while a block is open is tracked too:
 *     the container may have ended and a new block begun.
 *
 * A span whose content holds a `|` stops the scan as well, because GFM splits a
 * table row's cells before any inline scan, so neither it nor any pairing after
 * it is one a renderer makes. A span followed by `{=html}` is left live, since
 * pandoc's raw-inline syntax declares its content HTML.
 *
 * Every rule here can only leave a marker live, never mask one CommonMark reads
 * as a comment. Blank means spaces and tabs only, never `\s`.
 */
function inlineCodeSpans(text, fence) {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const spans = new Map();
  if (!normalized.includes("`")) return spans;

  // Every marker-shaped string, malformed records included, merged into
  // disjoint [start, end) ranges over `normalized`.
  const records = scanMarkerRecords(normalized);
  // Merged [start, end) ranges over `normalized`, in source order.
  const merge = (list) => {
    const ranges = [];
    for (const record of list) {
      const last = ranges[ranges.length - 1];
      if (last && record.start < last[1]) last[1] = Math.max(last[1], record.end);
      else ranges.push([record.start, record.end]);
    }
    return ranges;
  };
  // The range in `ranges` holding `at`, or null.
  const rangeAt = (ranges, at) => {
    let lo = 0;
    let hi = ranges.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ranges[mid][0] <= at) lo = mid + 1;
      else hi = mid;
    }
    const range = ranges[lo - 1];
    return range !== undefined && at < range[1] ? range : null;
  };
  // Every marker-shaped string, malformed records included.
  const shaped = merge(records);
  const shapedAt = (at) => rangeAt(shaped, at);
  // What `opensBefore` may pass over unread: an HTML-form string whose body holds
  // nothing that could open a construct if a renderer declined it as a comment.
  // An MDX-form string is ordinary text to CommonMark, so a `<` or `[` in its
  // quoted value is live there; it is read like any other text, and its own `{`
  // stops the scan.
  const skippable = merge(
    records.filter((record) => {
      if (record.marker.syntax !== "html") return false;
      const body = normalized.slice(record.start + 4, record.end - 3);
      return !/[<[\]{]/.test(body) && !body.includes("--");
    }),
  );
  const skippableAt = (at) => rangeAt(skippable, at);
  // Whether line[left, right) holds, outside every passed-over marker, a
  // character that can start a construct CommonMark or MDX reads before a
  // backtick: `<` (a tag or an autolink), `{` (an MDX expression), a `]` followed
  // by `(`, `[` or `:` (a link or image destination, a reference label, a link
  // reference definition), or a `[` whose label is still open.
  const opensBefore = (line, start, left, right) => {
    let at = left;
    while (at < right) {
      const found = skippableAt(start + at);
      if (found !== null) {
        at = found[1] - start;
        continue;
      }
      const char = line[at];
      const next = line[at + 1];
      if (char === "]" && (next === "(" || next === "[")) {
        // A destination or label holding none of LINK_UNSAFE, closed before the
        // next run, consumes nothing a span could need, so an ordinary link is
        // passed over rather than stopping the scan.
        const close = line.indexOf(next === "(" ? ")" : "]", at + 2);
        if (close >= 0 && close < right) {
          let safe = true;
          for (let k = at + 2; k < close; k++) {
            if (LINK_UNSAFE.has(line[k])) {
              safe = false;
              break;
            }
          }
          if (safe) {
            // Past a destination's `)`, but back ON a label's closing `]`, which
            // may itself open a destination: `[a][b](`)`.
            at = next === "(" ? close + 1 : close;
            continue;
          }
        }
      }
      if (char === "<" || char === "{" || (char === "]" && (next === "(" || next === "[" || next === ":"))) {
        return true;
      }
      if (char === "[") {
        // A link label left open past the next run. markdown-it scans such a
        // label ahead and can leave a span unclosed that CommonMark closes, so a
        // comment after it stays live there. A label counts as closed only by a
        // `]` with no `[` or backslash before it, since a nested or escaped
        // bracket closes nothing.
        const close = line.indexOf("]", at + 1);
        if (close < 0 || close >= right) return true;
        for (let k = at + 1; k < close; k++) {
          if (line[k] === "[" || line[k] === "\\") return true;
        }
      }
      at += 1;
    }
    return false;
  };

  let scanning = true;
  let htmlOpen = false; // inside what may be an HTML block
  let pending = []; // end conditions of types 1 to 5 still unmet
  let offset = 0;
  const lines = normalized.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const number = index + 1;
    const line = lines[index];
    const start = offset;
    offset += line.length + 1;
    const blank = isBlankLine(line);
    // A byte-order mark opening the document is no text to a renderer that
    // strips it, as pandoc does, so it must not hide an HTML block opener.
    let content = number === 1 && line.startsWith("\uFEFF") ? line.slice(1) : line;
    for (let prefix; (prefix = SPAN_CONTAINER_RE.exec(content)) && prefix[0].length > 0;) {
      content = content.slice(prefix[0].length);
    }
    content = content.replace(/^[ \t]+/, "");
    const block = content.startsWith("<")
      ? SPAN_HTML_BLOCKS.find(([open]) => open.test(content))
      : undefined;
    const opener = block === undefined ? null : block[1];
    if (htmlOpen) {
      // A container can end under an open block and a new block start after it,
      // so every opener met here is tracked too. The scan resumes only once
      // every end condition seen has been met and a blank line follows.
      if (opener !== null && !opener.test(line)) pending.push(opener);
      pending = pending.filter((end) => !end.test(line));
      if (blank && pending.length === 0) {
        htmlOpen = false;
        scanning = true;
      }
      continue;
    }
    if (fence.has(number) || blank) {
      scanning = true;
      continue;
    }
    if (content.startsWith("<")) {
      htmlOpen = true;
      pending = opener !== null && !opener.test(line) ? [opener] : [];
      continue;
    }
    if (!scanning) continue;

    const runs = [];
    for (const match of line.matchAll(/`+/g)) runs.push([match.index, match.index + match[0].length]);
    const found = [];
    let pos = 0;
    let i = 0;
    let stopped = false;
    while (i < runs.length) {
      const [left, right] = runs[i];
      if (
        opensBefore(line, start, pos, left) ||
        shapedAt(start + left) !== null ||
        (left > 0 && line[left - 1] === "\\")
      ) {
        stopped = true;
        break;
      }
      const width = right - left;
      let j = i + 1;
      while (j < runs.length && runs[j][1] - runs[j][0] !== width) j += 1;
      let shapedRun = false;
      for (let k = i + 1; j < runs.length && k <= j; k++) {
        if (shapedAt(start + runs[k][0]) !== null) {
          shapedRun = true;
          break;
        }
      }
      if (j === runs.length || shapedRun) {
        // No closer on this line, or a run up to and including the closer sits
        // inside a marker-shaped string. CommonMark pairs the latter, but
        // markdown-it does not always: scanning a link label it skips the comment
        // and will not close a span inside it later.
        stopped = true;
        break;
      }
      const [closeLeft, closeRight] = runs[j];
      if (line.slice(right, closeLeft).includes("|")) {
        // GFM splits a table row's cells before any inline scan, so a pair of
        // runs in different cells is no span, and pairing the runs after it
        // would follow a split this scan cannot see.
        stopped = true;
        break;
      }
      if (!line.startsWith(RAW_HTML_ATTRIBUTE, closeRight)) found.push([right, closeLeft]);
      pos = closeRight;
      i = j + 1;
    }
    if (stopped || opensBefore(line, start, pos, line.length)) scanning = false;
    if (found.length > 0) spans.set(number, found);
  }
  return spans;
}

/**
 * The code mask for one document (SPEC.md §3.3 and §3.5): a `CodeMask` holding
 * the 1-based line numbers inside a fenced code block, with the closed inline
 * code spans on its `spans`. Text in either is content: a marker-shaped string
 * there identifies no block, is hashed with the body (§8), and does not make its
 * block stamped.
 */
export function codeLines(text) {
  return codeMask(text, fenceState(text).inside);
}

/** `codeLines` for a caller that already holds the document's fence lines. */
export function codeMask(text, fence) {
  return new CodeMask(fence, inlineCodeSpans(text, fence));
}

/**
 * Remove markers from `text`, leaving marker-shaped strings inside a fenced code
 * block or a closed inline code span in place (SPEC.md §3.3 and §3.5: they are
 * content, and §8 hashes them with the body). `code` is the document-level mask
 * and `lineOffset` the 0-based line index at which `text` begins in the document
 * it was computed over; `text` begins at the start of that line, so a marker's
 * column means the same in both.
 *
 * A marker is judged by where it *opens*, which is the only place a reader can
 * see it start; the grammar spans newlines, so one match can cross lines.
 */
export function stripMarkersOutsideCode(text, code, lineOffset = 0) {
  if (maskIsEmpty(code)) return stripMarkers(text);
  const ranges = [];
  for (const record of scanMarkerRecords(text, lineOffset)) {
    if (record.marker.malformed || !markerOutsideCode(record, code)) continue;
    const previous = ranges[ranges.length - 1];
    if (previous && record.start < previous[1]) previous[1] = Math.max(previous[1], record.end);
    else ranges.push([record.start, record.end]);
  }
  const out = [];
  let previous = 0;
  for (const [start, end] of ranges) {
    out.push(text.slice(previous, start));
    previous = end;
  }
  out.push(text.slice(previous));
  return out.join("");
}
