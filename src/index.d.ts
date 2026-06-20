// Type declarations for the markstay JS reference implementation (SPEC.md v1.1,
// parser-free core). Hand-written to match the runtime shapes the modules in this
// directory actually produce; keep in sync with index.js on any surface change.

/** Marker grammar family (SPEC.md §3): HTML comment or MDX comment-expression. */
export type MarkerSyntax = "html" | "mdx";

/** A markstay marker discovered in source text (SPEC.md §3 / §4). */
export interface Marker {
  /** The id token after `stay:`, or null when the marker is malformed. */
  id: string | null;
  /** Lowercase hex of the stored `hash=sha256:...`, or null when absent. */
  hash: string | null;
  /** The exact matched marker text, including its delimiters. */
  raw: string;
  /** Which marker grammar matched. */
  syntax: MarkerSyntax;
  /** 1-based line in the document where the marker starts. */
  line: number;
  /** True when no parseable id was found (no usable `stay:ID`). */
  malformed: boolean;
}

/** A segmented content block with the markers bound to it (SPEC.md §5). */
export interface Block {
  /** Body with markers removed and ASCII-trimmed; "" for an orphan marker chunk. */
  content: string;
  /** Markers bound to this block, in document order. */
  markers: Marker[];
  /** 1-based start line of the block (or of the orphan marker chunk). */
  line: number;
  /** 0-based content-block index; -1 marks an orphan marker chunk. */
  index: number;
}

/** Severity of a lint / diff finding (SPEC.md §7). */
export type FindingLevel = "error" | "warn" | "info";

/** A single lint or regeneration-diff finding. */
export interface Finding {
  level: FindingLevel;
  /** Stable machine code, e.g. "HASH_DRIFT", "DROPPED_ID", "ORPHAN_MARKER". */
  code: string;
  message: string;
  /** The id the finding concerns, or null. */
  id: string | null;
  /** 1-based line, or null for document-level diff findings. */
  line: number | null;
}

/** A quote selector for §9 recovery: the block body plus neighbour context. */
export interface Selector {
  /** The stored block body (the primary recovery key). */
  quote: string;
  /** Preceding-block context, for the §9 tie-break bonus. */
  prefix?: string;
  /** Following-block context, for the §9 tie-break bonus. */
  suffix?: string;
}

/** An anchor extracted from an annotated baseline block (SPEC.md §9). */
export interface Anchor {
  id: string;
  /** Full 64-char body hash of the baseline block. */
  hash: string;
  selector: Selector;
}

/** The tier of evidence that resolved an id (SPEC.md §9.1 ladder). */
export type ResolveMethod = "marker" | "hash" | "quote" | "detached";

/** The outcome of resolving one anchor against an edited document. */
export interface Resolution {
  id: string;
  method: ResolveMethod;
  /** After-document content-block index, or null when detached. */
  target: number | null;
  score: number;
}

/** Result of ranking candidate bodies against a selector (`bestMatch`). */
export interface BestMatchResult {
  /** Winning candidate index, or -1 when there are no candidates. */
  index: number;
  /** Score of the winner, in [0, 1]. */
  score: number;
  /** Score of the runner-up, in [0, 1] (0 when there is no second candidate). */
  runnerUp: number;
}

/** A matching block `[aIndex, bIndex, size]` over Unicode code points. */
export type MatchingBlock = [number, number, number];

/** A blank-line chunk `[startLine1Based, chunkText]` in document order. */
export type Chunk = [number, string];

/**
 * Parse / segmentation mode. The JS reference implements "blank-line" only;
 * CommonMark mode (§5.2) is provided by the remark-stay adapter, not the core.
 */
export type ParseMode = "blank-line";

// --- hashing (hash.js, SPEC.md §8) ---

export function normalizeBody(text: string): string;
export function bodyHash(text: string, length?: number | null): string;

// --- text helpers (text.js) ---

export function asciiTrim(s: string): string;

// --- markers (markers.js, SPEC.md §3 / §4) ---

export function findMarkers(text: string, lineOffset?: number): Marker[];
export function stripMarkers(text: string): string;

/** A marker as seen by `rewriteMarkers`: parsed id/hash plus the raw match. */
export interface RawMarker {
  id: string | null;
  hash: string | null;
  /** The exact matched marker text, including delimiters. */
  raw: string;
  syntax: MarkerSyntax;
  /** The marker body (between the delimiters), e.g. `stay:8f24 hash=sha256:7a9c`. */
  body: string;
}

/**
 * Rewrite markers in place, in document order. `transform` returns a replacement
 * string, or null/undefined to leave a marker unchanged.
 */
export function rewriteMarkers(
  text: string,
  transform: (marker: RawMarker) => string | null | undefined
): string;

// --- id generation (id.js, SPEC.md §6) ---

export const DEFAULT_ALPHABET: string;
export const DEFAULT_ID_LENGTH: number;
/** The §6 id charset matcher: /^[A-Za-z0-9_-]+$/. */
export const ID_CHARSET: RegExp;

export interface MintIdOptions {
  length?: number;
  alphabet?: string;
  /** Byte source `n => Uint8Array`-like; injectable for deterministic tests. */
  random?: (n: number) => Uint8Array;
}
export function mintId(opts?: MintIdOptions): string;

// --- write path (stamp.js, SPEC.md §3 / §4 / §6 / §7 / §8) ---

/** Default hex-prefix length for a freshly written hash (§8 truncation). */
export const DEFAULT_HASH_LENGTH: number;

export function formatAttrValue(value: unknown): string;

export interface FormatMarkerInput {
  id: string;
  /** Hex digest (any precision); emitted as `hash=sha256:<hex>`. Omit/false to skip. */
  hash?: string | null | false;
  /** Extra attributes as an object or [key, value] pairs (callers `x-`-namespace). */
  attrs?: Record<string, unknown> | Array<[string, unknown]> | null;
  syntax?: MarkerSyntax;
}
export function formatMarker(input: FormatMarkerInput): string;

export interface StampOptions extends MintIdOptions {
  syntax?: MarkerSyntax;
  /** Include a `hash` attribute (default true). */
  hash?: boolean;
  /** Hex-prefix length for the written hash (default 12). */
  hashLength?: number;
  /** Id factory; overrides mintId + the MintIdOptions fields. */
  newId?: () => string;
}
export interface StampResult {
  /** The stamped document (line endings normalized to LF). */
  text: string;
  /** Ids minted this run, with the 1-based line each marker was inserted after. */
  minted: Array<{ id: string; line: number }>;
}
export function stamp(md: string, opts?: StampOptions): StampResult;

export interface RestampOptions {
  /** Recompute at this precision; null preserves each marker's stored length. */
  hashLength?: number | null;
  /** Also add a hash to well-formed markers that carry none (default false). */
  addMissing?: boolean;
}
export interface RestampResult {
  text: string;
  /** Ids whose hash was refreshed (or added). */
  refreshed: string[];
}
export function restamp(md: string, opts?: RestampOptions): RestampResult;

export interface RepairDuplicatesOptions extends MintIdOptions {
  newId?: () => string;
}
export interface RepairDuplicatesResult {
  text: string;
  /** Each later occurrence of a duplicated id and the fresh id it received. */
  renamed: Array<{ from: string; to: string }>;
}
export function repairDuplicates(md: string, opts?: RepairDuplicatesOptions): RepairDuplicatesResult;

// --- segmentation (segment.js, SPEC.md §5) ---

export function segmentBlankLine(text: string): Chunk[];

// --- parsing (parse.js, SPEC.md §5) ---

export function parseDocument(md: string, mode?: ParseMode): Block[];

// --- lint + diff (lint.js, SPEC.md §7 / §8 / §10 / §11) ---

export function lintBlocks(blocks: Block[]): Finding[];
export function lintDocument(
  md: string,
  mode?: ParseMode
): { blocks: Block[]; findings: Finding[] };
export function lintDiff(beforeMd: string, afterMd: string, mode?: ParseMode): Finding[];
export function lintDiffBlocks(beforeBlocks: Block[], afterBlocks: Block[]): Finding[];
export function sortFindings(findings: Finding[]): Finding[];
export function hasErrors(findings: Finding[]): boolean;

// --- similarity ratio (ratio.js, SPEC.md §9) ---

export function ratio(a: string, b: string): number;
export function matchingBlocks(a: string, b: string): MatchingBlock[];

// --- quote scoring (quote.js, SPEC.md §9) ---

/** Neighbour context kept on each side for the §9 tie-break bonus, in code points. */
export const CONTEXT_CHARS: number;
export function normalize(text: string): string;
export function quoteRatio(a: string, b: string): number;
export function bodyScore(sel: Selector, candidate: string): number;
export function contextBonus(sel: Selector, prevText: string, nextText: string): number;
export function bestMatch(sel: Selector, candidates: string[]): BestMatchResult;

// --- resolver (resolve.js, SPEC.md §9.1 ladder) ---

/** Default QUOTE-tier commit threshold (SPEC.md §9). */
export const DEFAULT_THRESHOLD: number;
/** Default QUOTE-tier winner-over-runner-up margin (SPEC.md §9). */
export const DEFAULT_MARGIN: number;

export interface ResolveOptions {
  mode?: ParseMode;
  threshold?: number;
  margin?: number;
}
export interface ResolveOverBlocksOptions {
  threshold?: number;
  margin?: number;
}

export function buildAnchors(beforeMd: string, mode?: ParseMode): Anchor[];
export function buildAnchorsFromBlocks(blocks: Block[]): Anchor[];
export function resolve(
  anchors: Anchor[],
  afterMd: string,
  opts?: ResolveOptions
): Record<string, Resolution>;
export function resolveOverBlocks(
  anchors: Anchor[],
  afterBlocks: Block[],
  opts?: ResolveOverBlocksOptions
): Record<string, Resolution>;
