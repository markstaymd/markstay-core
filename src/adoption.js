// SPEC.md §16 (v1.10): a block stay rewritten in place as a child stay keeps
// its id. Port of `_adoption_view` / `_adopted_ids` from linter/markstay_lint.py.
//
// The test is lexical, so it needs no §5.5 segmentation. It reads the block the
// caller's segmenter selects: the string core passes nothing and gets
// blank-line chunks, a tree adapter passes its own blocks as source line spans.

import { codeLines } from "./code.js";
import { normalizeBody } from "./hash.js";
import { documentMarkerRecords, lineStarts, stripRecordRanges } from "./parse.js";
import { blankFrontmatter, segmentBlankLine } from "./segment.js";

// The line shapes the rule reads, ASCII-pinned so the four implementations
// agree byte for byte.
const ATX = /^ {0,3}#{1,6}(?:[ \t]|$)/;
const OPENER = /^ {0,3}(?:[-+*]|[0-9]{1,9}[.)])(?:[ \t]|$)/;
const THEMATIC = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const LEAD = /^[ \t]*(?:>|<|\||```|~~~)/;
const EMPTY_ITEM = /^[ \t]*(?:[-+*]|[0-9]{1,9}[.)])[ \t]*$/;
const HEADING = /^[ \t]*(?:(?:[-+*]|[0-9]{1,9}[.)])(?:[ \t]+|$))*#{1,6}(?:[ \t]|$)/;
// The HTML blocks that run on across blank lines (CommonMark types 1 to 5). The
// `i` flag without `u` folds ASCII only, as the Python `re.ASCII` twin does.
const HTML = /^[ \t]*(?:<!--|<\?|<![A-Za-z]|<!\[CDATA\[)/;
const HTML_TAG = /^[ \t]*<(?:script|pre|style|textarea)(?:[ \t>]|$)/i;

const isBlankBody = (s) => /^[ \t\n\r\f\v]*$/.test(s);
const isSpaceTabOnly = (s) => /^[ \t]*$/.test(s);
// §5's ASCII whitespace, for the lines skipped after a leading heading.
const isAsciiWsOnly = (s) => /^[ \t\f\v]*$/.test(s);

/** The 1-based line holding `offset`: how many line starts lie at or before it. */
function lineOf(starts, offset) {
  let lo = 0;
  let hi = starts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= offset) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Merged [start, end) marker spans clipped to [from, to), in source order. */
function mergedSpans(records, from, to) {
  const spans = [];
  for (const r of records) {
    const left = Math.max(from, r.start);
    const right = Math.min(to, r.end);
    if (left >= right) continue;
    const last = spans[spans.length - 1];
    if (last && left < last[1]) last[1] = Math.max(last[1], right);
    else spans.push([left, right]);
  }
  return spans;
}

/**
 * One document's half of the test: how many markers carry each id, the carrier
 * facts for each marker of `ids` inside a content block, and the blocks those
 * carriers sit in, each with whether no other content block shares its body.
 * `segment(text)` returns [startLine, chunkText] spans over the normalized,
 * frontmatter-blanked text. Carriers are built for `ids` alone and share their
 * block's stripped source, so the cost stays linear in the document however
 * many markers it holds or adopts.
 */
function adoptionView(md, segment, ids) {
  const normalized = md.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const text = blankFrontmatter(normalized);
  const code = codeLines(text);
  const records = documentMarkerRecords(md, normalized, text).filter(
    (r) => !code.has(r.marker.line) && !r.marker.malformed,
  );
  const counts = new Map();
  for (const r of records) {
    if (r.marker.id) counts.set(r.marker.id, (counts.get(r.marker.id) ?? 0) + 1);
  }

  const docLines = text.split("\n");
  const starts = lineStarts(text);
  // Each line's records, so a strip reads the few markers near it rather than
  // every marker in the document.
  const byLine = new Map(); // line -> record indices
  records.forEach((r, k) => {
    const last = lineOf(starts, Math.max(r.start, r.end - 1));
    for (let n = lineOf(starts, r.start); n <= last; n++) {
      if (!byLine.has(n)) byLine.set(n, []);
      byLine.get(n).push(k);
    }
  });
  const on = (n) => (byLine.get(n) ?? []).map((k) => records[k]);
  let htmlFirst = null; // first line opening a run-on HTML block
  for (let n = 1; n <= docLines.length; n++) {
    if (code.has(n)) continue;
    const line = stripRecordRanges(docLines[n - 1], on(n), starts[n - 1]);
    if (HTML.test(line) || HTML_TAG.test(line)) {
      htmlFirst = n;
      break;
    }
  }

  const carriers = new Map();
  const bodies = new Map();
  const blocks = []; // { body, stripped }
  for (const [start, chunk] of segment(text)) {
    const chunkStart = starts[start - 1];
    const chunkEnd = chunkStart + chunk.length;
    const lines = chunk.split("\n");
    const nearIdx = new Set();
    for (let n = start; n < start + lines.length; n++) {
      for (const k of byLine.get(n) ?? []) nearIdx.add(k);
    }
    const near = [...nearIdx].sort((x, y) => x - y).map((k) => records[k]);
    const stripped = stripRecordRanges(chunk, near, chunkStart);
    if (isBlankBody(stripped)) continue; // a marker-only chunk is not a block
    const body = normalizeBody(stripped);
    bodies.set(body, (bodies.get(body) ?? 0) + 1);
    const inside = near.filter((r) => chunkStart <= r.start && r.start < chunkEnd);
    const wanted = inside.filter((r) => ids.has(r.marker.id));
    if (!wanted.length) continue;
    const clean = lines.map((line, i) => stripRecordRanges(line, on(start + i), starts[start - 1 + i]));
    const single = !inside.some((r) => text.slice(r.start, r.end).includes("\n"));
    let opening = 0;
    if (ATX.test(lines[0])) {
      opening = 1;
      while (opening < lines.length && isAsciiWsOnly(clean[opening])) opening += 1;
    }
    const opens =
      opening < lines.length && OPENER.test(lines[opening]) && !THEMATIC.test(lines[opening]);
    // The first row past the opening line each line test refuses: a marker is
    // eligible only above both.
    let led = opening + 1;
    while (led < lines.length && !THEMATIC.test(lines[led]) && !LEAD.test(lines[led])) led += 1;
    let bare = opening;
    while (bare < lines.length && !EMPTY_ITEM.test(clean[bare]) && !HEADING.test(clean[bare])) {
      bare += 1;
    }
    // Where each marker lands in `stripped`: its offset in the chunk less the
    // marker characters removed before it.
    const spans = mergedSpans(near, chunkStart, chunkEnd);
    const removed = [0];
    for (const [left, right] of spans) removed.push(removed[removed.length - 1] + right - left);
    blocks.push({ body, stripped });
    for (const r of wanted) {
      const row = lineOf(starts, r.start) - start; // 0-based in chunk
      let k = 0; // how many spans start before the marker
      for (let hi = spans.length; k < hi;) {
        const mid = (k + hi) >> 1;
        if (spans[mid][0] < r.start) k = mid + 1;
        else hi = mid;
      }
      const gone = removed[k] - (k ? Math.max(0, spans[k - 1][1] - r.start) : 0);
      const eligible =
        single &&
        opens &&
        opening <= row &&
        row < Math.min(led, bare) &&
        !isSpaceTabOnly(clean[row]) &&
        (htmlFirst === null || htmlFirst >= start + row);
      let list = carriers.get(r.marker.id);
      if (list === undefined) carriers.set(r.marker.id, (list = []));
      list.push({
        subhash: r.marker.hasSubhash === true,
        block: blocks.length - 1,
        offset: r.start - chunkStart - gone,
        eligible,
      });
    }
  }
  // Whether each carrier's block body is unique, settled once per block.
  for (const block of blocks) block.unique = bodies.get(block.body) === 1;
  return { counts, carriers, blocks };
}

/**
 * The ids among `ids` whose block stay was rewritten in place as a child stay
 * (SPEC.md §16, v1.10): one plain marker before and one `subhash` marker after,
 * in the same place in an unchanged list block that no other block duplicates.
 * `opts.segmentBefore` / `opts.segmentAfter` override the blank-line segmenter
 * with the caller's own (a tree adapter's blocks).
 */
export function adoptedIds(beforeMd, afterMd, ids, opts = {}) {
  const wanted = new Set(ids);
  const b = adoptionView(beforeMd, opts.segmentBefore ?? segmentBlankLine, wanted);
  const a = adoptionView(afterMd, opts.segmentAfter ?? segmentBlankLine, wanted);
  const same = new Map(); // block pair -> unchanged, compared once each
  const out = new Set();
  for (const mid of wanted) {
    if (b.counts.get(mid) !== 1 || a.counts.get(mid) !== 1) continue;
    const bc = b.carriers.get(mid) ?? [];
    const ac = a.carriers.get(mid) ?? [];
    if (bc.length !== 1 || ac.length !== 1) continue;
    const [x, y] = [bc[0], ac[0]];
    const pair = `${x.block}:${y.block}`;
    if (!same.has(pair)) same.set(pair, b.blocks[x.block].stripped === a.blocks[y.block].stripped);
    if (
      !x.subhash &&
      y.subhash &&
      x.eligible &&
      y.eligible &&
      same.get(pair) &&
      x.offset === y.offset &&
      b.blocks[x.block].unique &&
      a.blocks[y.block].unique
    ) {
      out.add(mid);
    }
  }
  return out;
}
