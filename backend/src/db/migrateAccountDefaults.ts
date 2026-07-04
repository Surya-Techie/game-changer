import { AccountState } from "../models/AccountState.js";
import { logger } from "../utils/logger.js";

/**
 * One-time default upgrade for existing AccountState docs.
 *
 * The regime filter shipped OFF (ADX 18) originally; real-data sweeps showed
 * filtering ADX<20 chop measurably improves signal quality. We only upgrade
 * docs still carrying the exact old default pair — anyone who deliberately
 * changed either value is left untouched.
 */
export async function migrateAccountDefaults(): Promise<void> {
  try {
    const res = await AccountState.updateMany(
      { regimeFilterEnabled: false, regimeMinAdx: 18 },
      { $set: { regimeFilterEnabled: true, regimeMinAdx: 25 } }
    );
    if (res.modifiedCount > 0) {
      logger.info("AccountState defaults migrated (regime filter ON, ADX 25)", {
        modified: res.modifiedCount,
      });
    }

    // Exit-management upgrade (measured: 1R target + partial TP at 1R wins
    // ~72% of trades with positive net expectancy vs ~40% at the old 2:1).
    // Only docs still on the exact old default pair are touched.
    const exits = await AccountState.updateMany(
      { targetRR: 2.0, partialTpEnabled: false },
      { $set: { targetRR: 1.0, partialTpEnabled: true } }
    );
    if (exits.modifiedCount > 0) {
      logger.info("AccountState exit defaults migrated (targetRR 1.0, partial TP ON)", {
        modified: exits.modifiedCount,
      });
    }
  } catch (err) {
    logger.warn("AccountState default migration failed (continuing)", {
      err: (err as Error).message,
    });
  }
}
