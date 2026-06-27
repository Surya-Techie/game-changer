// Cross-user paper-trading leaderboard. MVP: ranks every active paper
// account by % return since either (a) a user-supplied "since" date or
// (b) the account's last reset / creation, whichever is later.
//
// Sourced entirely from existing PaperAccount + PaperTrade collections —
// no separate monthly-challenge model. The frontend can pin "this
// month" by passing since = first-day-of-month, which is the spec's
// "monthly challenge" framing without locking us into a calendar.

import { PaperAccount } from "../../models/PaperAccount.js";
import { PaperTrade } from "../../models/PaperTrade.js";
import { User } from "../../models/User.js";

export interface LeaderboardRow {
  userId: string;
  displayName: string;
  accountId: string;
  accountName: string;
  startingCapital: number;
  netPnl: number;
  returnPct: number;
  trades: number;
  winRate: number;
  maxDrawdownPct: number;
  rank: number;
  isYou?: boolean;
}

interface BuildOptions {
  since?: Date;
  limit?: number;
  meUserId?: string;
}

export async function buildLeaderboard(opts: BuildOptions = {}): Promise<LeaderboardRow[]> {
  const since = opts.since ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const limit = Math.min(100, opts.limit ?? 50);

  const accounts = await PaperAccount.find().lean();
  if (accounts.length === 0) return [];

  // Pull all trades for these accounts in one pass, then bucket by account.
  const accountIds = accounts.map((a) => a._id);
  const trades = await PaperTrade.find({
    accountId: { $in: accountIds },
    exitTime: { $gte: since },
  }).lean();
  const tradesByAccount = new Map<string, typeof trades>();
  for (const t of trades) {
    const k = String(t.accountId);
    const list = tradesByAccount.get(k) ?? [];
    list.push(t);
    tradesByAccount.set(k, list);
  }

  // Resolve user display names in one shot.
  const userIds = Array.from(new Set(accounts.map((a) => String(a.userId))));
  const users = await User.find({ _id: { $in: userIds } }).select("email name").lean();
  const nameOf = new Map<string, string>();
  for (const u of users) {
    const display = (u.name as string | undefined) || maskEmail((u.email as string | undefined) ?? "");
    nameOf.set(String(u._id), display);
  }

  const rows: LeaderboardRow[] = accounts
    .map((a) => {
      const aId = String(a._id);
      const ts = tradesByAccount.get(aId) ?? [];
      const netPnl = ts.reduce((s, t) => s + t.netPnl, 0);
      const wins = ts.filter((t) => t.netPnl > 0).length;
      const winRate = ts.length ? (wins / ts.length) * 100 : 0;
      const returnPct = (netPnl / a.startingCapital) * 100;

      // Max drawdown: walk the equity curve.
      let peak = a.startingCapital;
      let eq = a.startingCapital;
      let dd = 0;
      for (const t of [...ts].sort((x, y) => new Date(x.exitTime).getTime() - new Date(y.exitTime).getTime())) {
        eq += t.netPnl;
        if (eq > peak) peak = eq;
        const cur = peak > 0 ? ((peak - eq) / peak) * 100 : 0;
        if (cur > dd) dd = cur;
      }

      return {
        userId: String(a.userId),
        displayName: nameOf.get(String(a.userId)) ?? "anon",
        accountId: aId,
        accountName: a.name,
        startingCapital: a.startingCapital,
        netPnl: round2(netPnl),
        returnPct: round2(returnPct),
        trades: ts.length,
        winRate: round2(winRate),
        maxDrawdownPct: round2(dd),
        rank: 0,
        isYou: opts.meUserId ? String(a.userId) === opts.meUserId : undefined,
      };
    })
    .filter((r) => r.trades > 0) // hide untouched accounts
    .sort((a, b) => b.returnPct - a.returnPct)
    .slice(0, limit);

  rows.forEach((r, i) => { r.rank = i + 1; });
  return rows;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function maskEmail(email: string): string {
  if (!email.includes("@")) return email || "anon";
  const [local, domain] = email.split("@");
  if (local.length <= 2) return `${local[0]}*@${domain}`;
  return `${local[0]}${local[1]}***@${domain}`;
}
