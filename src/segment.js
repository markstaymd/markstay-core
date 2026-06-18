// Blank-line block segmentation (SPEC.md §5 baseline). Port of
// `_segment_blank_line` from linter/markstay_lint.py.
//
// CommonMark-tree segmentation (§5.2) is deferred from JS v1 (it needs a
// Markdown parser); only the dependency-free blank-line path is implemented.

import { isAsciiBlankLine } from "./text.js";

/**
 * Split `text` into blocks: a block is a maximal run of non-blank lines bounded
 * by blank lines or the document edges. Returns [startLine1Based, chunkText]
 * spans in document order. A blank line is empty or only ASCII whitespace
 * (SPEC.md §5; matches Python `ln.strip(" \t\f\v") == ""`).
 */
export function segmentBlankLine(text) {
  const chunks = [];
  let cur = [];
  let start = null;
  const lines = text.split("\n");
  for (let idx = 0; idx < lines.length; idx++) {
    const ln = lines[idx];
    if (isAsciiBlankLine(ln)) {
      if (cur.length) {
        chunks.push([start, cur.join("\n")]);
        cur = [];
        start = null;
      }
    } else {
      if (!cur.length) start = idx + 1;
      cur.push(ln);
    }
  }
  if (cur.length) chunks.push([start, cur.join("\n")]);
  return chunks;
}
