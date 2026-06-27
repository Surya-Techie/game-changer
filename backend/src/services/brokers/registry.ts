// Single dispatcher used by the auto-trader and the /api/broker routes.
// Picks the active adapter from BROKER_MODE. Adapters are singletons so
// switching mode at runtime is not supported (BROKER_MODE is read once
// at startup) — this is intentional, since flipping live broker keys on
// the fly would be a footgun.

import { env } from "../../config/env.js";
import { mockAdapter } from "./mockAdapter.js";
import { kiteAdapter } from "./kiteAdapter.js";
import type { IBrokerAdapter } from "./IBrokerAdapter.js";

let active: IBrokerAdapter;

if (env.brokerMode === "kite") {
  active = kiteAdapter;
} else {
  active = mockAdapter;
}

export function broker(): IBrokerAdapter {
  return active;
}

export function brokerMode(): "mock" | "kite" {
  return active.mode;
}

/** Helper for routes that want the Kite-specific login URL. Returns
 * empty string when not in kite mode or when KITE_API_KEY is missing. */
export function kiteLoginUrl(): string {
  if (active.mode !== "kite") return "";
  return kiteAdapter.loginUrl();
}
