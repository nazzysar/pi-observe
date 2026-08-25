/**
 * P0.1 — Credential redaction for provider payloads.
 *
 * Key-name based, so ordinary natural-language occurrences of "token"
 * in message text are never touched. Values are never scanned.
 *
 * Rules:
 * - Keys matching obvious credential field names are always redacted
 *   (authorization, apiKey, api_key, access_token, refresh_token,
 *   password, secret, credential-metadata, credentials, ...).
 * - The exact key "token" is redacted only when it sits inside a
 *   credential-ish subtree (e.g. `credential-metadata.token`).
 * - Everything else — including "max_tokens" and any "token" wording
 *   in text values — passes through unchanged.
 */

export const REDACTED = "[REDACTED]";

/** Always-redact key patterns (word-bounded so "author" ≠ "authorization"). */
const ALWAYS_PATTERNS: RegExp[] = [
  /^authorization$/i,
  /^proxy-authorization$/i,
  /^api[-_]?key$/i,
  /^x-api[-_]?key$/i,
  /^access[-_]?token$/i,
  /^refresh[-_]?token$/i,
  /^id[-_]?token$/i,
  /^oauth[-_]?token$/i,
  /^session[-_]?token$/i,
  /^auth[-_]?token$/i,
  /^csrf[-_]?token$/i,
  /^client[-_]?secret$/i,
  /^secret$/i,
  /^password$/i,
  /^passwd$/i,
  /^pwd$/i,
  /^credential[-_]?metadata$/i,
  /^credentials$/i,
  /^bearer$/i,
];

/** Keys that mark a subtree as credential-ish for the conditional "token" rule. */
const SENSITIVE_CONTEXT_PATTERN = /credential|secret|auth|bearer|oauth|token/i;

const EXACT_TOKEN = /^token$/i;

/**
 * Decide whether `key` (optionally under a credential-ish subtree,
 * tracked via `inSensitiveContext`) must be redacted.
 */
export function isCredentialKey(
  key: string,
  inSensitiveContext = false,
): boolean {
  if (ALWAYS_PATTERNS.some((p) => p.test(key))) return true;
  if (EXACT_TOKEN.test(key) && inSensitiveContext) return true;
  return false;
}

/** Deep-redact credential fields in a provider payload. Cycle-safe. */
export function sanitizeProviderPayload(value: unknown): unknown {
  const seen = new WeakSet<object>();

  const walk = (node: unknown, inSensitiveContext: boolean): unknown => {
    if (node === null || typeof node !== "object") return node;
    if (seen.has(node)) return REDACTED;
    seen.add(node);

    if (Array.isArray(node)) {
      return node.map((item) => walk(item, inSensitiveContext));
    }

    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(node as Record<string, unknown>)) {
      const keySensitive = isCredentialKey(key, inSensitiveContext);
      out[key] = keySensitive
        ? REDACTED
        : walk(item, inSensitiveContext || SENSITIVE_CONTEXT_PATTERN.test(key));
    }
    return out;
  };

  return walk(value, false);
}
