# markstay , JavaScript reference implementation (v1 core)

[![npm](https://img.shields.io/npm/v/markstay)](https://www.npmjs.com/package/markstay)
[![bundle size](https://img.shields.io/bundlephobia/minzip/markstay)](https://bundlephobia.com/package/markstay)
[![tests](https://img.shields.io/github/actions/workflow/status/markstaymd/markstay-core/test.yml?label=tests)](https://github.com/markstaymd/markstay-core/actions/workflows/test.yml)
[![spec](https://img.shields.io/badge/spec-v1.8-blue)](https://markstay.org)
![License](https://img.shields.io/npm/l/markstay)

A second, independent implementation of the [markstay spec](https://markstay.org)
(v1.8), in zero-dependency JavaScript. Its purpose is to validate that the
standard is unambiguous: where the spec's two central promises (§8 hashing and §9
recovery) used to be defined *by reference to the Python implementation*, a second
implementation gated by a shared language-neutral conformance corpus turns "two
implementations agree" from an assertion into a tested fact.

This is the **parser-free core**: everything string-level and parser-independent.
It covers both halves of the spec, the read side (parse / lint / resolve) and the
write side (mint ids, stamp a document, refresh hashes, repair duplicates). The
CommonMark-tree (§5.2) mdast adapter ships separately as `remark-stay`.

**Child-block identity (§5.5 and §5.6) is not implemented here.** Version 1.3 lets a
direct list item carry its own stay under the reserved `subhash` key; version 1.6
does the same for a GFM table body row. Section 16 makes segmenting and resolving
those **optional**. Its mandatory compatibility layer is parser-free: an exact
`subhash` key, even with an invalid digest, is preserved verbatim, is never given a
container hash, and is never reported as its containing block's stay. The Python
reference implements child segmentation and resolution.

**Write safety (§3.4, v1.8).** `stamp` inserts new markers on marker-only lines.
It never emits a list-item or table-row carrier, and never relocates a table's
container marker, so the carrier refusals in §3.4 and §5.6 cannot be reached here.
Refreshing a hash or repairing an id keeps an existing same-line marker in place,
as §3.4 permits. The §16 compatibility rules above still apply to child-stamped
input. The optional `OUTSIDE_SUBSET` advisory requires a §5.2 parser and is not
implemented by this parser-free core.

## Install

```sh
npm install markstay        # library
npm install -g markstay     # or use the `markstay` CLI via npx
```

Requires Node >= 22 (uses `node:crypto`). Zero runtime dependencies.

## Keeping stays alive through an agent's edit (start here)

Almost every stay that goes missing goes missing the same way: a model rewrote the
document and did not know the markers were load-bearing. The eval measured both
halves of the fix, and they are not close , a naive "clean this up" rewrite keeps
about **5%** of markers, the same rewrite carrying the SPEC.md §11 instruction keeps
**~96-100%**, across five models and three vendors. That outweighs model tier.

```sh
markstay preserve                  # the §11 instruction, ready to paste into
                                   #   AGENTS.md / CLAUDE.md / a system prompt
markstay preserve --wrap DOC.md    # the instruction wrapped around a document,
                                   #   as a complete editing prompt
markstay preserve --wrap DOC.md --task "Rewrite this to be clearer."
```

```js
import { PRESERVE_INSTRUCTION, preserveWrap } from "markstay";

PRESERVE_INSTRUCTION;                 // the §11 contract, worded for an agent
preserveWrap(doc, "Tighten it.");     // the prompt shape the eval measured
```

The instruction is byte-identical in the PyPI and crates.io packages, held there by
the shared conformance corpus rather than by convention.

Everything below is the **backstop**: it catches loss after the fact, it does not
prevent it. Ship the instruction first.

## CLI

```sh
markstay preserve                   # the §11 instruction for an editing agent (§11)
markstay preserve --wrap DOC.md     # that instruction + the doc, as a prompt
markstay lint    FILE...            # well-formedness + intra-doc checks (§7/§8/§10)
markstay lint    --before OLD NEW   # regeneration diff (§11)
markstay check-staged [FILE...]     # lint the staged commit vs its baseline (§11)
markstay check-worktree [FILE...]   # the same check against the files on disk
markstay stamp   FILE... [-w]       # mint ids for every unmarked block (§6)
markstay restamp FILE... [-w]       # refresh hashes that drifted (§8)
markstay repair  FILE... [-w]       # mint fresh ids for duplicate ids (§7)
```

`lint` exits non-zero when any error-level finding is reported, so it gates a
commit hook or an agent's post-edit step (`--json` for machine output). The write
verbs print to stdout by default; `-w`/`--write` edits in place. `stamp` takes
`--mdx` (emit the `{/* ... */}` form), `--no-hash`, and `--hash-length N`.

`HASH_DRIFT` (a block edited in place) never blocks and is the dominant line in a
normal edit, so the text render **hides it by default** and collapses it to one
receipt (`-> N hash-drift findings hidden (--show-drift to list)`); pass
`--show-drift` to enumerate it. This is presentation only: the finding stays at
`warn` in the `lintDocument` / `lintDiff` return values and in `--json` (which is
byte-identical with and without `--show-drift`), so caches and re-embed triggers
that treat a stale hash as fatal read those, unaffected.

### Gating commits (husky + lint-staged)

`check-staged` is the verb a hook wants. Every other verb works on files; this one
works on a commit, because catching a dropped stay means diffing against the same
document *before* the edit, and only git knows what that was.

```jsonc
// package.json
{
  "lint-staged": {
    "*.{md,markdown}": "markstay check-staged"
  }
}
```

```sh
# .husky/pre-commit
npx lint-staged
```

It exits non-zero when the staged commit drops, duplicates, or relocates a stay,
and stays quiet otherwise: a commit that only edits stamped blocks in place or
mints new ids prints nothing, so the channel keeps meaning something. `--json` for
machine output, `--show-drift` to see the quiet findings anyway.

lint-staged appends the matched filenames, which scope the *report*. The commit is
still read whole, because a renamed document's baseline lives in a deleted path and
lint-staged never passes one.

`check-worktree` asks the same question of the files on disk, staged or not, including
untracked ones. A commit hook fires once per commit, which can be days after an editing
pass and inside a diff too large to read line by line; this reports in seconds, so it
suits an agent's post-edit step rather than a gate.

**The baseline is resolved by stay id, not by filename.** git's rename detection is
content-similarity based, and similarity is anti-correlated with this failure mode:
the more a rewrite destroys, the more stays it can drop *and* the less git sees a
rename. A measured real case scored 2% similarity, so git recorded delete + create
and a path-keyed baseline found nothing to compare against. A surviving stay id is
the stronger signal. An id that moved to another document in the same commit is
reported as a move rather than a loss, so reorganising documents does not block.

```sh
$ printf 'Hello world.\n' > doc.md && markstay stamp doc.md
Hello world.
<!-- stay:B81r4tJA hash=sha256:aa3ec16e6acc -->   # id is random; hash is the §8 body hash
```

## Layout

```
src/
  ratio.js     SequenceMatcher.ratio over Unicode code points (the §9 crux)
  hash.js      §8 normalization + SHA-256 body hashing
  markers.js   §3/§4 strict host-first marker grammar + discovery
  code.js      §3.3 fenced-code mask (a marker in a fence is content)
  segment.js   §5 blank-line block segmentation
  parse.js     §5 document -> content blocks with lexical marker tokens
  lint.js      §7/§8/§10 lint + §11 regeneration diff
  quote.js     §9 quote/selector scoring (body score, context bonus, best match)
  resolve.js   §9.1 resolution ladder (MARKER -> HASH -> QUOTE -> DETACHED)
  id.js        §6 opaque id minting (injectable byte source)
  stamp.js     §3/§4/§6/§7/§8 write path: formatMarker, stamp, restamp, repair
  staged.js    git-independent commit checking + stay-id baseline pairing (§11)
  text.js      shared ASCII whitespace + ASCII case-fold helpers (§8/§5/§9)
  index.js     public API
bin/
  cli.js       the `markstay` CLI (preserve / lint / check / write verbs)
test/
  conformance.test.js   runs the shared corpus (conformance/)
  markers.test.js       strict §4 discovery, host close, and raw-preservation tests
  unit.test.js          behavioral ports of the Python reference's lint/attach tests
  stamp.test.js         write-path invariants (stamp/restamp/repair, idempotence)
```

## Public API

Read side (mirrors the Python reference surface): `normalizeBody`, `bodyHash`,
`asciiTrim`, `findMarkers`, `isBlockStayMarker`, `stripMarkers`, `fenceState`, `codeLines`,
`stripMarkersOutsideCode`, `segmentBlankLine`, `parseDocument`,
`lintDocument`, `lintDiff`, `sortFindings`, `hasErrors`, `ratio`, `matchingBlocks`,
`normalize`, `quoteRatio`, `bodyScore`, `contextBonus`, `bestMatch`,
`buildAnchors`, `resolve`.

Write side (string-level, parser-free):

- `mintId(opts?)` , a short opaque id (§6); `opts.random` injects a byte source
  for deterministic tests.
- `formatMarker({ id, hash?, attrs?, syntax? })` , serialize one marker (§3/§4),
  with `formatAttrValue` and `rewriteMarkers` as the lower-level pieces.
- `stamp(md, opts?)` , mint an id for every unmarked block and append its trailing
  marker. Returns `{ text, minted }`; never alters block bodies and is idempotent.
  `mode` defaults to `"blank-line"`; any other mode is rejected, as in `parseDocument`.
- `restamp(md, opts?)` , refresh hashes that drifted (the deliberate "I edited
  this on purpose" step); `{ addMissing: true }` adds a hash to markers lacking one.
- `repairDuplicates(md, opts?)` , the first block keeps a duplicated id, every
  later one is re-minted (§7 copy-mints-new).

Every minting path funnels through an injectable id factory, so the write helpers
are deterministic under test.

Prevention side (§11): `PRESERVE_INSTRUCTION`, `PRESERVE_RETURN_ONLY`,
`preserveWrap(doc, task?)`. Pure text composition , no parsing, no I/O , and
byte-identical to the PyPI and crates.io packages, asserted by the corpus.

Commit-check side (§11): `checkEntries(entries, { scope? })` takes materialized
commit entries (`status`, `src`, `dst`, `before`, `after`) and returns baseline
pairings, findings, and non-blocking move/deletion notes. The CLI supplies those
entries from Git; the pure function is held in sync across languages by the
commit-shaped `check` corpus category.

## Running the tests

Requires Node >= 22 (uses `node:test` and `node:crypto`; no install step).

```sh
node --test          # or: npm test
```

> Note: pass no path argument. `node --test` auto-discovers `test/*.test.js`.
> A bare directory argument (`node --test test/`) is not expanded on Node 22 and
> is treated as a script path, so it errors; use `node --test` or an explicit
> glob (`node --test test/*.test.js`).

The shared corpus contributes 420 cross-language assertions; CLI and unit tests
cover the Git adapter, rendering, and write-path invariants around it.

## The conformance corpus (the actual deliverable)

The corpus lives under [`conformance/`](conformance) and is shared with the Python
reference. **420 core vectors** across two tiers, plus an optional `rows` profile
(SPEC.md §5.6 table-row identity and §3.4 carrier refusals, 32 vectors) that this
reference **declines**:
§16 keeps child segmentation optional and this implementation does not segment
child blocks. Declining is a declared, asserted state rather than a silent skip,
so the runner fails if the profile disappears from the corpus, if its vector count
changes, or if a profile it has never heard of turns up.

| category | spec | gen | covers |
|----------|-----:|----:|--------|
| hash     | 10   | 14  | §8 ASCII normalization + SHA-256 + truncation (incl. NBSP kept) |
| markers  | 16   | 12  | §3/§4 grammar, malformed, positional-id (no rescue), uppercase-hex |
| parse    | 50   | 9   | §5 blank-line segmentation + marker attachment, incl. the leading-frontmatter exclusion, the thematic-break spans it must not eat, and §3.3's fenced-code mask |
| lint     | 12   | 8   | §7/§8/§10 findings (ordered) |
| diff     | 7    | 6   | §11 regeneration diff (ordered) |
| seqmatch | 9    | 143 | raw Ratcliff/Obershelp ratio + matching blocks |
| score    | 12   | 19  | §9 wrappers: body score, context bonus, best match, ASCII fold |
| resolve  | 26   | 9   | §9.1 ladder + margin guard |
| anchors  | 4    | 0   | §9 selector storage, which resolution cannot see |
| mint     | 4    | 0   | §6 id minting over an injected byte source (incl. rejection) |
| stamp    | 9    | 20  | §3/§4/§6/§7/§8 write path: stamp, restamp, repair, incl. §3.3's writer rule |
| preserve | 7    | 0   | §11 instruction text + the measured prompt composition |
| check    | 14   | 0   | §11 baseline pairing, findings, moves, tracking departures, deletion notes, scope |
| **total**| **180** | **240** | |

The `preserve` row is the odd one and deliberately so: it holds plain prose rather
than a computation. Each implementation carries its own copy of the §11 instruction
(an installed package has no corpus on disk), and this category is what keeps the
three copies byte-identical. A project whose whole claim is catching silent drift
should not let its own instruction text drift silently.

- **`spec/`** , hand-authored from the spec prose, asserting what the *words*
  require. These are authority; a `spec/` vector the reference fails is a
  reference bug, not a corpus error.
- **`gen/`** , emitted from the Python reference for breadth/regression.

The Python reference (published at [markstay.org](https://markstay.org)) runs the
same JSON, so the two runners are a cross-impl regression sentinel: any later
change to either implementation that breaks agreement fails one of them.

## Notable parity details

- **`ratio.js` matches CPython `difflib` bit-for-bit** (verified to delta 0 over
  4000+ pairs), including the earliest-match tie-break, `autojunk=False` (no junk
  / no popularity heuristic), and **Unicode code points, not UTF-16 units** , so
  non-BMP text (emoji) agrees. The `matching_blocks` are locked too, not just the
  scalar ratio: two matchers can hit the same ratio via different block
  decompositions.
- **Float comparison** uses a `1e-9` tolerance; in practice the ratios are
  bit-identical because both languages do the same IEEE-754 `2*M/T`.
- **ASCII normalization, pinned (§8/§5/§9):** whitespace (trailing strip, blank
  lines, §9 collapse) and the §9 case-fold are pinned to ASCII in the spec and
  both implementations, so hashing and recovery agree exactly without a Unicode
  whitespace or case-fold table (`src/text.js` is the single definition).
  Non-ASCII characters compare unchanged; a `spec/` vector (`É` vs `é`) pins that
  Unicode casefold is *not* used.
- **Leading YAML frontmatter is metadata, not a block (§5.3):** it is skipped before
  segmentation, so it is never a block, never stamped, and never hashed , a
  metadata-only edit (`status: draft` -> `status: done`) must not read as a content
  edit. Recognition is conservative, because `---` is also a thematic break and a
  setext underline: a span counts only when line 1 is exactly `---`, a later line is
  exactly `---` or `...`, the payload between them is non-empty with no blank line,
  and at least one payload line is unambiguously YAML (a `key:` or a `- item`). A
  YAML *comment* does not count, since `# x` is also an ATX heading. "Unambiguously
  YAML" is judged with ASCII whitespace, as everywhere else in the spec (§8/§9): the
  runtimes' own Unicode whitespace sets disagree with each other, and a rule that
  DELETES a span must not vary by implementation. The conditions confine the
  ambiguity rather than removing it, and the rule does not pretend otherwise: a
  blank-free payload that reads as YAML is *also* ordinary Markdown, whether it is a
  sequence (`---` / `- Keep this` / `---`, a list between two thematic breaks) or a
  mapping (`---` / `title: v` / `---`, a setext heading under one). Both are accepted
  and their content is excluded. **Frontmatter wins**, the same call every mainstream
  Markdown site generator makes on the same bytes. A document that fails any of the
  four conditions (no opening `---`, no closing fence, a blank line in the payload,
  no payload line that reads as YAML) falls through to ordinary Markdown, where the
  worst case is a spurious block and a stray hash-drift warning. A marker an older version stamped onto
  frontmatter usually raises `ORPHAN_MARKER`, and deleting that one marker is the
  whole migration. **Lint before deleting**: with no blank line between the marker
  and the content below it, blank-line segmentation reads one run and binds the
  marker to that content, so it is live rather than orphaned and deleting it drops
  a working id.
- **Text inside a fenced code block is content, not markup (§3.3):** a
  marker-shaped string there identifies no block, stays in the hashed body, and
  never makes its block stamped; a writer will not put one there either. That is
  what lets a document *about* markstay show its own markers in examples, which is
  the document the rule exists for. Recognition is a line scan applied once over
  the whole document, on the frontmatter precedent, because neither segmenter has a
  concept of a fence: at most three leading **spaces** (a tab is not one of them,
  since CommonMark expands it against a column model this rule deliberately does
  not have), then three or more backticks or tildes, closed by the first later line
  that is a run of the same character at least as long, followed by nothing but
  spaces and tabs. An unclosed fence runs to the end of the document, and a
  backtick fence's info string may not contain a backtick. **Its limit is stated
  rather than hidden**: a fence indented four spaces or carrying a blockquote or
  list-item prefix on the opening line is invisible to the line scan, so a marker
  after it can go silent. It fails closed (nothing is compared, the block just
  looks unstamped) rather than corrupting anything. **Inline code spans are
  deliberately out of scope**: a marker mangled into a span is still one a tool can
  see, which beats one that has silently stopped existing. **Migration:** a
  document whose body gained a fenced marker-shaped string drifts once and a
  `restamp` clears it; a fence whose only marker was an example is now unstamped
  and takes a fresh stay on the next `stamp`.
- **Positional id (§4):** the id is the first token after `stay:` (`^`-anchored);
  a marker whose first token is a bare `k=v` is malformed even if a later
  `stay:ID` appears in the body, matching the Python reference's `ID_RE.match`.

## License

MIT
