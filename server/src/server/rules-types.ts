// JSON shapes of the rule-settings and flag-history routes (routes/rules.ts,
// routes/flag-history.ts), shared with the web app. Times are epoch ms.

import type { RuleName } from "../config.js";
import type { ChangeError, RuleMeta, SettingChange, SettingMeta, SettingValue } from "../rules/settings.js";
import type { RuleCounts, RulePreview } from "../rules/preview.js";
import type { FlagCause, FlagSeries } from "../history/flags.js";

export type { ChangeError, RuleCounts, RulePreview, SettingChange, SettingValue, FlagCause, FlagSeries };

export interface RevisionInfo {
  id: number;
  at: number;
  actor: string;
  kind: "set" | "revert";
  /** For a revert: the revision restored (0 = env defaults). */
  revertedTo: number | null;
  note: string | null;
  diff: SettingChange[];
  /** Keys overridden after this revision. */
  overrideCount: number;
}

export interface RuleSettingInfo extends SettingMeta {
  /** Effective value (env default or the chair's override). */
  value: SettingValue;
  /** The env default (PCS_* or the built-in default). */
  default: SettingValue;
  overridden: boolean;
}

export interface RuleInfo extends RuleMeta {
  phaseLabel: string;
  enabled: boolean;
  weight: number;
  /** Papers firing it now (whole store). */
  papers: number;
}

export interface RulesResponse {
  now: number;
  /** The revision in force; null = env defaults only. */
  revision: RevisionInfo | null;
  rules: RuleInfo[];
  settings: RuleSettingInfo[];
  papers: number;
  counts: RuleCounts;
}

export interface RulesChangeRequest {
  /** Setting -> value; null = back to the env default. */
  changes: Record<string, SettingValue | null>;
  note?: string;
}

export interface RulesRevertRequest {
  /** Revision id to restore; 0 = the env defaults. */
  to: number;
  note?: string;
}

export interface RulesChangeResponse {
  revision: RevisionInfo;
  /** Flag-history events this change recorded. */
  history: { raised: number; cleared: number };
  rules: RulesResponse;
}

export interface RulesErrorResponse {
  error: string;
  code: string;
  errors?: ChangeError[];
}

export interface RevisionsResponse {
  revisions: RevisionInfo[];
}

export type RulesPreviewResponse = RulePreview;

export interface FlagEventItem {
  type: "flag";
  id: number;
  pid: number;
  title: string;
  rule: RuleName;
  kind: "raised" | "cleared";
  at: number;
  cause: FlagCause;
  revisionId: number | null;
  /** Derived by `pcs backfill` at a daily point (approximate). */
  reconstructed: boolean;
  reason: string | null;
  /** "after AC comment", "after rule change #3", ... (null = no trigger found). */
  why: string | null;
}

export interface ChairActionItem {
  type: "action";
  id: number;
  pid: number;
  title: string;
  kind: "tag" | "untag";
  tag: string;
  at: number;
  actor: string;
}

export type FlagFeedItem = FlagEventItem | ChairActionItem;

export interface FlagHistoryResponse {
  now: number;
  /** When live recording began (the baseline), or null if never. */
  since: number | null;
  /** Earliest event, reconstructed ones included. */
  start: number | null;
  rules: RuleName[];
  /** Newest first. */
  items: FlagFeedItem[];
  /** More items before the last one (page with ?before=<at>). */
  more: boolean;
  series: FlagSeries;
  /** Open flags per rule now, and raises/clears in the last 7 days (per the ?rule filter's papers). */
  summary: { rule: RuleName; open: number; raised7d: number; cleared7d: number }[];
}

export interface FlagSpan {
  rule: RuleName;
  raisedAt: number;
  clearedAt: number | null;
  raisedReconstructed: boolean;
  clearedReconstructed: boolean;
  raisedWhy: string | null;
  clearedWhy: string | null;
  reason: string | null;
}

export interface PaperFlagHistoryResponse {
  pid: number;
  since: number | null;
  spans: FlagSpan[];
  actions: ChairActionItem[];
}
