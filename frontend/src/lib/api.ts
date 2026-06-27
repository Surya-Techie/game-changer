import axios, { AxiosError } from "axios";

export const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";
export const WS_URL = import.meta.env.VITE_WS_URL ?? "ws://localhost:4000/ws";

export const api = axios.create({
  baseURL: API_URL,
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem("qti.token");
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// Lightweight pub/sub for "backend unreachable" UX. The interceptor sets
// a global flag whenever any request fails with a transport-level error
// (the backend isn't running, network is down, CORS is blocking, etc.).
// Components can subscribe via `useBackendStatus()` to render a banner
// instead of throwing console errors users can't act on.

type BackendStatus = "ok" | "offline";
const listeners = new Set<(s: BackendStatus) => void>();
let currentStatus: BackendStatus = "ok";

export function subscribeBackendStatus(fn: (s: BackendStatus) => void): () => void {
  listeners.add(fn);
  fn(currentStatus);
  return () => listeners.delete(fn);
}

function setStatus(next: BackendStatus) {
  if (next === currentStatus) return;
  currentStatus = next;
  for (const fn of listeners) fn(next);
}

function isNetworkError(err: AxiosError | unknown): boolean {
  if (!axios.isAxiosError(err)) return false;
  // Axios uses `code: 'ERR_NETWORK'` for transport-level failures (refused,
  // CORS, DNS, offline). No response object is attached in those cases.
  return err.code === "ERR_NETWORK" || (err.message?.includes("Network Error") && !err.response);
}

api.interceptors.response.use(
  (r) => {
    setStatus("ok");
    return r;
  },
  (err) => {
    if (err?.response?.status === 401) {
      // Login/logout are disabled for now — drop any stale token but don't
      // redirect (the /login route no longer exists). Protected endpoints
      // simply fail and their panels render their own empty/error state.
      localStorage.removeItem("qti.token");
    } else if (isNetworkError(err)) {
      setStatus("offline");
    } else {
      // Any response (even 5xx) means the backend is reachable.
      setStatus("ok");
    }
    return Promise.reject(err);
  }
);

export interface StockItem {
  symbol: string;
  name: string;
  base: string;
  exchange: string;
  sector: string;
}

export async function fetchAllStocks(): Promise<StockItem[]> {
  const { data } = await api.get<StockItem[]>("/api/market/all-stocks");
  return data;
}
