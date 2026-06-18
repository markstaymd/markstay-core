# markstay , JavaScript reference implementation (v1 core)

A second, independent implementation of the [markstay spec](https://markstay.org)
(v1.1), in zero-dependency JavaScript. Its purpose is to validate that the
standard is unambiguous: where the spec's two central promises (§8 hashing and §9
recovery) used to be defined *by reference to the Python implementation*, a second
implementation gated by a shared language-neutral conformance corpus turns "two
implementations agree" from an assertion into a tested fact.

This is the **parser-free core**: everything string-level and parser-independent.
The CommonMark-tree (§5.2) mdast adapter ships separately as `remark-stay`.

## Install

```sh
npm install markstay
```

Requires Node >= 22 (uses `node:crypto`). Zero runtime dependencies.

## Layout

```
src/
  ratio.js     SequenceMatcher.ratio over Unicode code points (the §9 crux)
  hash.js      §8 normalization + SHA-256 body hashing
  markers.js   §3/§4 marker grammar + discovery
  segment.js   §5 blank-line block segmentation
  parse.js     §5 document -> content blocks with attached markers
  lint.js      §7/§8/§10 lint + §11 regeneration diff
  quote.js     §9 quote/selector scoring (body score, context bonus, best match)
  resolve.js   §9.1 resolution ladder (MARKER -> HASH -> QUOTE -> DETACHED)
  text.js      shared ASCII whitespace + ASCII case-fold helpers (§8/§5/§9)
  index.js     public API
test/
  conformance.test.js   runs the shared corpus (conformance/)
  unit.test.js          behavioral ports of the Python reference's lint/attach tests
```

## Public API

`normalizeBody`, `bodyHash`, `asciiTrim`, `findMarkers`, `stripMarkers`,
`segmentBlankLine`, `parseDocument`, `lintDocument`, `lintDiff`, `sortFindings`,
`hasErrors`, `ratio`, `matchingBlocks`, `normalize`, `quoteRatio`, `bodyScore`,
`contextBonus`, `bestMatch`, `buildAnchors`, `resolve` (mirrors the Python
reference surface).

## Running the tests

Requires Node >= 22 (uses `node:test` and `node:crypto`; no install step).

```sh
node --test          # or: npm test
```

> Note: pass no path argument. `node --test` auto-discovers `test/*.test.js`.
> A bare directory argument (`node --test test/`) is not expanded on Node 22 and
> is treated as a script path, so it errors; use `node --test` or an explicit
> glob (`node --test test/*.test.js`).

The full JS suite is **315 tests** (292 conformance assertions + 23 unit ports),
exit 0.

## The conformance corpus (the actual deliverable)

The corpus lives under [`conformance/`](conformance) and is shared with the Python
reference. **276 vectors** across two tiers:

| category | spec | gen | covers |
|----------|-----:|----:|--------|
| hash     | 10   | 14  | §8 ASCII normalization + SHA-256 + truncation (incl. NBSP kept) |
| markers  | 9    | 12  | §3/§4 grammar, malformed, positional-id (no rescue), uppercase-hex |
| parse    | 5    | 9   | §5 blank-line segmentation + marker attachment |
| lint     | 7    | 8   | §7/§8/§10 findings (ordered) |
| diff     | 6    | 6   | §11 regeneration diff (ordered) |
| seqmatch | 9    | 143 | raw Ratcliff/Obershelp ratio + matching blocks |
| score    | 12   | 17  | §9 wrappers: body score, context bonus, best match, ASCII fold |
| resolve  | 4    | 5   | §9.1 ladder + margin guard |
| **total**| **62** | **214** | |

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
- **Positional id (§4):** the id is the first token after `stay:` (`^`-anchored);
  a marker whose first token is a bare `k=v` is malformed even if a later
  `stay:ID` appears in the body, matching the Python reference's `ID_RE.match`.

## License

MIT
