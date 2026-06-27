// Subscribes to bus events of interest and forwards them to the
// out-of-app notifier (webhook + email). The notifier is a no-op when
// no channels are configured, so this is safe to start unconditionally.

import { bus } from "./eventBus.js";
import { notify } from "./notifier.js";
import { logger } from "../utils/logger.js";

export function startNotifierBridge() {
  bus.on("position", (ev) => {
    if (ev.status === "CLOSED") {
      void notify({
        title: `${ev.symbol} ${ev.side} closed`,
        body: `Exit ${ev.exitPrice ?? "—"} · P&L ₹${(ev.realisedPnl ?? 0).toFixed(0)} (${ev.exitReason ?? "MANUAL"})`,
        level: (ev.realisedPnl ?? 0) >= 0 ? "success" : "warn",
        context: { positionId: ev.positionId, userId: ev.userId },
      });
    }
  });

  bus.on("paper", (env) => {
    const ev = env.event;
    if (ev.kind === "sl_hit") {
      void notify({
        title: `Paper: SL hit on ${ev.symbol}`,
        body: `Closed @ ₹${ev.exitPrice.toFixed(2)} · loss ₹${ev.loss.toFixed(0)}`,
        level: "error",
        context: { userId: env.userId, positionId: ev.positionId },
      });
    } else if (ev.kind === "tp_hit") {
      void notify({
        title: `Paper: Target hit on ${ev.symbol}`,
        body: `Closed @ ₹${ev.exitPrice.toFixed(2)} · profit ₹${ev.profit.toFixed(0)}`,
        level: "success",
        context: { userId: env.userId, positionId: ev.positionId },
      });
    } else if (ev.kind === "squareoff_warning") {
      void notify({
        title: `Auto-squareoff in ${ev.minutesLeft} min`,
        body: `${ev.openMis} MIS paper positions will be auto-closed.`,
        level: "warn",
        context: { userId: env.userId },
      });
    }
  });

  logger.info("notifier bridge started");
}
