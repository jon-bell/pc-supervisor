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
  PaperSearchResponse,
  SearchCompletionsResponse,
} from "@pcs/server/server/api-types";
import { useLocation } from "./router";

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

/**
 * The in-app paper filter (?search=, a HotCRP search, and ?t=, its "Search
 * in" collection; router STICKY_PARAMS). Paper-centric hooks pass it to the
 * server, which evaluates only the matching papers. Both "" = no filter;
 * t "" = HotCRP's default collection.
 */
export interface PaperFilterState {
  search: string;
  t: string;
}

export function usePaperSearch(): PaperFilterState {
  const q = useLocation().query;
  return { search: (q.get("search") ?? "").trim(), t: (q.get("t") ?? "").trim() };
}

export const isFilterOn = (f: PaperFilterState) => f.search !== "" || f.t !== "";

/** `url` with ?search= and ?t= added when set. */
export function withSearch(url: string, f: PaperFilterState): string {
  const q = new URLSearchParams();
  if (f.search) q.set("search", f.search);
  if (f.t) q.set("t", f.t);
  const s = q.toString();
  return s ? `${url}${url.includes("?") ? "&" : "?"}${s}` : url;
}

export const keys = {
  meta: ["meta"] as const,
  triage: (f: TriageFilters, search: PaperFilterState = { search: "", t: "" }) => ["triage", f.ac ?? "", f.rule ?? "", f.tier ?? "", search.search, search.t] as const,
  paperSearch: (f: PaperFilterState) => ["paper-search", f.search, f.t] as const,
  searchCompletions: ["search-completions"] as const,
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
  const search = usePaperSearch();
  return useQuery({
    queryKey: keys.triage(f, search),
    queryFn: () => getJson<TriageResponse>(withSearch(triageUrl(f), search)),
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
  const search = usePaperSearch();
  return useQuery({ queryKey: [...keys.acs, search.search, search.t], queryFn: () => getJson<AcsResponse>(withSearch("/api/acs", search)) });
}

export function useLeads() {
  const search = usePaperSearch();
  return useQuery({ queryKey: [...keys.leads, search.search, search.t], queryFn: () => getJson<LeadsResponse>(withSearch("/api/leads", search)) });
}

export function useLead(email: string) {
  const search = usePaperSearch();
  return useQuery({
    queryKey: [...keys.lead(email), search.search, search.t],
    queryFn: () => getJson<LeadDetailResponse>(withSearch(`/api/leads/${encodeURIComponent(email)}`, search)),
    retry: false,
  });
}

export const leadPath = (email: string) => `/leads/${encodeURIComponent(email)}`;

export function useReviewers() {
  const search = usePaperSearch();
  return useQuery({ queryKey: [...keys.reviewers, search.search, search.t], queryFn: () => getJson<ReviewersResponse>(withSearch("/api/reviewers", search)) });
}

export function usePerson(email: string) {
  const search = usePaperSearch();
  return useQuery({
    queryKey: [...keys.person(email), search.search, search.t],
    queryFn: () => getJson<PersonResponse>(withSearch(`/api/people/${encodeURIComponent(email)}`, search)),
  });
}

export function useOverview() {
  const search = usePaperSearch();
  return useQuery({ queryKey: [...keys.overview, search.search, search.t], queryFn: () => getJson<OverviewResponse>(withSearch("/api/overview", search)) });
}

/** The filter box's status line: what a search matches (no request without a filter). */
export function usePaperSearchInfo(f: PaperFilterState) {
  return useQuery({
    queryKey: keys.paperSearch(f),
    queryFn: () => getJson<PaperSearchResponse>(withSearch("/api/paper-search", f)),
    enabled: isFilterOn(f),
    retry: false,
  });
}

/** The filter box's autocomplete data and "Search in" collections (one cached request, kept a minute). */
export function useSearchCompletions(enabled: boolean) {
  return useQuery({
    queryKey: keys.searchCompletions,
    queryFn: () => getJson<SearchCompletionsResponse>("/api/search-completions"),
    enabled,
    staleTime: 60_000,
    retry: false,
  });
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
