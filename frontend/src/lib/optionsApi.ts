import { api } from "./api";

export interface StrikeSide {
  ltp: number;
  bid: number;
  ask: number;
  oi: number;
  volume: number;
  iv: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  rho: number;
}

export interface StrikeRow {
  strike: number;
  ce?: StrikeSide;
  pe?: StrikeSide;
}

export interface ChainExpiry {
  expiry: string;
  days_to_expiry: number;
  rows: StrikeRow[];
  pcr: number;
  max_pain: number | null;
  iv_avg: number | null;
  unusual_oi_strikes: number[];
}

export interface OptionsChain {
  symbol: string;
  underlying: number;
  fetched_at: number;
  expiries: ChainExpiry[];
}

export interface GreeksResponse {
  symbol: string;
  expiry: string;
  strike: number;
  kind: "CE" | "PE";
  iv: number | null;
  iv_percentile: number | null;
  underlying: number;
  price: number;
  greeks: { delta: number; gamma: number; theta: number; vega: number; rho: number };
}

export const optionsApi = {
  chain: (symbol: string) =>
    api.get<OptionsChain>(`/api/options/chain/${encodeURIComponent(symbol)}`).then((r) => r.data),
  greeks: (symbol: string, expiry: string, strike: number, kind: "CE" | "PE") =>
    api
      .get<GreeksResponse>(`/api/options/greeks/${encodeURIComponent(symbol)}/${expiry}/${strike}/${kind}`)
      .then((r) => r.data),
};
