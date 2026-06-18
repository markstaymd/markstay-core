// Hash normalization and body hashing (SPEC.md §8). Port of `normalize_body`
// and `body_hash` from linter/markstay_lint.py.

import { createHash } from "node:crypto";
import { ASCII_TRAILING_WS } from "./text.js";

/**
 * Normalize a block body for hashing (SPEC.md §8), in order:
 *   1. line endings CRLF / lone CR -> LF
 *   2. strip per-line trailing ASCII whitespace
 *   3. drop leading and trailing blank lines
 * Markers are removed upstream before this runs. The trailing-whitespace set is
 * ASCII (matching Python `rstrip(" \t\f\v")`), so the SHA-256 agrees across
 * implementations without a Unicode whitespace table (SPEC.md §8).
 */
export function normalizeBody(text) {
  const t = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = t.split("\n").map((ln) => ln.replace(ASCII_TRAILING_WS, ""));
  while (lines.length && lines[0] === "") lines.shift();
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

/**
 * SHA-256 of the UTF-8 encoding of the normalized body, lowercase hex.
 * Optionally truncated to `length` hex chars (prefix), matching SPEC.md §8
 * truncation. `length` of 0 / null / undefined returns the full 64-char digest.
 */
export function bodyHash(text, length = null) {
  const h = createHash("sha256").update(normalizeBody(text), "utf8").digest("hex");
  return length ? h.slice(0, length) : h;
}
