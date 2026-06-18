// markstay JS reference implementation, public API (SPEC.md v1.1, parser-free
// core). Mirrors the Python reference surface (linter/markstay_lint.py and
// eval/attachment/{quote,resolver}.py). Zero runtime dependencies; Node built-ins
// only. CommonMark mode (§5.2) is deferred from v1.

export { normalizeBody, bodyHash } from "./hash.js";
export { asciiTrim } from "./text.js";
export { findMarkers, stripMarkers } from "./markers.js";
export { segmentBlankLine } from "./segment.js";
export { parseDocument } from "./parse.js";
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
  CONTEXT_CHARS,
} from "./quote.js";
export {
  buildAnchors,
  buildAnchorsFromBlocks,
  resolve,
  resolveOverBlocks,
  DEFAULT_THRESHOLD,
  DEFAULT_MARGIN,
} from "./resolve.js";
