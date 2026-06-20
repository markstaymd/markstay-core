// Marker grammar and discovery (SPEC.md §3 / §4). Port of the marker regexes,
// `find_markers`, and `_strip_markers` from linter/markstay_lint.py.
//
// Marker discovery is a raw-text scan, exactly as in the reference: the body is
// captured lazily up to the closing delimiter, then id / hash are pulled out of
// it. Capturing the whole body (not a fixed attribute order) tolerates reordered
// or extra attributes (SPEC.md §4 free-order grammar). A marker-shaped comment
// inside a code fence is therefore treated as a real marker (the current
// reference behaviour; whether it should is a tracked Open question).

// Python re.DOTALL -> JS `s` flag so `.` spans newlines. `\s` agrees with
// Python's on ASCII (the corpus keeps marker whitespace ASCII).
const HTML_MARKER_SRC = "<!--\\s*(stay:.*?)\\s*-->";
const MDX_MARKER_SRC = "\\{/\\*\\s*(stay:.*?)\\s*\\*/\\}";

// `^`-anchored: the id is the FIRST token after `stay:` (SPEC.md §4, positional).
// The marker body always begins with `stay:`, so anchoring stops a later
// `stay:ID` in the body (e.g. `stay:note=hello stay:ok`) from rescuing a marker
// whose first token is a bare `k=v` and is therefore malformed. Mirrors the
// Python reference's `ID_RE.match(body)`.
const ID_RE = /^stay:\s*([A-Za-z0-9_-]+)(?=\s|$)/;
const HASH_RE = /\bhash\s*=\s*sha256:([0-9a-fA-F]+)/;

function countNewlines(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s[i] === "\n") n++;
  return n;
}

/**
 * All markstay markers in `text`, ordered by position. `lineOffset` is the
 * 0-based line index where `text` begins in the full document. Returns marker
 * objects: { id, hash, raw, syntax, line, malformed }.
 */
export function findMarkers(text, lineOffset = 0) {
  const raw = [];
  for (const [src, syntax] of [
    [HTML_MARKER_SRC, "html"],
    [MDX_MARKER_SRC, "mdx"],
  ]) {
    const re = new RegExp(src, "gs");
    for (const m of text.matchAll(re)) {
      raw.push([m.index, m[0], syntax, m[1]]);
    }
  }
  raw.sort((x, y) => x[0] - y[0]);

  const out = [];
  for (const [start, full, syntax, body] of raw) {
    const line = lineOffset + countNewlines(text.slice(0, start)) + 1;
    const idm = ID_RE.exec(body);
    const hm = HASH_RE.exec(body);
    out.push({
      // Hex stored canonically lowercase: SPEC.md §8 makes hash comparison
      // case-insensitive, so `hash=sha256:ABCD` must not read as drift.
      id: idm ? idm[1] : null,
      hash: hm ? hm[1].toLowerCase() : null,
      raw: full,
      syntax,
      line,
      malformed: idm === null,
    });
  }
  return out;
}

/** Remove every marker from `text` (HTML first, then MDX, as the reference). */
export function stripMarkers(text) {
  return text
    .replace(new RegExp(HTML_MARKER_SRC, "gs"), "")
    .replace(new RegExp(MDX_MARKER_SRC, "gs"), "");
}

// One combined HTML|MDX pattern so a single ordered pass sees every marker in
// document order (rather than all HTML then all MDX). Capture group 1 is the HTML
// body, group 2 the MDX body; exactly one is set per match.
const COMBINED_MARKER_SRC = `${HTML_MARKER_SRC}|${MDX_MARKER_SRC}`;

/**
 * Rewrite markers in place, in document order, without disturbing surrounding
 * text. `transform(marker)` receives { id, hash, raw, syntax, body } and returns
 * a replacement string, or null/undefined to leave the marker unchanged. The
 * write helpers (restamp, repairDuplicates) build on this so marker edits reuse
 * the one canonical grammar instead of re-deriving it.
 */
export function rewriteMarkers(text, transform) {
  const re = new RegExp(COMBINED_MARKER_SRC, "gs");
  return text.replace(re, (full, htmlBody, mdxBody) => {
    const body = htmlBody !== undefined ? htmlBody : mdxBody;
    const syntax = htmlBody !== undefined ? "html" : "mdx";
    const idm = ID_RE.exec(body);
    const hm = HASH_RE.exec(body);
    const marker = {
      id: idm ? idm[1] : null,
      hash: hm ? hm[1].toLowerCase() : null,
      raw: full,
      syntax,
      body,
    };
    const out = transform(marker);
    return out === undefined || out === null ? full : out;
  });
}
