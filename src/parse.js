// Document parsing into content blocks with lexical marker tokens (SPEC.md §5).
// Port of `parse_document` (blank-line mode) from linter/markstay_lint.py.

import { scanMarkerRecords } from "./markers.js";
import { codeLines } from "./code.js";
import { blankFrontmatter, segmentBlankLine } from "./segment.js";
import { asciiTrim } from "./text.js";

function markerFacts(record) {
  const marker = record.marker;
  return [
    marker.line,
    marker.syntax,
    marker.id,
    marker.hash,
    marker.subhash,
    marker.hasSubhash,
    marker.malformed,
  ];
}

export function documentMarkerRecords(md, normalized, text) {
  const normalizedLines = normalized.split("\n");
  const blankedLines = text.split("\n");
  const frontmatterLines = new Set();
  for (let i = 0; i < normalizedLines.length; i++) {
    if (normalizedLines[i] !== blankedLines[i]) frontmatterLines.add(i + 1);
  }
  const rawRecords = scanMarkerRecords(md).filter(
    (record) => !frontmatterLines.has(record.marker.line),
  );
  const normalizedRecords = scanMarkerRecords(text);
  const same = rawRecords.length === normalizedRecords.length
    && rawRecords.every((record, i) =>
      JSON.stringify(markerFacts(record)) === JSON.stringify(markerFacts(normalizedRecords[i]))
    );
  if (!same) return normalizedRecords;
  return normalizedRecords.map((record, i) => ({
    ...record,
    marker: { ...record.marker, raw: rawRecords[i].marker.raw },
  }));
}

export function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}

export function stripRecordRanges(chunk, records, sourceStart) {
  const sourceEnd = sourceStart + chunk.length;
  const spans = [];
  for (const record of records) {
    const left = Math.max(sourceStart, record.start);
    const right = Math.min(sourceEnd, record.end);
    if (left >= right) continue;
    const previous = spans[spans.length - 1];
    if (previous && left < previous[1]) previous[1] = Math.max(previous[1], right);
    else spans.push([left, right]);
  }
  if (!spans.length) return chunk;
  const out = [];
  let previous = sourceStart;
  for (const [start, end] of spans) {
    out.push(chunk.slice(previous - sourceStart, start - sourceStart));
    previous = end;
  }
  out.push(chunk.slice(previous - sourceStart));
  return out.join("");
}

/**
 * Parse into content blocks with the marker tokens they contain, blank-line mode
 * (SPEC.md §5 baseline). A leading YAML frontmatter block is metadata rather than
 * content and is skipped before segmentation (see `blankFrontmatter`). A chunk
 * that is only markers attaches to the previous content block; a marker-only
 * chunk with no preceding content block is an orphan (index -1).
 *
 * `markers` is a lexical preservation/diagnostic bucket. Callers that report a
 * block stay must additionally apply §16's `isBlockStayMarker` predicate.
 * Returns block objects: { content, markers, line, index }. `index` is the
 * 0-based content-block index; -1 marks an orphan marker chunk.
 *
 * `mode` defaults to "blank-line". CommonMark mode (§5.2) is deferred from JS
 * v1; any other mode is rejected, matching the reference's ValueError.
 */
export function parseDocument(md, mode = "blank-line") {
  if (mode !== "blank-line") {
    throw new Error(
      `unknown parse mode: ${JSON.stringify(mode)} ` +
        `(JS v1 implements 'blank-line' only; CommonMark §5.2 is deferred)`
    );
  }
  const normalized = md.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const text = blankFrontmatter(normalized);
  // SPEC.md §3.3: text inside a fenced code block is content. The rule is computed
  // once over the whole document and threaded, on the `blankFrontmatter`
  // precedent, because neither segmenter has a concept of a fence and
  // `findMarkers` is handed chunks. Blanking preserves line numbers, so this mask
  // indexes the caller's text too.
  const code = codeLines(text);
  const chunks = segmentBlankLine(text);
  const documentRecords = documentMarkerRecords(md, normalized, text);
  const activeRecords = documentRecords.filter((record) => !code.has(record.marker.line));
  const removableRecords = activeRecords.filter((record) => !record.marker.malformed);
  const starts = lineStarts(text);

  const blocks = [];
  let cidx = 0;
  for (const [start, chunk] of chunks) {
    const chunkStart = starts[start - 1];
    const chunkEnd = chunkStart + chunk.length;
    // §3.3: a marker-shaped string in a fence is content, not a marker.
    const markers = activeRecords
      .filter((record) => chunkStart <= record.start && record.start < chunkEnd)
      .map((record) => record.marker);
    // ASCII strip (SPEC.md §5/§8)
    const stripped = stripRecordRanges(chunk, removableRecords, chunkStart);
    const content = asciiTrim(stripped);
    if (content === "") {
      // marker-only chunk: attach to the previous content block if any
      const last = blocks[blocks.length - 1];
      if (last && last.index >= 0) {
        last.markers.push(...markers);
      } else {
        blocks.push({ content: "", markers, line: start, index: -1 });
      }
    } else {
      blocks.push({ content, markers, line: start, index: cidx });
      cidx += 1;
    }
  }
  return blocks;
}
