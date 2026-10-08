// Data access for the local API (same origin; the HotCRP token never reaches
// the browser). TanStack Query hooks, one per route.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AcsResponse,
  LeadDetailResponse,
  LeadsResponse,
  MetaResponse,
  OverviewResponse,
  PaperDetail,
  PersonResponse,
  QuickRejectResponse,
  ReserveResponse,
  ReviewersResponse,
  SyncStatus,
  TriageResponse,
} from "@pcs/server/server/api-types";

import type {
  ActionsInfo,
  NudgeResponse,
  TagCommitRequest,
  TagCommitResponse,
  TagPreviewRequest,
  TagPreviewResponse,
} from "@pcs/server/server/action-types";

export type * from "@pcs/server/server/api-types";
export type * from "@pcs/server/server/action-types";
export type * from "@pcs/server/server/assignment-types";
import type { AssignmentResponse, SolveResponse } from "@pcs/server/server/assignment-types";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
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
  acs: ["acs"] as const,
  leads: ["leads"] as const,
  lead: (email: string) => ["lead", email] as const,
  reviewers: ["reviewers"] as const,
  person: (email: string) => ["person", email] as const,
  overview: ["overview"] as const,
  reserve: ["reserve"] as const,
  quickreject: ["quickreject"] as const,
  assignment: (source: "hotcrp" | "tpms") => ["assignment", source] as const,
  solve: ["solve"] as const,
  actions: ["actions"] as const,
  nudge: (pid: number) => ["nudge", pid] as const,
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

export function useAcs() {
  return useQuery({ queryKey: keys.acs, queryFn: () => getJson<AcsResponse>("/api/acs") });
}

export function useLeads() {
  return useQuery({ queryKey: keys.leads, queryFn: () => getJson<LeadsResponse>("/api/leads") });
}

export function useLead(email: string) {
  return useQuery({ queryKey: keys.lead(email), queryFn: () => getJson<LeadDetailResponse>(`/api/leads/${encodeURIComponent(email)}`), retry: false });
}

export const leadPath = (email: string) => `/leads/${encodeURIComponent(email)}`;

export function useReviewers() {
  return useQuery({ queryKey: keys.reviewers, queryFn: () => getJson<ReviewersResponse>("/api/reviewers") });
}

export function usePerson(email: string) {
  return useQuery({
    queryKey: keys.person(email),
    queryFn: () => getJson<PersonResponse>(`/api/people/${encodeURIComponent(email)}`),
  });
}

export function useOverview() {
  return useQuery({ queryKey: keys.overview, queryFn: () => getJson<OverviewResponse>("/api/overview") });
}

// Phase-2 modules (PLAN M11). /api/reserve may fill in DBLP hints in the
// background, so it refetches while lookups are pending.
export function useReserve() {
  return useQuery({
    queryKey: keys.reserve,
    queryFn: () => getJson<ReserveResponse>("/api/reserve"),
    refetchInterval: (q) => ((q.state.data?.dblp.pending ?? 0) > 0 ? 5_000 : false),
  });
}

export function useQuickReject() {
  return useQuery({ queryKey: keys.quickreject, queryFn: () => getJson<QuickRejectResponse>("/api/quickreject") });
}

// Assignment validator and solver (PLAN M10/M10b).
export function useAssignment(source: "hotcrp" | "tpms") {
  return useQuery({ queryKey: keys.assignment(source), queryFn: () => getJson<AssignmentResponse>(`/api/assignment${source === "tpms" ? "?source=tpms" : ""}`), retry: false });
}

/** The last cached solve (null report until one has run). */
export function useSolve() {
  return useQuery({ queryKey: keys.solve, queryFn: () => getJson<SolveResponse>("/api/assignment/solve") });
}

/** Run the solver (HotCRP reads only); the response replaces the cached report. */
export function useRunSolve() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: { hard: boolean }) =>
      getJson<SolveResponse>("/api/assignment/solve", { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(req) }),
    onSuccess: (d) => qc.setQueryData(keys.solve, d),
  });
}

/** In-app path of a person page. */
export const personPath = (email: string) => `/people/${encodeURIComponent(email)}`;

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

// ---------------------------------------------------------------------------
// v1 actions (PLAN M8)

export function useActions() {
  return useQuery({ queryKey: keys.actions, queryFn: () => getJson<ActionsInfo>("/api/actions") });
}

/** A nudge draft for one paper; fetched only when asked for. */
export function useNudge(pid: number, enabled: boolean) {
  return useQuery({ queryKey: keys.nudge(pid), queryFn: () => getJson<NudgeResponse>(`/api/papers/${pid}/nudge`), enabled });
}

const postJson = <T>(url: string, body: unknown) =>
  getJson<T>(url, { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(body) });

/** The HotCRP dry run: what tagging would change, and a single-use token for exactly that. */
export function useTagPreview() {
  return useMutation({ mutationFn: (req: TagPreviewRequest) => postJson<TagPreviewResponse>("/api/tags/preview", req) });
}

/** The confirmed write. The server re-syncs afterwards; polling the sync status picks that up. */
export function useTagCommit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: TagCommitRequest) => postJson<TagCommitResponse>("/api/tags/commit", req),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.sync }),
  });
}
