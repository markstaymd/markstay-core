// Shared ASCII whitespace + ASCII case-fold helpers.
//
// SPEC.md pins hash normalization (§8), block segmentation (§5), and §9 matching
// normalization to ASCII whitespace and ASCII-only case folding, so a second
// implementation reproduces hashing and recovery exactly without a Unicode
// whitespace set or case-fold table (SPEC_DECISIONS.md). One definition here,
// used by hash/segment/parse/quote, mirrors the Python reference's
// `rstrip(" \t\f\v")`, `strip(" \t\f\v")`, and the §9 `normalize` ASCII rules.

// Trailing ASCII whitespace within a single line (no newlines): space, tab,
// form feed, vertical tab. Mirrors Python `ln.rstrip(" \t\f\v")`.
export const ASCII_TRAILING_WS = /[ \t\f\v]+$/;

// A line that is empty or only ASCII whitespace (SPEC.md §5 blank line).
const ASCII_BLANK_LINE = /^[ \t\f\v]*$/;

// ASCII whitespace at either end / in runs (includes \n\r for multi-line input).
const ASCII_TRIM = /^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g;
const ASCII_WS_RUN = /[ \t\n\r\f\v]+/g;

export const isAsciiBlankLine = (ln) => ASCII_BLANK_LINE.test(ln);
export const asciiTrim = (s) => s.replace(ASCII_TRIM, "");
export const asciiCollapse = (s) => s.replace(ASCII_WS_RUN, " ");
export const asciiLower = (s) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
