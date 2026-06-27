import { AccountState } from "../models/AccountState.js";
import { positionManager } from "./positionManager.js";
import { logger } from "../utils/logger.js";

const INTERVAL_MS = 2_000;

let timer: NodeJS.Timeout | undefined;

/**
 * Periodically broadcasts each user's portfolio snapshot so the UI keeps
 * showing fresh unrealised P&L while positions are open and idle.
 */
export function startPortfolioBroadcaster() {
  if (timer) return;
  timer = setInterval(async () => {
    try {
      const states = await AccountState.find().select("userId").lean();
      for (const s of states) {
        await positionManager.broadcastPortfolio(String(s.userId));
      }
    } catch (err) {
      logger.warn("portfolio broadcast failed", { err: (err as Error).message });
    }
  }, INTERVAL_MS);
  logger.info("PortfolioBroadcaster started", { intervalMs: INTERVAL_MS });
}

export function stopPortfolioBroadcaster() {
  if (timer) clearInterval(timer);
  timer = undefined;
}
