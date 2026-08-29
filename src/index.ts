/**
 * P0.1 — Observation Core extension entry point.
 *
 * Passive observability only: no tools, no prompt text, no message
 * injection, no payload replacement. Load this extension last so the
 * payload it observes is the payload Pi actually sends (see README).
 *
 * P0.3 — adds the local /inspect command (UI only; no LLM interaction).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DiffService } from "./diff/request-diff.ts";
import { installObserver } from "./recorder.ts";
import { SessionStore } from "./store.ts";
import { registerInspectCommand } from "./ui/inspect.ts";

const DEFAULT_MAX_REQUESTS = 100;

function readMaxRequests(): number {
  const raw = process.env.PI_OBSERVE_MAX_REQUESTS;
  if (!raw) return DEFAULT_MAX_REQUESTS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_REQUESTS;
}

export default function (pi: ExtensionAPI): void {
  const store = new SessionStore({ maxRequests: readMaxRequests() });
  // P0.3: local request inspector. Registers no tools, sends no messages,
  // and only ever reads store state when the user invokes /inspect.
  // P1: DiffService derives request diffs lazily from immutable records;
  // it never participates in capture.
  const diffService = new DiffService();
  // The diff cache is keyed by request seq only; on session reset the
  // seq counter restarts at 1, so the cache must be dropped or a new
  // session would be served diffs from the previous session's records.
  installObserver(pi, { store, onReset: () => diffService.clear() });
  registerInspectCommand(pi, store, { diffService });
}
