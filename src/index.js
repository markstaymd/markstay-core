// markstay JS reference implementation, public API (SPEC.md v1.11, parser-free
// core). Mirrors the Python reference surface (linter/markstay_lint.py and
// eval/attachment/{quote,resolver}.py). Zero runtime dependencies; Node built-ins
// only. CommonMark mode (§5.2) is deferred from v1.

export { normalizeBody, bodyHash } from "./hash.js";
export { asciiTrim } from "./text.js";
export { findMarkers, isBlockStayMarker, stripMarkers, rewriteMarkers } from "./markers.js";
export { fenceState, codeLines, stripMarkersOutsideCode } from "./code.js";
export { segmentBlankLine } from "./segment.js";
export { parseDocument } from "./parse.js";
export { adoptedIds } from "./adoption.js";
export { mintId, DEFAULT_ALPHABET, DEFAULT_ID_LENGTH, ID_CHARSET } from "./id.js";
export {
  formatMarker,
  formatAttrValue,
  stamp,
  restamp,
  repairDuplicates,
  DEFAULT_HASH_LENGTH,
} from "./stamp.js";
export {
  lintDocument,
  lintBlocks,
  lintDiff,
  lintDiffBlocks,
  sortFindings,
  hasErrors,
} from "./lint.js";
export { ratio, matchingBlocks } from "./ratio.js";
export {
  normalize,
  quoteRatio,
  bodyScore,
  contextBonus,
  bestMatch,
  rankMatches,
  CONTEXT_CHARS,
} from "./quote.js";
export {
  buildAnchors,
  buildAnchorsFromBlocks,
  resolve,
  resolveOverBlocks,
  disjointIn,
  DEFAULT_THRESHOLD,
  DEFAULT_MARGIN,
  MERGE_CONTENDER_CAP,
} from "./resolve.js";
export {
  PRESERVE_INSTRUCTION,
  PRESERVE_RETURN_ONLY,
  preserveWrap,
} from "./preserve.js";
export { isMarkdown, checkEntries } from "./staged.js";
