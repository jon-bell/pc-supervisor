// Process report + pseudonymous export (spec §10.4 G, PLAN M13): the module's
// public API.
//
//   import { processReport, processReportFrom, exportFiles, doNotInviteCsv } from "../modules/report/index.js";
//   const report = processReport(store, cfg, clock);            // CLI
//   const report = processReportFrom(view, store, cfg);         // server (cached analysis)
//   const files = exportFilesFrom(view, store, cfg);            // needs PCS_PSEUDONYM_KEY
//
// Read-only over the local store and the imports; never calls HotCRP. The
// report is aggregates only. The export is pseudonymous rows only. The
// do-not-invite carry-forward keeps emails: it is the chair's own list, handed
// to the next chair, and isn't part of the baseline export (spec §10.4 G).

import type { Clock } from "../../clock.js";
import { DEFAULT_REPORT_SETTINGS, DEFAULT_TIER_PROGRESS_POLICY, type Config } from "../../config.js";
import { rowsAsOf, runAsOf } from "../../imports/store.js";
import { activeModules, analyze, extendedPhaseAt, ruleContextFromConfig, type Analysis, type RuleContext, type SnapshotIndex } from "../../rules/index.js";
import type { Db } from "../../store/db.js";
import type { Store } from "../../store/store.js";
import { buildSnapshot } from "../../views/snapshot.js";
import { earlyRejectFrom } from "../early-reject/index.js";
import { loadStoreExtras, tierProgressFrom } from "../tier-progress/index.js";
import {
  agreementByTier,
  depthByTier,
  earlyRejectYield,
  meritsByTier,
  ratingsByTier,
  reserveSection,
  reviewFacts,
  tierOrder,
  timelinessByTier,
  type ReviewFact,
} from "./compute.js";
import { buildExport, EXPORT_FILE_NAMES, type ExportFiles } from "./export.js";
import { keyId, pseudonymizer } from "./pseudonym.js";
import { m11QuickReject, type QuickRejectProvider } from "./quick-reject.js";
import type { ProcessReport } from "./types.js";
import { zip } from "./zip.js";

export type * from "./types.js";
export * from "./compute.js";
export { buildExport, EXPORT_FILE_NAMES, ExportCellError, toCsv, type ExportFiles } from "./export.js";
export { normalizeEmail, pseudonym, pseudonymizer, PseudonymKeyMissingError } from "./pseudonym.js";
export { m11QuickReject, QUICK_REJECT_UNAVAILABLE, summarizeQuickReject, type QuickRejectProvider } from "./quick-reject.js";
export { unzip, zip } from "./zip.js";

/** The tier of designated, not-activated reserve reviewers (spec §10.2). */
export const RESERVE_POOL_TIER = "reserve-pool";

export const REPORT_PATHS = {
  report: "/api/report",
  zip: "/api/report/export.zip",
  file: "/api/report/export/",
  doNotInvite: "/api/report/do-not-invite.csv",
} as const;

export interface ReportOptions {
  /** Quick-reject counts. Default: M11's tracker (m11QuickReject). */
  quickReject?: QuickRejectProvider;
}

type View = { analysis: Analysis; ctx: RuleContext };

/** rid -> HotCRP rating names, for live reviews that have any (one indexed scan). */
export function loadRatings(db: Db): Map<number, string[]> {
  const out = new Map<number, string[]>();
  for (const r of db.prepare("select rid, ratings from review where deleted_seen_at is null and ratings != '[]'").all() as { rid: number; ratings: string }[]) {
    try {
      const v = JSON.parse(r.ratings) as unknown;
      const names = (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === "string");
      if (names.length > 0) out.set(r.rid, names);
    } catch {
      // The sync writes this column as JSON; a bad row has no ratings.
    }
  }
  return out;
}

/** Per reviewer: published non-response comments on papers they review, and how many papers. */
export function commentsByReviewer(index: SnapshotIndex, facts: readonly ReviewFact[]): Map<string, { comments: number; papers: number }> {
  const reviews = new Map<number, Set<string>>();
  for (const f of facts) {
    let s = reviews.get(f.pid);
    if (!s) reviews.set(f.pid, (s = new Set()));
    s.add(f.email);
  }
  const out = new Map<string, { comments: number; papers: number }>();
  for (const [pid, emails] of reviews) {
    const seen = new Set<string>();
    for (const c of index.byPid.get(pid)?.comments ?? []) {
      if (c.draft || c.isResponse || !emails.has(c.email)) continue;
      const e = out.get(c.email) ?? { comments: 0, papers: 0 };
      e.comments++;
      if (!seen.has(c.email)) {
        e.papers++;
        seen.add(c.email);
      }
      out.set(c.email, e);
    }
  }
  return out;
}

function settings(cfg: Pick<Config, "report">) {
  return cfg.report ?? DEFAULT_REPORT_SETTINGS;
}

function factsFrom(view: View, store: Store, cfg: Pick<Config, "report">): ReviewFact[] {
  const s = settings(cfg);
  return reviewFacts(view.analysis.evaluation.index, view.ctx, {
    approxRids: loadStoreExtras(store.db).approxRids,
    ratings: loadRatings(store.db),
    acceptDecisions: s.acceptDecisions,
  });
}

/** From an already-evaluated analysis (the server's cached one). */
export function processReportFrom(view: View, store: Store, cfg: Config, clock: Clock, opts: ReportOptions = {}): ProcessReport {
  const s = settings(cfg);
  const { ctx } = view;
  const index = view.analysis.evaluation.index;
  const now = ctx.now;
  const facts = factsFrom(view, store, cfg);
  const tiers = tierOrder(["senior", ...Object.keys(cfg.tierTags)], facts);
  const tp = tierProgressFrom(view, store, cfg);
  const er = earlyRejectFrom(index, store, cfg, now);
  const policy = cfg.tierProgress ?? DEFAULT_TIER_PROGRESS_POLICY;
  const phase = extendedPhaseAt(ctx.phases, now);
  const final = activeModules(phase).includes("process-report");
  const at = new Date(now);
  const invites = rowsAsOf(store.db, "invites", at);
  const dni = runAsOf(store.db, "do-not-invite", at);
  const minWords = ctx.thresholds.MIN_WORDS;
  const ratings = ratingsByTier(facts, tiers, s.minCell);
  const papers = index.bundles.length;
  const sides = index.bundles.map((b) => b.paper.decision).filter((d): d is string => d !== null);
  const accepted = sides.filter((d) => s.acceptDecisions.some((p) => d.trim().toLowerCase().startsWith(p))).length;

  const notes: string[] = [];
  if (!final) notes.push(`Provisional: the phase is ${phase}; the final report is the one computed after decisions (PCS_PHASE_DECISIONS_DUE).`);
  notes.push(`Groups with fewer than PCS_REPORT_MIN_CELL=${s.minCell} people are suppressed in every table.`);
  if (store.lastSuccessfulSync() === undefined) notes.push("No successful sync yet: run pcs sync first.");

  return {
    now,
    phase,
    final,
    minCell: s.minCell,
    tiers,
    totals: {
      papers,
      decided: sides.length,
      accepted,
      rejected: sides.length - accepted,
      reviewerReviews: facts.length,
      submitted: facts.filter((f) => f.submitted).length,
    },
    depth: { minWords, rows: depthByTier(facts, tiers, s.minCell, minWords) },
    timeliness: { reviewDue: ctx.phases.reviewDue, rows: timelinessByTier(facts, tiers, s.minCell) },
    merits: { field: cfg.fields.merit, acceptMin: ctx.meritAcceptMin, rows: meritsByTier(facts, tiers, s.minCell) },
    ratings,
    agreement: { rows: agreementByTier(facts, tiers, s.minCell, ctx.meritAcceptMin) },
    reserve: reserveSection(index, tp, {
      reserveTiers: policy.reserveTiers,
      poolTier: RESERVE_POOL_TIER,
      minCell: s.minCell,
      invites: invites.run ? invites.rows : null,
    }),
    earlyReject: earlyRejectYield(er, index, s.acceptDecisions),
    quickReject: (opts.quickReject ?? m11QuickReject)(store, cfg, clock),
    doNotInvite: {
      run: dni ? { id: dni.id, importedAt: dni.importedAt * 1000, rows: dni.rowCount } : null,
      downloadPath: REPORT_PATHS.doNotInvite,
      note: "The carry-forward keeps emails: it is the chair's own list for the next chair (re-import it with pcs import do-not-invite), not part of the pseudonymous export. Hand it over privately.",
    },
    export: {
      keyConfigured: s.pseudonymKey !== undefined,
      keyId: s.pseudonymKey ? keyId(s.pseudonymKey) : null,
      files: [...EXPORT_FILE_NAMES],
      zipPath: REPORT_PATHS.zip,
      filePath: REPORT_PATHS.file,
      note: s.pseudonymKey
        ? "Every row carries HMAC-SHA256(PCS_PSEUDONYM_KEY, email) instead of the email; no names, titles, or text. Files download to this machine only."
        : "Set PCS_PSEUDONYM_KEY (at least 16 characters) and restart to enable the export; it refuses to run without the key.",
    },
    notes,
  };
}

/** Build the snapshot, evaluate, and report (the CLI and tests). */
export function processReport(store: Store, cfg: Config, clock: Clock, opts: ReportOptions = {}): ProcessReport {
  return processReportFrom(viewOf(store, cfg, clock), store, cfg, clock, opts);
}

function viewOf(store: Store, cfg: Config, clock: Clock): View {
  const ctx = ruleContextFromConfig(cfg, clock);
  return { analysis: analyze(buildSnapshot(store, { fields: cfg.fields, acRole: cfg.acRole }), ctx), ctx };
}

/** The pseudonymous export files. Throws PseudonymKeyMissingError before reading anything when the key is unset. */
export function exportFilesFrom(view: View, store: Store, cfg: Config): ExportFiles {
  const s = settings(cfg);
  const ps = pseudonymizer(s.pseudonymKey);
  const index = view.analysis.evaluation.index;
  const facts = factsFrom(view, store, cfg);
  const er = earlyRejectFrom(index, store, cfg, view.ctx.now);
  return buildExport(
    {
      facts,
      comments: commentsByReviewer(index, facts),
      earlyRejectPids: new Set(er.candidates.map((c) => c.pid)),
      minCell: s.minCell,
      generatedOn: new Date(view.ctx.now).toISOString().slice(0, 10),
    },
    ps,
  );
}

export function exportFiles(store: Store, cfg: Config, clock: Clock): ExportFiles {
  pseudonymizer(settings(cfg).pseudonymKey); // refuse before building the snapshot
  return exportFilesFrom(viewOf(store, cfg, clock), store, cfg);
}

export function exportZip(files: ExportFiles, at: Date): Buffer {
  return zip(
    EXPORT_FILE_NAMES.map((name) => ({ name, data: files[name] })),
    at,
  );
}

const csvQuote = (v: string | null) => (v === null ? "" : /[",\r\n]/.test(v) || v !== v.trim() ? `"${v.replace(/"/g, '""')}"` : v);

/**
 * The do-not-invite carry-forward: the latest do-not-invite import as of `at`,
 * as a CSV that `pcs import do-not-invite` reads back unchanged (email,reason,source).
 * Keeps emails on purpose (see the header). Empty (header only) with no import.
 */
export function doNotInviteCsv(store: Store, at: Date): { csv: string; rows: number; runId: number | null } {
  const { run, rows } = rowsAsOf(store.db, "do-not-invite", at);
  const lines = ["email,reason,source", ...rows.map((r) => [r.email, r.reason, r.source].map(csvQuote).join(","))];
  return { csv: `${lines.join("\n")}\n`, rows: rows.length, runId: run?.id ?? null };
}
