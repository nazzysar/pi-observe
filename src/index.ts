/**
 * P0.1 — Observation Core extension entry point.
 *
 * Passive observability only: no tools, no prompt text, no message
 * injection, no payload replacement. Load this extension last so the
 * payload it observes is the payload Pi actually sends (see README).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installObserver } from "./recorder.ts";
import { SessionStore } from "./store.ts";

const DEFAULT_MAX_REQUESTS = 100;

function readMaxRequests(): number {
  const raw = process.env.PI_OBSERVE_MAX_REQUESTS;
  if (!raw) return DEFAULT_MAX_REQUESTS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_REQUESTS;
}

export default function (pi: ExtensionAPI): void {
  const store = new SessionStore({ maxRequests: readMaxRequests() });
  installObserver(pi, { store });
}
