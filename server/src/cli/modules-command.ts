// `pcs reserve` and `pcs quickreject` (spec §10.4 A/B, PLAN M11). Both read
// the local store and imports only (run `pcs sync` and `pcs import` first);
// neither calls HotCRP. They print counts, reasons (pids, emails, numbers),
// and drafted HotCRP Mail-tool searches; never review text, titles, or
// author-written notes.
//
// `pcs reserve` with PCS_DBLP_ENABLED=true looks up DBLP hints first (public
// author names only, at PCS_DBLP_RPS); --no-dblp skips that.

import { clockFromConfig } from "../clock.js";
import { loadConfig, orExit, type Config } from "../config.js";
import { quickRejectReport, type QuickRejectReport } from "../modules/quickreject/index.js";
import { dblpCacheFromConfig, reserveHintNames, reserveReport, type ReserveReport } from "../modules/reserve/index.js";
import { describeModuleStatus, moduleStatus } from "../modules/status.js";
import { phaseTimesFromConfig, type ModuleId } from "../rules/phase.js";
import { StoreError } from "../store/errors.js";
import { openStore, type Store } from "../store/store.js";
import { formatInZone } from "../tz.js";
import type { Command } from "./main.js";

const out = (s: string) => process.stdout.write(`${s}\n`);
const err = (s: string) => process.stderr.write(`${s}\n`);

export const RESERVE_USAGE = [
  "usage: pcs reserve [--no-dblp]",
  "  Reserve-reviewer compliance (spec §10.4 A) from the last pcs sync and the",
  "  latest tpms-registrations import. With PCS_DBLP_ENABLED=true, DBLP hints are",
  "  looked up first (public author names only); --no-dblp skips the lookups.",
].join("\n");

export const QUICKREJECT_USAGE = [
  "usage: pcs quickreject",
  "  The quick-reject / desk-reject queue (spec §10.4 B) from the last pcs sync",
  "  and the latest refcheck import; state comes from PCS_QR_TAGS paper tags.",
].join("\n");

function statusLine(cfg: Config, id: ModuleId, now: Date): string {
  return describeModuleStatus(moduleStatus(id, phaseTimesFromConfig(cfg.phases), now.getTime()), (t) => formatInZone(new Date(t), cfg.tz));
}

/** What `pcs reserve` prints. */
export function describeReserve(r: ReserveReport): string[] {
  const c = r.counts;
  const lines = [
    `Papers: ${c.papers} (${c.designee} with a designee, ${c.exempt} exempt, ${c.noncompliant} non-compliant); designees: ${c.designees}; warnings: ${c.warnings}`,
    `Imports: tpms-registrations ${r.imports.tpmsRegistrationsRunId !== null ? `#${r.imports.tpmsRegistrationsRunId}` : "(none)"}`,
  ];
  if (r.findings.length === 0) lines.push("No findings.");
  let sev = "";
  for (const f of r.findings) {
    if (f.severity !== sev) {
      sev = f.severity;
      lines.push("", sev === "noncompliant" ? "[non-compliant papers]" : "[warnings]");
    }
    lines.push(`  ${f.code}: ${f.reason}`);
  }
  if (r.mailDrafts.length) {
    lines.push("", "Mail-tool searches (HotCRP > Mail; paste the search, pick the recipients):");
    for (const d of r.mailDrafts) lines.push(`  ${d.code}: search "${d.search}" -> ${d.recipients} (${d.papers} papers): ${d.label}`);
  }
  if (r.dblp.enabled) {
    const hints = r.designees.filter((d) => d.hint).length + r.papers.reduce((n, p) => n + p.hints.length, 0);
    lines.push("", `DBLP hints (${r.dblp.source}): ${hints} shown, ${r.dblp.looked} names looked up, ${r.dblp.failed} failed, ${r.dblp.pending} pending. Hints, never verdicts.`);
    for (const d of r.designees) if (d.hint) lines.push(`  ${d.email}: ${d.hint.atVenues} papers at configured venues${d.hint.possiblySenior ? " (possibly senior)" : ""}`);
  }
  for (const n of r.notes) lines.push(`note: ${n}`);
  return lines;
}

/** What `pcs quickreject` prints. */
export function describeQuickReject(r: QuickRejectReport): string[] {
  const c = r.counts;
  const s = c.byStage;
  const a = c.byAppeal;
  const lines = [
    `Queue: ${c.items} papers (${s["ac-decision"]} awaiting AC decision, ${s["chair-action"]} awaiting chair action, ${s.appeal} appeal open, ${s.done} done)`,
    `Appeals: ${a.requested} open, ${a.upheld} upheld, ${a.overturned} overturned`,
    `Quick-reject reviews (round ${r.policy.round}): ${c.qrReviewsSubmitted} of ${c.qrReviews} submitted; ${c.overdueReviews} overdue`,
    `Imports: refcheck ${r.imports.refcheckRunId !== null ? `#${r.imports.refcheckRunId}` : "(none)"}`,
  ];
  for (const i of r.items) {
    lines.push(
      "",
      `#${i.pid}: stage ${i.stage}; AC ${i.acDecision}; chair ${i.chairAction}; appeal ${i.appealState}; decision ${i.decision ?? "(none)"}`,
    );
    for (const sig of i.signals) lines.push(`  signal ${sig.kind}: ${sig.reason}`);
    for (const w of i.warnings) lines.push(`  ${w.code}: ${w.reason}`);
  }
  if (r.overdueReviews.length) {
    lines.push("", "[overdue quick-reject reviews]");
    for (const o of r.overdueReviews) lines.push(`  ${o.reason}`);
  }
  if (r.mailDrafts.length) {
    lines.push("", "Mail-tool searches (HotCRP > Mail):");
    for (const d of r.mailDrafts) lines.push(`  search "${d.search}" -> ${d.recipients} (${d.papers} papers): ${d.label}`);
  }
  for (const n of r.notes) lines.push(`note: ${n}`);
  return lines;
}

function withStore<T>(cfg: Config, f: (s: Store) => Promise<T> | T): Promise<T | 1> | T | 1 {
  let store: Store;
  try {
    store = openStore(cfg);
  } catch (e) {
    if (e instanceof StoreError) {
      err(`pcs: ${e.message}`);
      return 1;
    }
    throw e;
  }
  let closeNow = true;
  try {
    const r = f(store);
    if (r instanceof Promise) {
      closeNow = false;
      return r.finally(() => store.close());
    }
    return r;
  } finally {
    if (closeNow) store.close();
  }
}

function onlyHelp(args: string[], usage: string, allowed: readonly string[], name: string): number | null {
  for (const a of args) {
    if (a === "--help" || a === "-h") {
      out(usage);
      return 0;
    }
    if (!allowed.includes(a)) {
      err(`pcs ${name}: unknown argument ${JSON.stringify(a)}\n${usage}`);
      return 2;
    }
  }
  return null;
}

export const MODULE_COMMANDS: Record<string, Command> = {
  reserve: {
    summary: "Reserve-reviewer compliance: designees, exemptions, coverage, TPMS registration (counts and reasons)",
    usage: RESERVE_USAGE,
    run(args) {
      const early = onlyHelp(args, RESERVE_USAGE, ["--no-dblp"], "reserve");
      if (early !== null) return early;
      const cfg = orExit(() => loadConfig());
      const clock = clockFromConfig(cfg);
      return withStore(cfg, async (store) => {
        out(statusLine(cfg, "reserve-compliance", clock.now()));
        const cache = args.includes("--no-dblp") ? null : dblpCacheFromConfig(cfg);
        if (cache) {
          const names = reserveHintNames(store, cfg, clock);
          err(`DBLP: looking up ${names.length} public author names at ${cfg.reserve!.dblp.rps}/s (PCS_DBLP_ENABLED=true; names only)`);
          await cache.loadAll(names);
        }
        for (const l of describeReserve(reserveReport(store, cfg, { clock, cache }))) out(l);
        return 0;
      });
    },
  },
  quickreject: {
    summary: "Quick-reject / desk-reject queue: signals, AC decision, chair action, appeal state, overdue reviews",
    usage: QUICKREJECT_USAGE,
    run(args) {
      const early = onlyHelp(args, QUICKREJECT_USAGE, [], "quickreject");
      if (early !== null) return early;
      const cfg = orExit(() => loadConfig());
      const clock = clockFromConfig(cfg);
      return withStore(cfg, (store) => {
        out(statusLine(cfg, "quick-reject", clock.now()));
        for (const l of describeQuickReject(quickRejectReport(store, cfg, { clock }))) out(l);
        return 0;
      });
    },
  },
};
