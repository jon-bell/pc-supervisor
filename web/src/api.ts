// Data access for the local API (same origin; the HotCRP token never reaches
// the browser). TanStack Query hooks, one per route.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { MetaResponse, PaperDetail, SyncStatus, TriageResponse } from "@pcs/server/server/api-types";

export type * from "@pcs/server/server/api-types";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { headers: { accept: "application/json" }, ...init });
  const body = (await r.json().catch(() => ({}))) as { error?: string };
  if (!r.ok) throw new ApiError(r.status, body.error ?? `${r.status} ${r.statusText}`);
  return body as T;
}

export interface TriageFilters {
  ac?: string;
  rule?: string;
  tier?: string;
}

export function triageUrl(f: TriageFilters): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v) q.set(k, v);
  const s = q.toString();
  return `/api/triage${s ? `?${s}` : ""}`;
}

export const keys = {
  meta: ["meta"] as const,
  triage: (f: TriageFilters) => ["triage", f.ac ?? "", f.rule ?? "", f.tier ?? ""] as const,
  paper: (pid: number) => ["paper", pid] as const,
  sync: ["sync"] as const,
};

export function useMeta() {
  return useQuery({ queryKey: keys.meta, queryFn: () => getJson<MetaResponse>("/api/meta") });
}

export function useTriage(f: TriageFilters) {
  return useQuery({
    queryKey: keys.triage(f),
    queryFn: () => getJson<TriageResponse>(triageUrl(f)),
    placeholderData: (prev) => prev,
  });
}

export function usePaper(pid: number | null) {
  return useQuery({
    queryKey: keys.paper(pid ?? 0),
    queryFn: () => getJson<PaperDetail>(`/api/papers/${pid}`),
    enabled: pid !== null,
  });
}

export function useSyncStatus() {
  return useQuery({
    queryKey: keys.sync,
    queryFn: () => getJson<SyncStatus>("/api/sync/status"),
    // Poll only while a sync runs.
    refetchInterval: (q) => (q.state.data?.running ? 1500 : false),
  });
}

/** "Sync now": POST, then poll status; when it finishes, everything refetches. */
export function useSyncNow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => getJson<SyncStatus>("/api/sync", { method: "POST" }),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.sync }),
  });
}
