// Blank-line block segmentation (SPEC.md §5 baseline). Port of
// `_segment_blank_line` from linter/markstay_lint.py.
//
// CommonMark-tree segmentation (§5.2) is deferred from JS v1 (it needs a
// Markdown parser); only the dependency-free blank-line path is implemented.

import { isAsciiBlankLine } from "./text.js";

const FRONTMATTER_OPEN = /^---[ \t]*$/;
const FRONTMATTER_CLOSE = /^(?:---|\.\.\.)[ \t]*$/;
// One payload line that could only be YAML, never Markdown prose: a mapping key or
// a list item. Used to tell real frontmatter from a leading thematic break that
// happens to be followed by another one. A YAML comment (`# ...`) is deliberately
// NOT accepted: it is byte-identical to an ATX heading, so accepting it lets
// `---` / `# Heading` / `---` be read as frontmatter and silently destroys the
// heading. Comment-only frontmatter therefore is not skipped, which is the safe
// direction to be wrong in.
//
// `[^\x00-\x20\x7f]` is "not an ASCII control character and not a space", written
// out rather than as `\S`. Whitespace is ASCII-pinned here exactly as it is for
// hashing (§8) and matching (§9), because Python, ECMAScript and Rust each define
// Unicode whitespace differently: U+001C is whitespace to Python only, U+0085 to
// Python and Rust only, U+00A0 to Python and ECMAScript only, U+FEFF to ECMAScript
// only. A `\S` here therefore makes four conforming implementations skip different
// spans, which for a rule that DELETES a span from the document is the one kind of
// divergence that loses data.
const YAMLISH_LINE = /^[ \t]*(?:-[ \t]+[^\x00-\x20\x7f]|[^\x00-\x20\x7f:#][^:]*:(?:[ \t]|$))/;

/**
 * Blank a leading YAML frontmatter block so the segmenter never sees it as
 * content (SPEC.md §5). Port of `_blank_frontmatter` from
 * linter/markstay_lint.py.
 *
 * Frontmatter is document metadata, not a block: it carries no prose to identify,
 * and hashing it makes a metadata edit (`status: draft` -> `status: done`) drift a
 * content hash. It is removed *before* segmentation rather than filtered after,
 * because the two segmenters disagree about what it is: the baseline reads the
 * whole fenced span as one block, while CommonMark reads the opening `---` as a
 * thematic break and the closing one as a setext underline, turning the metadata
 * into an H2. Leaving it in puts a document that is inside SPEC.md §5.4's
 * agreement subset outside the set the two segmenters actually agree on.
 *
 * Recognition is deliberately conservative, because `---` is also a thematic break
 * and a setext underline, so a loose rule silently eats real content. All four must
 * hold:
 *
 *   1. line 1 is exactly `---`;
 *   2. a later line is exactly `---` or `...` (the closing fence). Without one the
 *      opener is an ordinary thematic break;
 *   3. the payload between the fences is non-empty and contains no blank line. This
 *      is what stops `---` / blank / `Intro.` / blank / `---` (two thematic breaks
 *      around a paragraph) from being read as frontmatter that swallows the
 *      paragraph;
 *   4. at least one payload line is unambiguously YAML (a `key:` or a `- item`).
 *      This is what stops `---` / `Title` / `---` (a thematic break followed by a
 *      setext heading) from being read as frontmatter.
 *
 * Conditions 3 and 4 confine the ambiguity rather than removing it. Any blank-free
 * payload that reads as YAML is *also* ordinary Markdown: `---` / `- Keep this` /
 * `---` is a list between two thematic breaks, `---` / `title: v` / `---` is a
 * setext heading under one. Both satisfy all four conditions and their content *is*
 * excluded. Frontmatter wins, the same call every mainstream site generator makes.
 * A document that fails any of the four conditions falls through to ordinary
 * Markdown, where the worst case is that frontmatter is not skipped (a stray
 * hash-drift warning) rather than content being silently discarded.
 *
 * Lines are replaced one-for-one with empty lines, so every line number the caller
 * reports is unchanged. Internal: not part of the package's public API.
 */
export function blankFrontmatter(text) {
  const lines = text.split("\n");
  if (!lines.length || !FRONTMATTER_OPEN.test(lines[0])) return text;
  for (let i = 1; i < lines.length; i++) {
    if (!FRONTMATTER_CLOSE.test(lines[i])) continue;
    const payload = lines.slice(1, i);
    if (!payload.length || payload.some((ln) => isAsciiBlankLine(ln))) return text;
    if (!payload.some((ln) => YAMLISH_LINE.test(ln))) return text;
    return [...Array(i + 1).fill(""), ...lines.slice(i + 1)].join("\n");
  }
  return text;
}

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
