// Marker grammar and discovery (SPEC.md §3 / §4).
//
// One host-first scanner owns discovery, stripping, and rewriting. Recognition
// runs on an LF-normalized view, while spans and `raw` always address the exact
// caller text. This matters for hand-written multiline values and for rejected
// host comments whose later bytes contain another valid opener.

const HTML_OPEN = "<!--";
const MDX_OPEN = "{/*";

const isSpaceTab = (c) => c === " " || c === "\t";
const isAlpha = (c) => c !== undefined && /[A-Za-z]/.test(c);
const isIdChar = (c) => c !== undefined && /[A-Za-z0-9_-]/.test(c);

/** Normalize CRLF/lone CR and map each normalized boundary to a raw offset. */
function normalizedView(text) {
  let normalized = "";
  const rawBoundaries = [0];
  for (let raw = 0; raw < text.length;) {
    if (text[raw] === "\r") {
      raw += text[raw + 1] === "\n" ? 2 : 1;
      normalized += "\n";
    } else {
      // Delimiters and grammar syntax are ASCII. Copying one UTF-16 code unit at
      // a time also keeps every normalized boundary usable with String.slice.
      normalized += text[raw];
      raw += 1;
    }
    rawBoundaries.push(raw);
  }
  return { normalized, rawBoundaries };
}

function nextOpener(text, from) {
  const html = text.indexOf(HTML_OPEN, from);
  const mdx = text.indexOf(MDX_OPEN, from);
  if (html < 0) return mdx < 0 ? null : { start: mdx, syntax: "mdx", open: MDX_OPEN };
  if (mdx < 0 || html <= mdx) return { start: html, syntax: "html", open: HTML_OPEN };
  return { start: mdx, syntax: "mdx", open: MDX_OPEN };
}

/** The first host-owned close, whether or not it completes a marker form. */
function hostClose(text, syntax, from) {
  if (syntax === "mdx") {
    const start = text.indexOf("*/", from);
    if (start < 0) return null;
    return { start, end: start + (text[start + 2] === "}" ? 3 : 2), valid: text[start + 2] === "}" };
  }
  const ordinary = text.indexOf("-->", from);
  const parseError = text.indexOf("--!>", from);
  if (ordinary < 0 && parseError < 0) return null;
  if (parseError >= 0 && (ordinary < 0 || parseError < ordinary)) {
    return { start: parseError, end: parseError + 4, valid: false };
  }
  return { start: ordinary, end: ordinary + 3, valid: true };
}

/** Parse one complete normalized-LF marker body, beginning exactly at `stay:`. */
function parseBody(body) {
  if (!body.startsWith("stay:")) return null;
  let pos = 5;
  const idStart = pos;
  while (isIdChar(body[pos])) pos += 1;
  if (pos === idStart || (pos < body.length && !isSpaceTab(body[pos]))) return null;
  const id = body.slice(idStart, pos);
  const idEnd = pos;
  const attributes = [];

  while (pos < body.length) {
    const separatorStart = pos;
    while (isSpaceTab(body[pos])) pos += 1;
    if (pos === body.length) break;
    if (pos === separatorStart || !isAlpha(body[pos])) return null;

    const keyStart = pos;
    pos += 1;
    while (isIdChar(body[pos])) pos += 1;
    const key = body.slice(keyStart, pos);
    if (body[pos] !== "=") return null;
    pos += 1;
    if (pos === body.length) return null;

    const quoted = body[pos] === '"';
    let value;
    let valueStart;
    let valueEnd;
    if (quoted) {
      pos += 1;
      valueStart = pos;
      while (pos < body.length && body[pos] !== '"') {
        const c = body[pos];
        if (c === "\\") {
          if (body[pos + 1] !== "\\" && body[pos + 1] !== '"') return null;
          pos += 2;
          continue;
        }
        const cp = c.charCodeAt(0);
        if (c !== "\n" && (cp < 0x20 || cp > 0x7e)) return null;
        pos += 1;
      }
      if (pos === body.length) return null;
      valueEnd = pos;
      value = body.slice(valueStart, pos);
      pos += 1;
    } else {
      valueStart = pos;
      while (pos < body.length && !isSpaceTab(body[pos])) {
        const cp = body.charCodeAt(pos);
        if (body[pos] === '"' || cp < 0x21 || cp > 0x7e) return null;
        pos += 1;
      }
      if (pos === valueStart) return null;
      valueEnd = pos;
      value = body.slice(valueStart, pos);
    }
    attributes.push({ key, value, quoted, keyStart, valueStart, valueEnd });
  }
  return { id, idEnd, attributes };
}

/** The one invalid shape for which §4 still requires a lint diagnostic. */
function malformedKeyFirst(body) {
  if (!body.startsWith("stay:")) return false;
  let pos = 5;
  if (!isAlpha(body[pos])) return false;
  pos += 1;
  while (isIdChar(body[pos])) pos += 1;
  return body[pos] === "=";
}

/** Internal accepted/diagnostic records with exact source spans. */
export function scanMarkerRecords(text, lineOffset = 0) {
  const { normalized, rawBoundaries } = normalizedView(text);
  const records = [];
  let cursor = 0;
  while (cursor < normalized.length) {
    const opener = nextOpener(normalized, cursor);
    if (opener === null) break;
    let bodyStart = opener.start + opener.open.length;
    while (isSpaceTab(normalized[bodyStart])) bodyStart += 1;
    if (!normalized.startsWith("stay:", bodyStart)) {
      cursor = opener.start + 1;
      continue;
    }

    const close = hostClose(normalized, opener.syntax, bodyStart + 5);
    if (close === null) {
      cursor = opener.start + 1;
      continue;
    }
    const body = normalized.slice(bodyStart, close.start);
    const parsed = close.valid ? parseBody(body) : null;
    const malformed = parsed === null && malformedKeyFirst(body);
    if (parsed === null && !malformed) {
      cursor = opener.start + 1;
      continue;
    }

    const attributes = parsed?.attributes ?? [];
    let hash = null;
    let subhash = null;
    let hashAttribute = null;
    for (const attr of attributes) {
      const digest = attr.quoted ? null : /^sha256:([0-9a-fA-F]+)$/.exec(attr.value);
      if (attr.key === "hash" && digest && hash === null) {
        hash = digest[1].toLowerCase();
        hashAttribute = attr;
      }
      if (attr.key === "subhash" && digest && subhash === null) subhash = digest[1].toLowerCase();
    }
    const start = rawBoundaries[opener.start];
    const end = rawBoundaries[close.end];
    const rawBodyStart = rawBoundaries[bodyStart];
    const marker = {
      id: parsed?.id ?? null,
      hash,
      subhash,
      hasSubhash: attributes.some((attr) => attr.key === "subhash"),
      raw: text.slice(start, end),
      syntax: opener.syntax,
      line: lineOffset + normalized.slice(0, opener.start).split("\n").length,
      malformed,
    };
    const staySpan = parsed
      ? [rawBodyStart - start, rawBoundaries[bodyStart + parsed.idEnd] - start]
      : null;
    const hashSpan = hashAttribute
      ? [
          rawBoundaries[bodyStart + hashAttribute.keyStart] - start,
          rawBoundaries[bodyStart + hashAttribute.valueEnd] - start,
        ]
      : null;
    records.push({ start, end, body, marker, staySpan, hashSpan });
    // Every opener is an independent candidate. In particular, a valid outer
    // marker does not hide a nested opener from §5.6's overlap refusal.
    cursor = opener.start + 1;
  }
  return records;
}

/** True when a lexical marker may identify its containing §5 block. */
export function isBlockStayMarker(marker) {
  return !marker.malformed && !marker.hasSubhash;
}

/** All valid markers plus the required no-id diagnostics, in source order. */
export function findMarkers(text, lineOffset = 0) {
  return scanMarkerRecords(text, lineOffset).map((record) => record.marker);
}

function removableRecords(text, lineOffset = 0) {
  return scanMarkerRecords(text, lineOffset).filter((record) => !record.marker.malformed);
}

function rewriteRecords(text, records, transform) {
  if (records.length === 0) return text;
  const out = [];
  let previous = 0;
  for (const record of records) {
    out.push(text.slice(previous, record.start));
    const replacement = transform(record.marker, record);
    out.push(replacement === undefined || replacement === null ? record.marker.raw : replacement);
    previous = record.end;
  }
  out.push(text.slice(previous));
  return out.join("");
}

function overlappingRecords(records) {
  const overlaps = new Set();
  for (let i = 0; i < records.length; i++) {
    for (let j = i + 1; j < records.length && records[j].start < records[i].end; j++) {
      overlaps.add(records[i]);
      overlaps.add(records[j]);
    }
  }
  return overlaps;
}

function stripRecords(text, records) {
  if (records.length === 0) return text;
  const ranges = [];
  for (const record of records) {
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

/** Remove every complete valid marker. Diagnostic-only candidates remain text. */
export function stripMarkers(text) {
  return stripRecords(text, removableRecords(text));
}

/**
 * Rewrite complete valid markers in document order. Markers whose opener lies on
 * a §3.3 fenced-code line, or whose span overlaps another active valid marker,
 * remain byte-for-byte unchanged.
 */
export function rewriteMarkers(text, transform, code = null) {
  const active = removableRecords(text).filter(
    (record) => !(code && code.has(record.marker.line)),
  );
  const overlaps = overlappingRecords(active);
  const records = active.filter((record) => !overlaps.has(record));
  return rewriteRecords(text, records, (marker, record) =>
    transform({ ...marker, body: record.body })
  );
}

/** Parsed-span surgery for writers. These are internal package helpers. */
export function replaceMarkerHash(raw, hash) {
  const span = scanMarkerRecords(raw)[0]?.hashSpan;
  if (!span) return raw;
  return `${raw.slice(0, span[0])}hash=sha256:${hash}${raw.slice(span[1])}`;
}

export function insertMarkerHash(raw, hash) {
  const span = scanMarkerRecords(raw)[0]?.staySpan;
  if (!span) return raw;
  return `${raw.slice(0, span[1])} hash=sha256:${hash}${raw.slice(span[1])}`;
}

export function replaceMarkerId(raw, id) {
  const span = scanMarkerRecords(raw)[0]?.staySpan;
  if (!span) return raw;
  return `${raw.slice(0, span[0])}stay:${id}${raw.slice(span[1])}`;
}
