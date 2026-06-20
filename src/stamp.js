// The write path (SPEC.md §3 / §4 / §6 / §7 / §8): mint ids, serialize markers,
// stamp an unmarked corpus, refresh drifted hashes, and repair duplicate ids.
// String-level and parser-free like the rest of the core (no Markdown parser),
// so it stays dependency-free and runs under the blank-line segmenter (§5).
//
// Every operation is idempotent in the obvious sense: stamping an already-stamped
// document is a no-op, restamping an undrifted document is a no-op, and repairing
// a document with no duplicates is a no-op.

import { bodyHash } from "./hash.js";
import { parseDocument } from "./parse.js";
import { findMarkers, stripMarkers, rewriteMarkers } from "./markers.js";
import { segmentBlankLine } from "./segment.js";
import { asciiTrim } from "./text.js";
import { mintId, ID_CHARSET } from "./id.js";

// Default truncation for a freshly written hash (§8 permits any prefix). 12 hex =
// 48 bits, enough to make an accidental same-prefix collision within one document
// negligible, while staying lighter than the full 64-char digest.
export const DEFAULT_HASH_LENGTH = 12;

const KEY_RE = /^[A-Za-z][A-Za-z0-9_-]*$/; // §4 attribute key grammar
const HEX_RE = /^[0-9a-fA-F]+$/;

// Closing delimiter per syntax: a written value must never contain it, or it
// would terminate the marker early.
const TERMINATOR = { html: "-->", mdx: "*/}" };

/**
 * Serialize one attribute value (SPEC.md §4): a bare token when it has no
 * whitespace or double quote and is all printable ASCII, otherwise a
 * double-quoted string with `\\` and `\"` escaped.
 */
export function formatAttrValue(value) {
  const s = String(value);
  // §4 qchar: a value may only contain printable ASCII (0x20-0x7E); `"` and `\`
  // are escaped in the quoted form. A newline or other control character has no
  // representation and would corrupt the marker, so reject rather than emit it.
  if (!/^[\x20-\x7E]*$/.test(s)) {
    throw new Error(
      `formatAttrValue: value ${JSON.stringify(s)} contains a character outside ` +
        "the §4 qchar set (printable ASCII 0x20-0x7E)"
    );
  }
  if (s.length > 0 && /^[\x21-\x7E]+$/.test(s) && !s.includes('"')) return s;
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

/**
 * Serialize a marker (SPEC.md §3 / §4). Fields:
 *   id      required, matches the §6 charset
 *   hash    optional lowercase/uppercase hex; emitted as `hash=sha256:<hex>`
 *   attrs   optional extra attributes, as an object or [key, value] pairs;
 *           keys must satisfy the §4 key grammar (callers namespace extensions
 *           with `x-` themselves)
 *   syntax  "html" (default) or "mdx"
 *
 * Throws if the id/hash/keys are malformed, or if a serialized value would
 * contain the syntax's closing delimiter (which would break the marker).
 */
export function formatMarker({ id, hash = null, attrs = null, syntax = "html" } = {}) {
  if (!id || !ID_CHARSET.test(id)) {
    throw new Error(`formatMarker: invalid id ${JSON.stringify(id)} (must match [A-Za-z0-9_-]+)`);
  }
  if (syntax !== "html" && syntax !== "mdx") {
    throw new Error(`formatMarker: unknown syntax ${JSON.stringify(syntax)}`);
  }
  let body = `stay:${id}`;
  if (hash !== null && hash !== undefined && hash !== false) {
    const hex = String(hash);
    if (!HEX_RE.test(hex)) throw new Error(`formatMarker: hash must be hex, got ${JSON.stringify(hex)}`);
    body += ` hash=sha256:${hex.toLowerCase()}`;
  }
  const pairs = Array.isArray(attrs) ? attrs : attrs ? Object.entries(attrs) : [];
  for (const [k, v] of pairs) {
    if (!KEY_RE.test(k)) throw new Error(`formatMarker: invalid attribute key ${JSON.stringify(k)}`);
    body += ` ${k}=${formatAttrValue(v)}`;
  }
  if (body.includes(TERMINATOR[syntax])) {
    throw new Error(
      `formatMarker: a value contains the ${syntax} terminator ${JSON.stringify(TERMINATOR[syntax])}, ` +
        `which would break the marker`
    );
  }
  return syntax === "mdx" ? `{/* ${body} */}` : `<!-- ${body} -->`;
}

/** A minting function that never returns an id already present in `used`. */
function uniqueMinter(used, newId) {
  return () => {
    let id;
    do {
      id = newId();
    } while (used.has(id));
    used.add(id);
    return id;
  };
}

/**
 * Stamp every unmarked content block (SPEC.md §5/§6): for each block with no
 * well-formed id, mint one and append its marker on a new line directly after the
 * block (the §3.1 trailing form, no blank line, so it binds to that block).
 * Blocks that already carry a well-formed id are left untouched.
 *
 * Options:
 *   syntax      "html" (default) or "mdx"
 *   hash        include a `hash` (default true)
 *   hashLength  hex prefix length for the written hash (default 12)
 *   newId       () => string, the id factory (default mintId over the opts below)
 *   length/alphabet/random  forwarded to mintId when `newId` is not given
 *
 * Returns { text, minted: [{ id, line }] }. Line endings are normalized to LF.
 */
export function stamp(md, opts = {}) {
  const {
    syntax = "html",
    hash = true,
    hashLength = DEFAULT_HASH_LENGTH,
    newId,
    length,
    alphabet,
    random,
  } = opts;

  const norm = md.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = norm.split("\n");

  // Existing ids across the whole document, so a minted id can't collide.
  const used = new Set();
  for (const mk of findMarkers(norm)) if (mk.id && !mk.malformed) used.add(mk.id);
  const nextId = uniqueMinter(used, newId ?? (() => mintId({ length, alphabet, random })));

  // Walk blank-line chunks, mirroring parse.js attachment, but keep each content
  // block's last source line so a marker can be inserted right after it.
  const needsStamp = []; // { lastLine0, content }
  let current = null;
  for (const [startLine, chunk] of segmentBlankLine(norm)) {
    const content = asciiTrim(stripMarkers(chunk));
    const hasId = findMarkers(chunk).some((mk) => mk.id && !mk.malformed);
    if (content !== "") {
      const nLines = chunk.split("\n").length;
      current = { lastLine0: startLine + nLines - 2, content, hasId };
      needsStamp.push(current);
    } else if (current) {
      // marker-only chunk: its id (if any) identifies the preceding block
      if (hasId) current.hasId = true;
    }
  }

  const insertAfter = new Map(); // 0-based line -> marker text
  const minted = [];
  for (const blk of needsStamp) {
    if (blk.hasId) continue;
    const id = nextId();
    const hex = hash ? bodyHash(blk.content, hashLength) : null;
    insertAfter.set(blk.lastLine0, formatMarker({ id, hash: hex, syntax }));
    minted.push({ id, line: blk.lastLine0 + 1 });
  }

  if (insertAfter.size === 0) return { text: norm, minted: [] };

  const out = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]);
    if (insertAfter.has(i)) out.push(insertAfter.get(i));
  }
  return { text: out.join("\n"), minted };
}

/**
 * Refresh hashes that no longer match their block (SPEC.md §8): the deliberate
 * "I edited this block on purpose, accept the new content" operation. For each
 * well-formed marker whose stored `hash` differs from the current body hash (at
 * the stored precision), rewrite it to the current value. With `addMissing`,
 * markers that carry no hash gain one.
 *
 * Options: { hashLength = null (preserve each marker's precision), addMissing = false }.
 * Returns { text, refreshed: [id, ...] }. Line endings are normalized to LF.
 */
export function restamp(md, opts = {}) {
  const { hashLength = null, addMissing = false } = opts;
  const norm = md.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // id -> the block body it identifies (first occurrence wins; a duplicate id is
  // a separate lint error and is left for repairDuplicates).
  const contentById = new Map();
  for (const b of parseDocument(norm)) {
    if (b.index < 0) continue;
    for (const mk of b.markers) {
      if (mk.id && !mk.malformed && !contentById.has(mk.id)) contentById.set(mk.id, b.content);
    }
  }

  const refreshed = [];
  const text = rewriteMarkers(norm, (mk) => {
    if (!mk.id || !contentById.has(mk.id)) return null;
    const content = contentById.get(mk.id);
    if (mk.hash !== null) {
      const len = hashLength ?? mk.hash.length;
      const now = bodyHash(content, len);
      if (now === mk.hash) return null; // unchanged at this precision
      refreshed.push(mk.id);
      return mk.raw.replace(/hash\s*=\s*sha256:[0-9a-fA-F]+/, `hash=sha256:${now}`);
    }
    if (addMissing) {
      const now = bodyHash(content, hashLength ?? DEFAULT_HASH_LENGTH);
      refreshed.push(mk.id);
      return mk.raw.replace(/(stay:\s*[A-Za-z0-9_-]+)/, `$1 hash=sha256:${now}`);
    }
    return null;
  });
  return { text, refreshed };
}

/**
 * Repair duplicate ids (SPEC.md §7: copy mints a new stay). The first block to
 * carry a duplicated id keeps it; every later marker carrying that id is given a
 * fresh, collision-free id. A copied block's content is unchanged, so its hash
 * stays valid and is left as-is.
 *
 * Options: { newId } or { length, alphabet, random } forwarded to mintId.
 * Returns { text, renamed: [{ from, to }] }. Line endings are normalized to LF.
 */
export function repairDuplicates(md, opts = {}) {
  const { newId, length, alphabet, random } = opts;
  const norm = md.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const blocks = parseDocument(norm);

  const used = new Set();
  const count = new Map(); // id -> number of marker occurrences carrying it
  for (const b of blocks) {
    if (b.index < 0) continue;
    for (const mk of b.markers) {
      if (mk.id && !mk.malformed) {
        used.add(mk.id);
        count.set(mk.id, (count.get(mk.id) || 0) + 1);
      }
    }
  }
  // A duplicate is any id on more than one marker, so two markers sharing an id
  // on the *same* block (which lintDocument also flags) are repaired, not just
  // the copy-across-blocks case.
  const dup = new Set([...count].filter(([, c]) => c > 1).map(([id]) => id));
  if (dup.size === 0) return { text: norm, renamed: [] };

  const nextId = uniqueMinter(used, newId ?? (() => mintId({ length, alphabet, random })));
  const seen = new Map(); // id -> markers-with-this-id seen so far
  const renamed = [];
  const text = rewriteMarkers(norm, (mk) => {
    if (!mk.id || !dup.has(mk.id)) return null;
    const c = (seen.get(mk.id) || 0) + 1;
    seen.set(mk.id, c);
    if (c === 1) return null; // first occurrence keeps the id
    const fresh = nextId();
    renamed.push({ from: mk.id, to: fresh });
    return mk.raw.replace(/stay:\s*[A-Za-z0-9_-]+/, `stay:${fresh}`);
  });
  return { text, renamed };
}
