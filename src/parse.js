// Document parsing into content blocks with attached markers (SPEC.md §5).
// Port of `parse_document` (blank-line mode) from linter/markstay_lint.py.

import { findMarkers } from "./markers.js";
import { codeLines, stripMarkersOutsideCode } from "./code.js";
import { blankFrontmatter, segmentBlankLine } from "./segment.js";
import { asciiTrim } from "./text.js";

/**
 * Parse into content blocks with their attached markers, blank-line mode
 * (SPEC.md §5 baseline). A leading YAML frontmatter block is metadata rather than
 * content and is skipped before segmentation (see `blankFrontmatter`). A chunk
 * that is only markers attaches to the previous content block; a marker-only
 * chunk with no preceding content block is an orphan (index -1).
 *
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
  const text = blankFrontmatter(md.replace(/\r\n/g, "\n").replace(/\r/g, "\n"));
  // SPEC.md §3.3: text inside a fenced code block is content. The rule is computed
  // once over the whole document and threaded, on the `blankFrontmatter`
  // precedent, because neither segmenter has a concept of a fence and
  // `findMarkers` is handed chunks. Blanking preserves line numbers, so this mask
  // indexes the caller's text too.
  const code = codeLines(text);
  const chunks = segmentBlankLine(text);

  const blocks = [];
  let cidx = 0;
  for (const [start, chunk] of chunks) {
    // §3.3: a marker-shaped string in a fence is content, not a marker.
    const markers = findMarkers(chunk, start - 1).filter((mk) => !code.has(mk.line));
    // ASCII strip (SPEC.md §5/§8)
    const content = asciiTrim(stripMarkersOutsideCode(chunk, code, start - 1));
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
