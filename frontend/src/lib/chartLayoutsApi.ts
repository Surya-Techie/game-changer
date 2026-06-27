import { api } from "./api";
import type { DrawingShape } from "../components/ChartDrawings/types";

export interface ChartLayoutDoc {
  _id: string;
  symbol: string;
  name: string;
  data: { drawings: DrawingShape[]; overlays?: string[] };
  updatedAt?: string;
}

export const chartLayoutsApi = {
  list: (symbol: string) =>
    api
      .get<{ layouts: ChartLayoutDoc[] }>("/api/chart-layouts", { params: { symbol } })
      .then((r) => r.data.layouts),
  save: (symbol: string, name: string, data: ChartLayoutDoc["data"]) =>
    api
      .post<{ layout: ChartLayoutDoc }>("/api/chart-layouts", { symbol, name, data })
      .then((r) => r.data.layout),
  remove: (id: string) =>
    api.delete<{ ok: boolean }>(`/api/chart-layouts/${id}`).then((r) => r.data),
};
