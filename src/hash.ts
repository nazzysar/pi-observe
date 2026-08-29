/**
 * P1 — Hashing helpers. SHA-256 (built-in node:crypto) over text or over
 * the canonical form of an arbitrary value. Hashes are internal comparison
 * keys for diffing — not security claims and not content addresses.
 */

import { createHash } from "node:crypto";
import { canonicalize } from "./canonicalize.ts";

/** SHA-256 hex digest of a string. */
export function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * SHA-256 hex digest of the canonical form of an arbitrary value.
 * Never throws: a canonicalization failure hashes a fixed placeholder
 * so observation keeps working (such values simply compare equal).
 */
export function hashValue(value: unknown): string {
  try {
    return hashText(canonicalize(value));
  } catch {
    return hashText("~canonicalize-failed");
  }
}

/** Short display form: "sha256:ab31…" (first 4 hex chars + ellipsis). */
export function shortHash(hash: string): string {
  if (typeof hash !== "string" || hash.length === 0) return "?";
  return `sha256:${hash.slice(0, 4)}…`;
}
