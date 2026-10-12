// Type declarations for the markstay JS reference implementation (SPEC.md v1.10,
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
  /** Lowercase hex of a valid bare `subhash=sha256:...`, or null. */
  subhash: string | null;
  /** Exact parsed-key presence, even when the subhash value is invalid. */
  hasSubhash: boolean;
  /** The exact matched marker text, including its delimiters. */
  raw: string;
  /** Which marker grammar matched. */
  syntax: MarkerSyntax;
  /** 1-based line in the document where the marker starts. */
  line: number;
  /** True when no parseable id was found (no usable `stay:ID`). */
  malformed: boolean;
}

/** A segmented content block with its lexical marker tokens (SPEC.md §5/§16). */
export interface Block {
  /** Body with markers removed and ASCII-trimmed; "" for an orphan marker chunk. */
  content: string;
  /**
   * Lexical markers in this block, in document order. A marker carrying
   * `subhash` is not the stay of this containing block (§16).
   */
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

/** One Git-independent input to `checkEntries`. */
export interface CommitEntry {
  status: string;
  src: string;
  dst: string;
  before: string | null;
  after: string | null;
}

export interface BaselinePairing {
  path: string;
  baseline: string | null;
}

export type CheckReport = [label: string, findings: Finding[]];

export interface StagedCheck {
  reports: CheckReport[];
  notes: string[];
  pairings: BaselinePairing[];
  hasErrors: boolean;
}

export interface CheckEntriesOptions {
  scope?: string[];
}

// --- hashing (hash.js, SPEC.md §8) ---

export function normalizeBody(text: string): string;
export function bodyHash(text: string, length?: number | null): string;

// --- text helpers (text.js) ---

export function asciiTrim(s: string): string;

// --- markers (markers.js, SPEC.md §3 / §4) ---

export function findMarkers(text: string, lineOffset?: number): Marker[];
/** True when a marker may identify the §5 block containing it. */
export function isBlockStayMarker(marker: Marker): boolean;
export function stripMarkers(text: string): string;

/** A marker as seen by `rewriteMarkers`: parsed id/hash plus the raw match. */
export interface RawMarker {
  id: string | null;
  hash: string | null;
  subhash: string | null;
  hasSubhash: boolean;
  /** The exact matched marker text, including delimiters. */
  raw: string;
  syntax: MarkerSyntax;
  /** 1-based line in the document where the marker starts. */
  line: number;
  malformed: false;
  /** The marker body (between the delimiters), e.g. `stay:8f24 hash=sha256:7a9c`. */
  body: string;
}

/**
 * Rewrite markers in place, in document order. `transform` returns a replacement
 * string, or null/undefined to leave a marker unchanged. `code` is the SPEC.md
 * §3.3 mask: matches opening on one of those lines are left byte-for-byte alone.
 */
export function rewriteMarkers(
  text: string,
  transform: (marker: RawMarker) => string | null | undefined,
  code?: ReadonlySet<number> | null
): string;

// --- fenced code blocks (code.js, SPEC.md §3.3) ---

/** Fence geometry: lines inside a fence, and lines a fence is still open after. */
export interface FenceState {
  inside: Set<number>;
  openAfter: Set<number>;
}

export function fenceState(text: string): FenceState;
/** The 1-based line numbers inside a fenced code block (SPEC.md §3.3). */
export function codeLines(text: string): Set<number>;
/** Strip markers, leaving marker-shaped strings inside a fence in place (§3.3). */
export function stripMarkersOutsideCode(
  text: string,
  code: ReadonlySet<number>,
  lineOffset?: number
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
  /** Segmenter (default "blank-line"); other modes are rejected by this core. */
  mode?: ParseMode;
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
export interface LintDiffBlocksOptions {
  /**
   * SPEC.md §16 (v1.10): given the ids that would be dropped, return the ones
   * whose block stay was rewritten in place as a child stay. They are reported
   * as the warning `ADOPTED_ID` instead of `DROPPED_ID`.
   */
  adopted?: (ids: string[]) => Set<string>;
}
export function lintDiffBlocks(
  beforeBlocks: Block[],
  afterBlocks: Block[],
  opts?: LintDiffBlocksOptions
): Finding[];
export interface AdoptedIdsOptions {
  /** The caller's segmenter over the normalized text, in place of blank-line. */
  segmentBefore?: (text: string) => Chunk[];
  segmentAfter?: (text: string) => Chunk[];
}
/** SPEC.md §16 (v1.10): which of `ids` were rewritten in place as child stays. */
export function adoptedIds(
  beforeMd: string,
  afterMd: string,
  ids: Iterable<string>,
  opts?: AdoptedIdsOptions
): Set<string>;
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

/** The SPEC.md §11 preservation instruction, worded for an editing agent. */
export const PRESERVE_INSTRUCTION: string;
/** The return-format line the eval's measured prompt shape appends. */
export const PRESERVE_RETURN_ONLY: string;
export function preserveWrap(doc: string, task?: string | null): string;

// --- commit checking (staged.js, SPEC.md §11) ---

export function isMarkdown(path: string): boolean;
export function checkEntries(
  entries: CommitEntry[],
  opts?: CheckEntriesOptions
): StagedCheck;
