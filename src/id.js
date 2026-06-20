// Opaque id generation (SPEC.md §6). The reference write path mints "a short
// opaque generated id, not derived from the block text," so a rewriting model has
// nothing to "improve." Generation is the only randomness in the core; every
// write helper funnels its minting through an injectable factory so the
// conformance/unit tests stay deterministic.

import { randomBytes } from "node:crypto";

// Default id alphabet: base62, a strict subset of the §6 id charset
// [A-Za-z0-9_-]. `_` and `-` are legal in authored ids but omitted from
// *generated* ids so a minted id never begins with `-` (which reads as a CLI
// flag) and never collides with the marker delimiters.
export const DEFAULT_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

// 8 base62 chars ≈ 47.6 bits: ample collision resistance for per-document
// coverage without the token weight of a UUID (§6 calls UUIDs too heavy).
export const DEFAULT_ID_LENGTH = 8;

// The §6 id grammar: one or more of [A-Za-z0-9_-].
export const ID_CHARSET = /^[A-Za-z0-9_-]+$/;

/**
 * Mint one opaque id (SPEC.md §6). Options:
 *   length    id length in characters (default 8)
 *   alphabet  characters to draw from (default base62)
 *   random    `n => Uint8Array`-like byte source (default crypto.randomBytes);
 *             injectable so write helpers can be made deterministic in tests.
 *
 * Bytes are drawn with rejection sampling so the alphabet is unbiased even when
 * its length does not divide 256.
 */
export function mintId(opts = {}) {
  const {
    length = DEFAULT_ID_LENGTH,
    alphabet = DEFAULT_ALPHABET,
    random = randomBytes,
  } = opts;
  if (!Number.isInteger(length) || length < 1) {
    throw new Error(`mintId: length must be a positive integer, got ${length}`);
  }
  const n = alphabet.length;
  if (n < 2) throw new Error("mintId: alphabet needs at least 2 characters");
  const limit = 256 - (256 % n); // largest unbiased byte threshold
  let out = "";
  while (out.length < length) {
    const buf = random(length - out.length);
    for (let i = 0; i < buf.length && out.length < length; i++) {
      const b = buf[i];
      if (b < limit) out += alphabet[b % n];
    }
  }
  return out;
}
