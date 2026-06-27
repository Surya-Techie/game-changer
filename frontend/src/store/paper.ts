// Paper-trading Zustand store. Holds the *active* account id (so all
// subsequent fetches scope to it), the latest portfolio summary (so
// the account bar can update from WS events without re-fetching), and
// optional one-shot prefill payload set by the AI signal "Paper Trade
// This" button.

import { create } from "zustand";
import type { Portfolio, PaperAccount } from "../lib/paperApi";

export interface OrderPrefill {
  symbol?: string;
  side?: "BUY" | "SELL";
  qty?: number;
  stopLoss?: number;
  takeProfit?: number;
  strategyTag?: string;
}

interface PaperState {
  activeAccountId: string | null;
  accounts: PaperAccount[];
  portfolio: Portfolio | null;
  prefill: OrderPrefill | null;
  setActiveAccount: (id: string) => void;
  setAccounts: (a: PaperAccount[]) => void;
  setPortfolio: (p: Portfolio | null) => void;
  setPrefill: (p: OrderPrefill | null) => void;
}

export const usePaper = create<PaperState>((set) => ({
  activeAccountId: null,
  accounts: [],
  portfolio: null,
  prefill: null,
  setActiveAccount: (id) => set({ activeAccountId: id }),
  setAccounts: (a) => set({ accounts: a }),
  setPortfolio: (p) => set({ portfolio: p }),
  setPrefill: (p) => set({ prefill: p }),
}));
