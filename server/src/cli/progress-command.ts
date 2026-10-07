// `pcs tier-progress` and `pcs early-reject` (spec §10.4 D/E, PLAN M12).
// Read the local store only (run `pcs sync` first); never call HotCRP. They
// print counts, pids, emails, and reasons with numbers: no titles, no review
// or comment text.

import { clockFromConfig } from "../clock.js";
import { loadConfig, orExit, type Config } from "../config.js";
import { earlyReject, formatter, type EarlyRejectReport } from "../modules/early-reject/index.js";
import { tierProgress, type TierProgressReport } from "../modules/tier-progress/index.js";
import { StoreError } from "../store/errors.js";
import { openStore, type Store } from "../store/store.js";
import type { Command } from "./main.js";

const out = (s: string) => process.stdout.write(`${s}\n`);
const err = (s: string) => process.stderr.write(`${s}\n`);

export function describeTierProgress(r: TierProgressReport, fmt: (t: number) => string): string[] {
  const lines: string[] = [];
  lines.push(`Reviewing progress by tier, as of ${fmt(r.now)} (review deadline ${fmt(r.reviewDue)})`);
  for (const t of r.tiers) lines.push(`  ${t.tier}: ${t.reviewers} reviewers; ${t.reason}`);
  lines.push("", `[reserve dropout] tiers ${r.dropout.reserveTiers.join(",") || "(none)"}; ` + Object.entries(r.dropout.counts).map(([s, n]) => `${s} ${n}`).join(", "));
  for (const d of r.dropout.rows) lines.push(`  #${d.pid} ${d.person.email}: ${d.state}: ${d.reason}`);
  lines.push("", `[reserve accountability] ${r.accountability.note}`);
  if (r.accountability.rows.length === 0) lines.push("  (no reserve reviewers with reviews)");
  for (const a of r.accountability.rows) lines.push(`  ${a.person.email}: ${a.summary}`);
  lines.push("", `[coaching queue] ${r.coaching.tiers.join(",") || "(no tiers)"} reviews under ${r.coaching.minWords} words or rated short/vague: ${r.coaching.rows.length}`);
  for (const c of r.coaching.rows) lines.push(`  #${c.pid} ${c.person.email}: ${c.reason} (${c.hotcrpPath})`);
  lines.push("", `[withhold reviews] ${r.withhold.note}`);
  for (const w of r.withhold.rows) lines.push(`  ${w.person.email}: ${w.reason}`);
  if (r.withhold.csv) lines.push("  Draft HotCRP bulk-assignment CSV (not applied):", ...r.withhold.csv.trimEnd().split("\n").map((l) => `    ${l}`));
  lines.push("", `[participation by tier]${r.participation.discussionOpened ? "" : " (discussion has not opened)"}`);
  for (const p of r.participation.rows) lines.push(`  ${p.tier}: ${p.reason}`);
  return lines;
}

export function describeEarlyReject(r: EarlyRejectReport, fmt: (t: number) => string): string[] {
  if (r.status === "unconfigured") return ["Early reject: not configured.", ...r.notes.map((n) => `note: ${n}`)];
  const lines: string[] = [];
  lines.push(
    `Early reject: window ${fmt(r.open!)} .. ${fmt(r.close!)}${r.closeSource === "window-hours" ? " (close = open + PCS_EARLYREJECT_WINDOW_H)" : ""}; now ${fmt(r.now)}: ${r.status}`,
  );
  lines.push(`Band: ${r.definition}`);
  lines.push(`Candidates as of ${fmt(r.candidatesAt!)}: ${r.candidates.length}`);
  for (const c of r.candidates) {
    const s = c.signals;
    lines.push(
      `  #${c.pid}: ${c.reason}; signals: ${s.comments} comments (${s.acComments} by ACs), ${s.outstandingReviews} reviews outstanding, ${s.newReviewsInWindow} new in the window`,
    );
  }
  if (r.outcomeAt !== null) {
    const label = r.outcomeAt === r.close ? `at close (${fmt(r.outcomeAt)})` : `so far (as of ${fmt(r.outcomeAt)})`;
    lines.push("", `Outcome ${label}:`);
    lines.push(`  bumped: ${r.bumped.map((p) => `#${p}`).join(" ") || "(none)"}`);
    lines.push(`  not bumped: ${r.notBumped.map((p) => `#${p}`).join(" ") || "(none)"}`);
    lines.push(`  reviewers with no response: ${r.noResponse.length}`);
    for (const n of r.noResponse) lines.push(`    #${n.pid} ${n.person.email}: ${n.reason}`);
  }
  if (r.mail) {
    lines.push("", `Mail-tool draft (HotCRP > Mail, recipients "Reviewers with complete reviews"; not sent):`);
    lines.push(`  search: ${r.mail.search}`, `  path: ${r.mail.mailPath}`, `  subject: ${r.mail.subject}`);
  }
  for (const n of r.notes) lines.push(`note: ${n}`);
  return lines;
}

function withStore(run: (store: Store, cfg: Config) => void): number {
  const cfg = orExit(() => loadConfig());
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
  try {
    run(store, cfg);
    return 0;
  } finally {
    store.close();
  }
}

function noArgs(name: string, usage: string, args: string[]): number | null {
  if (args.length === 0) return null;
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    out(usage);
    return 0;
  }
  err(`pcs ${name}: unexpected argument ${JSON.stringify(args[0])}\n${usage}`);
  return 2;
}

const TIER_USAGE = "usage: pcs tier-progress   (late reviews by tier, reserve dropout, accountability, coaching queue; from the last pcs sync)";
const ER_USAGE = "usage: pcs early-reject    (candidates at window open, bumped / not bumped / no response at close; from the last pcs sync)";

export const PROGRESS_COMMANDS: Record<string, Command> = {
  "tier-progress": {
    summary: "Reviewing progress by tier: late reviews, reserve dropout states, accountability, coaching queue (counts only)",
    usage: TIER_USAGE,
    run(args) {
      return (
        noArgs("tier-progress", TIER_USAGE, args) ??
        withStore((store, cfg) => {
          for (const l of describeTierProgress(tierProgress(store, cfg, clockFromConfig(cfg)), formatter(cfg.tz))) out(l);
        })
      );
    },
  },
  "early-reject": {
    summary: "Early-reject candidates and the window outcome: bumped, not bumped, no response (counts only)",
    usage: ER_USAGE,
    run(args) {
      return (
        noArgs("early-reject", ER_USAGE, args) ??
        withStore((store, cfg) => {
          for (const l of describeEarlyReject(earlyReject(store, cfg, clockFromConfig(cfg)), formatter(cfg.tz))) out(l);
        })
      );
    },
  },
};
