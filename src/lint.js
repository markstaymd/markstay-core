// Well-formedness, intra-document checks, and the regeneration diff
// (SPEC.md §7 / §8 / §10 / §11). Port of `lint_document`, `lint_diff`,
// `_id_index`, `sort_findings`, `has_errors` from linter/markstay_lint.py.

import { bodyHash } from "./hash.js";
import { parseDocument } from "./parse.js";

const LEVELS = { error: 0, warn: 1, info: 2 };

function finding(level, code, message, id = null, line = null) {
  return { level, code, message, id, line };
}

/**
 * Well-formedness and intra-document invariants over a pre-segmented block list
 * (SPEC.md §7 / §8 / §10). The block list is the only segmentation-dependent
 * input, so this is the single source of the finding logic: the blank-line front
 * end (`lintDocument`) and any tree front end (the remark adapter) both feed
 * their blocks here and get identical findings on segmentations that agree.
 *
 * Each block is { content, markers: [{ id, hash, malformed, line, raw }], index }
 * where index < 0 marks an orphan marker chunk. Returns findings in detection
 * order (use sortFindings for the canonical ordering).
 */
export function lintBlocks(blocks) {
  const findings = [];
  const seen = new Map();

  for (const b of blocks) {
    const orphan = b.index === -1;
    for (const mk of b.markers) {
      if (mk.malformed) {
        findings.push(
          finding("error", "MALFORMED_MARKER",
            `marker has no parseable id: ${JSON.stringify(mk.raw)}`, null, mk.line)
        );
        continue;
      }
      if (orphan) {
        findings.push(
          finding("error", "ORPHAN_MARKER",
            `marker ${mk.id} has no preceding block to attach to`, mk.id, mk.line)
        );
      }
      if (seen.has(mk.id)) {
        findings.push(
          finding("error", "DUPLICATE_ID",
            `id ${mk.id} appears more than once (first at line ${seen.get(mk.id)})`,
            mk.id, mk.line)
        );
      } else {
        seen.set(mk.id, mk.line);
      }
      if (mk.hash && b.content) {
        const now = bodyHash(b.content, mk.hash.length);
        if (now !== mk.hash) {
          findings.push(
            finding("warn", "HASH_DRIFT",
              `id ${mk.id}: stored sha256:${mk.hash} != current sha256:${now} ` +
                `(content edited since the hash was written)`, mk.id, mk.line)
          );
        }
      }
    }
  }
  return findings;
}

/**
 * Well-formedness and intra-document invariants for a single document.
 * Returns { blocks, findings }. Findings carry { level, code, message, id, line }
 * in detection order (use sortFindings for the canonical ordering).
 */
export function lintDocument(md, mode = "blank-line") {
  const blocks = parseDocument(md, mode);
  return { blocks, findings: lintBlocks(blocks) };
}

/** id -> list of content blocks carrying that id, in document order. */
function idIndex(blocks) {
  const out = new Map();
  for (const b of blocks) {
    if (b.index < 0) continue;
    for (const mk of b.markers) {
      if (mk.id && !mk.malformed) {
        let arr = out.get(mk.id);
        if (arr === undefined) {
          arr = [];
          out.set(mk.id, arr);
        }
        arr.push(b);
      }
    }
  }
  return out;
}

/**
 * Regeneration diff (SPEC.md §11): what an edit did to the ids. Catches the
 * AI-rewrite failure mode (dropped markers) plus duplication and exact-content
 * relocation. Returns findings in detection order.
 */
export function lintDiff(beforeMd, afterMd, mode = "blank-line") {
  return lintDiffBlocks(parseDocument(beforeMd, mode), parseDocument(afterMd, mode));
}

/**
 * Regeneration diff over two pre-segmented block lists (the segmentation-neutral
 * core of `lintDiff`). The blank-line front end and the tree adapter both build
 * their before/after blocks and call this, so the diff verdict is single-sourced.
 */
export function lintDiffBlocks(beforeBlocks, afterBlocks) {
  const beforeIdx = idIndex(beforeBlocks);
  const before = new Map();
  for (const [mid, blks] of beforeIdx) {
    if (blks.length === 1) before.set(mid, blks[0]);
  }
  const after = idIndex(afterBlocks);
  const findings = [];

  for (const mid of before.keys()) {
    if (!after.has(mid)) {
      findings.push(
        finding("error", "DROPPED_ID",
          `id ${mid} was in the baseline but is gone after the edit (silent loss)`, mid)
      );
    }
  }

  for (const [mid, blks] of after) {
    if (blks.length > 1) {
      findings.push(
        finding("error", "DUPLICATED_ID",
          `id ${mid} appears ${blks.length} times after the edit ` +
            `(copy without re-mint, or a regeneration collision)`, mid)
      );
    }
  }

  for (const mid of after.keys()) {
    if (!before.has(mid)) {
      findings.push(
        finding("info", "NEW_ID", `id ${mid} is new (not in the baseline)`, mid)
      );
    }
  }

  // content-keyed before index, for exact-swap relocation detection
  const beforeByContent = new Map();
  for (const [mid, b] of before) {
    if (b.content) {
      const h = bodyHash(b.content);
      if (!beforeByContent.has(h)) beforeByContent.set(h, mid);
    }
  }

  for (const [mid, blks] of after) {
    if (!before.has(mid) || blks.length !== 1) continue;
    const a = blks[0];
    const b0 = before.get(mid);
    if (!a.content || !b0.content) continue;
    if (bodyHash(a.content) === bodyHash(b0.content)) continue; // unchanged
    const movedFrom = beforeByContent.get(bodyHash(a.content));
    if (movedFrom && movedFrom !== mid) {
      findings.push(
        finding("error", "RELOCATED_ID",
          `id ${mid} now sits on content that previously carried id ${movedFrom} ` +
            `(markers look swapped or relocated)`, mid)
      );
    } else {
      findings.push(
        finding("warn", "HASH_DRIFT",
          `id ${mid}: content changed between versions (edited in place)`, mid)
      );
    }
  }
  return findings;
}

/** Canonical finding order: (level rank, line, code). Stable. */
export function sortFindings(findings) {
  const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return [...findings].sort(
    (x, y) =>
      ((LEVELS[x.level] ?? 9) - (LEVELS[y.level] ?? 9)) ||
      ((x.line || 0) - (y.line || 0)) ||
      cmpStr(x.code, y.code)
  );
}

export function hasErrors(findings) {
  return findings.some((f) => f.level === "error");
}
