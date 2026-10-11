// Data access for the rule settings and flag history (server routes/rules.ts,
// routes/flag-history.ts). Kept apart from api.ts so the two features merge
// cleanly with UI work elsewhere.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  FlagHistoryResponse,
  PaperFlagHistoryResponse,
  RevisionsResponse,
  RulesChangeRequest,
  RulesChangeResponse,
  RulesPreviewResponse,
  RulesResponse,
  RulesRevertRequest,
  SettingValue,
} from "@pcs/server/server/rules-types";
import { ApiError, usePaperSearch, withSearch } from "./api";

export type * from "@pcs/server/server/rules-types";

export const rulesKeys = {
  rules: ["rules"] as const,
  revisions: ["rules", "revisions"] as const,
  preview: (changes: Record<string, SettingValue | null>) => ["rules", "preview", JSON.stringify(changes)] as const,
  flagHistory: (rule: string, search: string, t: string) => ["flag-history", rule, search, t] as const,
  paperFlags: (pid: number) => ["flag-history", "paper", pid] as const,
};

/** Like getJson, but keeps the server's per-key validation errors. */
export class RulesApiError extends ApiError {
  constructor(
    status: number,
    message: string,
    readonly errors: { key: string; error: string }[],
  ) {
    super(status, message);
  }
}

async function send<T>(url: string, method: string, body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method,
    headers: { accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = (await r.json().catch(() => ({}))) as { error?: string; errors?: { key: string; error: string }[] };
  if (!r.ok) throw new RulesApiError(r.status, json.error ?? `${r.status} ${r.statusText}`, json.errors ?? []);
  return json as T;
}

export function useRules() {
  return useQuery({ queryKey: rulesKeys.rules, queryFn: () => send<RulesResponse>("/api/rules", "GET") });
}

export function useRevisions() {
  return useQuery({ queryKey: rulesKeys.revisions, queryFn: () => send<RevisionsResponse>("/api/rules/revisions", "GET") });
}

/** The server's dry run of a draft (no request while the draft is empty). */
export function useRulesPreview(changes: Record<string, SettingValue | null>) {
  return useQuery({
    queryKey: rulesKeys.preview(changes),
    queryFn: () => send<RulesPreviewResponse>("/api/rules/preview", "POST", { changes }),
    enabled: Object.keys(changes).length > 0,
    placeholderData: (prev) => prev,
    retry: false,
  });
}

/** After a save or revert every rules-derived view refetches (triage, metrics, history). */
function useInvalidateAll() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries();
}

export function useSaveRules() {
  const invalidate = useInvalidateAll();
  return useMutation({ mutationFn: (req: RulesChangeRequest) => send<RulesChangeResponse>("/api/rules", "PUT", req), onSuccess: invalidate });
}

export function useRevertRules() {
  const invalidate = useInvalidateAll();
  return useMutation({ mutationFn: (req: RulesRevertRequest) => send<RulesChangeResponse>("/api/rules/revert", "POST", req), onSuccess: invalidate });
}

export function useFlagHistory(rule: string) {
  const search = usePaperSearch();
  const q = new URLSearchParams();
  if (rule) q.set("rule", rule);
  const s = q.toString();
  return useQuery({
    queryKey: rulesKeys.flagHistory(rule, search.search, search.t),
    queryFn: () => send<FlagHistoryResponse>(withSearch(`/api/flag-history${s ? `?${s}` : ""}`, search), "GET"),
    placeholderData: (prev) => prev,
  });
}

export function usePaperFlags(pid: number) {
  return useQuery({ queryKey: rulesKeys.paperFlags(pid), queryFn: () => send<PaperFlagHistoryResponse>(`/api/papers/${pid}/flag-history`, "GET") });
}
