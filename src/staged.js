// Git-independent core for `check-staged` / `check-worktree`.
//
// The CLI materializes each Git change as { status, src, dst, before, after }.
// Keeping baseline pairing here makes the commit-shaped behavior available to the
// shared corpus instead of leaving it embedded in three separate command drivers.

import { hasErrors, lintDiff, lintDocument } from "./lint.js";
import { parseDocument } from "./parse.js";
import { idIndex } from "./lint.js";

const MD_RE = /\.(md|markdown)$/;

export function isMarkdown(path) {
  // `.markstay/` holds a vendored linter and a PRESERVE.md that demonstrates the
  // marker form twice; linting it would report a duplicate id that is not the
  // repo's problem.
  if (path === ".markstay" || path.startsWith(".markstay/")) return false;
  return MD_RE.test(path);
}

const idsOf = (text) =>
  text == null ? new Set() : new Set(idIndex(parseDocument(text)).keys());

/**
 * Check commit-shaped entries without reading Git or the filesystem.
 *
 * Each entry carries `status`, `src`, `dst`, and nullable `before` / `after`
 * strings. `before` is HEAD at `src` for R/C/D and at `dst` otherwise. `after`
 * is the staged or worktree text for every non-deletion.
 */
export function checkEntries(entries, { scope = [] } = {}) {
  const changed = entries.filter((e) => e.status !== "D" && isMarkdown(e.dst));
  const deleted = entries.filter((e) =>
    (e.status === "D" && isMarkdown(e.src))
    || (e.status === "R" && isMarkdown(e.src) && !isMarkdown(e.dst)));
  const result = { reports: [], notes: [], pairings: [], hasErrors: false };
  if (!changed.length && !deleted.length) return result;

  const stagedText = new Map(changed.map((e) => [e.dst, e.after ?? ""]));
  const stagedIds = new Map([...stagedText].map(([p, t]) => [p, idsOf(t)]));
  const committedIds = new Set();
  for (const ids of stagedIds.values()) for (const id of ids) committedIds.add(id);

  const deletedIds = new Map(deleted.map((e) => [e.src, idsOf(e.before)]));
  const deletedText = new Map(deleted.map((e) => [e.src, e.before]));
  const claimed = new Set();

  function baselineFor(entry) {
    if (entry.status === "R" && isMarkdown(entry.src) && entry.before != null) {
      return [entry.before, entry.src];
    }
    if (entry.status !== "C" && entry.status !== "R" && entry.before != null) {
      return [entry.before, entry.dst];
    }

    // Added file, copy, or a rename Git scored as delete + create. The first
    // unclaimed deleted document with the largest positive id overlap wins.
    const mine = stagedIds.get(entry.dst) ?? new Set();
    let best = null;
    let bestN = 0;
    for (const [candidate, candidateIds] of deletedIds) {
      if (claimed.has(candidate)) continue;
      let n = 0;
      for (const id of mine) if (candidateIds.has(id)) n++;
      if (n > bestN) {
        best = candidate;
        bestN = n;
      }
    }
    if (best !== null) {
      claimed.add(best);
      return [deletedText.get(best), best];
    }
    return [null, null];
  }

  const wanted = new Set(scope);
  for (const entry of changed) {
    const staged = stagedText.get(entry.dst);
    const [baseline, origin] = baselineFor(entry);
    result.pairings.push({ path: entry.dst, baseline: origin });

    let findings = [...lintDocument(staged).findings];
    if (baseline != null) findings = findings.concat(lintDiff(baseline, staged));

    const kept = [];
    for (const finding of findings) {
      if (finding.code === "DROPPED_ID" && committedIds.has(finding.id)) {
        const elsewhere = [...stagedIds]
          .filter(([path, ids]) => path !== entry.dst && ids.has(finding.id))
          .map(([path]) => path)
          .sort();
        result.notes.push(`${finding.id}: moved out of ${origin ?? entry.dst} into `
          + `${elsewhere.join(", ")} (still in this commit, not blocking)`);
        continue;
      }
      kept.push(finding);
    }

    if (wanted.size && !wanted.has(entry.dst)) continue;
    if (kept.length) {
      const label = origin == null || origin === entry.dst
        ? entry.dst
        : `${entry.dst} (baseline ${origin})`;
      result.reports.push([label, kept]);
      if (hasErrors(kept)) result.hasErrors = true;
    }
  }

  for (const entry of deleted) {
    if (claimed.has(entry.src)) continue;
    const gone = [...(deletedIds.get(entry.src) ?? [])]
      .filter((id) => !committedIds.has(id))
      .sort();
    if (gone.length) {
      const shown = gone.slice(0, 6).join(", ") + (gone.length > 6 ? ", ..." : "");
      if (entry.status === "R") {
        result.notes.push(`${entry.src}: renamed to ${entry.dst}, leaving Markdown tracking `
          + `with ${gone.length} stay(s) not carried by another Markdown file (${shown})`);
      } else {
        result.notes.push(`${entry.src}: deleted with ${gone.length} stay(s) that no staged file `
          + `carries (${shown})`);
      }
    }
  }

  return result;
}
