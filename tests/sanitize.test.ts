import assert from "node:assert/strict";
import test from "node:test";
import { isCredentialKey, REDACTED, sanitizeProviderPayload } from "../src/sanitize.ts";

test("redacts obvious credential field names", () => {
  for (const key of [
    "authorization",
    "Authorization",
    "apiKey",
    "api_key",
    "api-key",
    "x-api-key",
    "access_token",
    "refresh_token",
    "password",
    "passwd",
    "pwd",
    "secret",
    "client_secret",
    "client-secret",
    "credential-metadata",
    "credentials",
    "bearer",
    "auth_token",
    "id_token",
    "oauth_token",
    "session_token",
    "csrf_token",
  ]) {
    assert.equal(isCredentialKey(key), true, `expected ${key} to be credential`);
  }
});

test("does not redact ordinary keys or natural-language tokens", () => {
  for (const key of ["message", "text", "content", "author", "token", "max_tokens"]) {
    assert.equal(isCredentialKey(key), false, `expected ${key} to be safe`);
  }
  const payload = {
    messages: [
      { role: "user", content: "use a token to continue; token is fine here" },
    ],
    max_tokens: 1000,
    temperature: 0.5,
  };
  assert.deepEqual(sanitizeProviderPayload(payload), payload);
});

test("redacts nested credential-metadata token", () => {
  const payload = {
    credentialMetadata: { token: "abc" },
    credential: { token: "def" },
    auth: { token: "ghi" },
  };
  const sanitized = sanitizeProviderPayload(payload) as Record<string, unknown>;
  // credential-ish keys are redacted wholesale (subtree removed).
  assert.equal(sanitized.credentialMetadata, REDACTED);
  // containers that merely establish a sensitive context keep shape, inner token redacted.
  assert.deepEqual(sanitized.credential, { token: REDACTED });
  assert.deepEqual(sanitized.auth, { token: REDACTED });
});

test("keeps exact token key outside credential context", () => {
  const payload = { token: "abc", info: { token: "def" } };
  assert.deepEqual(sanitizeProviderPayload(payload), payload);
});

test("redacts nested credentials anywhere in the tree", () => {
  const payload = {
    level1: {
      level2: [{ level3: { apiKey: "sk-123", access_token: "t-1" } }],
    },
  };
  const sanitized = sanitizeProviderPayload(payload) as Record<string, unknown>;
  const level2 = (sanitized.level1 as Record<string, unknown>).level2 as unknown[];
  const inner = level2[0] as { level3: Record<string, unknown> };
  assert.equal(inner.level3.apiKey, REDACTED);
  assert.equal(inner.level3.access_token, REDACTED);
});

test("sanitize returns a new object and never mutates input", () => {
  const payload = { apiKey: "sk-1", items: [{ n: 1 }] };
  const sanitized = sanitizeProviderPayload(payload) as Record<string, unknown>;
  assert.notEqual(sanitized, payload);
  assert.notEqual(sanitized.items, payload.items);
  assert.equal(payload.apiKey, "sk-1"); // input untouched
});

test("cycles do not crash sanitize", () => {
  const payload: Record<string, unknown> = { apiKey: "sk-1" };
  payload.self = payload;
  const sanitized = sanitizeProviderPayload(payload) as Record<string, unknown>;
  assert.equal(sanitized.apiKey, REDACTED);
  assert.ok("self" in sanitized);
});

test("arrays of primitives pass through unchanged", () => {
  const payload = { list: [1, "two", true, null, { k: "v" }] };
  assert.deepEqual(sanitizeProviderPayload(payload), payload);
});

test("primitive payloads are returned as-is", () => {
  assert.equal(sanitizeProviderPayload("hi"), "hi");
  assert.equal(sanitizeProviderPayload(42), 42);
  assert.equal(sanitizeProviderPayload(null), null);
  assert.equal(sanitizeProviderPayload(undefined), undefined);
});

test("provider-envelope style keys without credentials survive", () => {
  const payload = { provider: "anthropic", model: "claude", temperature: 1 };
  assert.deepEqual(sanitizeProviderPayload(payload), payload);
});
