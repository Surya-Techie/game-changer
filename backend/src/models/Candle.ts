export interface Candle {
  symbol: string;
  t: number; // candle open epoch ms
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}
