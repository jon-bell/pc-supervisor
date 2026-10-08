// `pcs solve-assignments [--hard] [--out file.csv] [--report file.json]`
// (spec §10.5, PLAN M10b). Reads the local store and imports (run `pcs sync`
// and `pcs import` first) plus two read-only HotCRP downloads (PC conflicts,
// review preferences). Prints the solve report (pids, emails, numbers; never
// review text). --out writes the HotCRP bulk-assign CSV, which the tool never
// applies: the chair uploads it in HotCRP and checks the preview first.

import { writeFileSync } from "node:fs";
import { clockFromConfig } from "../clock.js";
import { loadConfig, orExit } from "../config.js";
import { clientFromConfig } from "../hotcrp/client.js";
import { HotcrpError } from "../hotcrp/errors.js";
import { solveAssignments, type SolveReport } from "../modules/solver/index.js";
import { StoreError } from "../store/errors.js";
import { openStore } from "../store/store.js";
import type { Command } from "./main.js";

const out = (s: string) => process.stdout.write(`${s}\n`);
const err = (s: string) => process.stderr.write(`${s}\n`);

export const SOLVE_USAGE = [
  "usage: pcs solve-assignments [--hard] [--out file.csv] [--report file.json]",
  "  Solves the tiered assignment (min-cost flow + repair passes) from the last pcs sync, the",
  "  imports (tpms-scores, affinity-local, invites, do-not-invite), and HotCRP's PC conflicts and",
  "  review preferences (read-only).",
  "  --hard      required slots as true lower bounds (PCS_SOLVER_HARD=true); can be infeasible",
  "  --out F     write the HotCRP bulk-assign CSV (paper,action,email,round) to F; never applied here",
  "  --report F  write the full solve report as JSON to F",
].join("\n");

/** The report as text lines (what the CLI prints). */
export function describeSolve(r: SolveReport): string[] {
  const l: string[] = [];
  const c = r.counts;
  l.push(
    `Solved (${r.mode}${r.feasible ? "" : ", INFEASIBLE"}): ${c.papers} papers, ${c.reviewers} reviewers; ` +
      `network ${c.nodes} vertices, ${c.edges} edges (${c.candidates} candidates, ${c.pinned} pinned); ${c.solves} solve(s) in ${Math.round(r.timing.totalMs)} ms`,
  );
  const src = r.sources;
  l.push(
    `Affinity: tpms-scores ${src.tpmsRunId !== null ? `#${src.tpmsRunId}` : "(none)"}, affinity-local ${src.localRunId !== null ? `#${src.localRunId}` : "(none)"}, ` +
      `HotCRP preferences ${src.hotcrpPrefs === null ? "(not fetched)" : `${src.hotcrpPrefs} rows`}; ${src.conflicts} HotCRP conflicts`,
  );
  l.push(`Objective ${r.objective} (load cost minus affinity: ${r.affinityObjective})`);
  l.push(`Assignments: ${c.assignments} (${c.kept} kept, ${c.added} new), ${c.cleared} clearreview`);
  l.push("", "[load by tier]");
  for (const t of r.load) {
    const band = t.band ? `band ${t.band.min}-${t.band.max}` : "no band";
    l.push(`  ${t.tier}: ${t.reviewers} reviewers, ${band}; loads ${t.histogram.map((h) => `${h.load}:${h.reviewers}`).join(" ")}; ${t.under} under, ${t.over} over`);
  }
  l.push("", `[unmet requirements] ${r.unmet.length === 0 ? "none" : ""}`);
  for (const u of r.unmet) l.push(`  ${u.reason}`);
  l.push("", `[repairs] ${r.repairs.length === 0 ? "none" : ""}`);
  for (const x of r.repairs) l.push(`  round ${x.round} ${x.kind}: ${x.reason}`);
  if (r.unresolved.length > 0) {
    l.push("", "[unresolved]");
    for (const u of r.unresolved) l.push(`  ${u.kind}: ${u.reason}`);
  }
  if (r.pinIssues.length > 0) {
    l.push("", "[pins]");
    for (const p of r.pinIssues) l.push(`  #${p.pid} ${p.email}: ${p.reason}`);
  }
  l.push("", `[affinity coverage] ${r.coverage.weak.length} paper(s) weakly covered (PCS_SOLVER_WEAK_AFFINITY=${r.coverage.threshold}); ${r.coverage.unscoredAssignments} assignment(s) without a score`);
  for (const w of r.coverage.weak.slice(0, 20)) l.push(`  ${w.reason}`);
  if (r.coverage.weak.length > 20) l.push(`  ... and ${r.coverage.weak.length - 20} more (see --report)`);
  const x = r.crossCheck;
  l.push("", `[validator cross-check] ${x.findings.length} finding(s), ${x.unexplained} unexplained`);
  for (const f of x.findings.filter((f) => f.explainedBy === null)) l.push(`  UNEXPLAINED ${f.code}: ${f.reason}`);
  for (const n of r.notes) l.push(`note: ${n}`);
  return l;
}

export const SOLVER_COMMANDS: Record<string, Command> = {
  "solve-assignments": {
    summary: "Solve the tiered assignment (min-cost flow + cycle/institution repairs); --out writes a HotCRP bulk-assign CSV",
    usage: SOLVE_USAGE,
    async run(args) {
      let hard: boolean | undefined;
      let outFile: string | undefined;
      let reportFile: string | undefined;
      for (let i = 0; i < args.length; i++) {
        const a = args[i]!;
        if (a === "--hard") hard = true;
        else if (a === "--out" && args[i + 1] !== undefined) outFile = args[++i];
        else if (a === "--report" && args[i + 1] !== undefined) reportFile = args[++i];
        else if (a === "--help" || a === "-h") {
          out(SOLVE_USAGE);
          return 0;
        } else {
          err(`pcs solve-assignments: unknown argument ${JSON.stringify(a)}\n${SOLVE_USAGE}`);
          return 2;
        }
      }
      const cfg = orExit(() => loadConfig());
      let store;
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
        if (!store.lastSuccessfulSync()) {
          err("pcs solve-assignments: the local store has no successful sync yet; run `pcs sync` first");
          return 1;
        }
        let report: SolveReport;
        try {
          report = await solveAssignments(store, cfg, { clock: clockFromConfig(cfg), client: clientFromConfig(cfg.hotcrp), ...(hard ? { hard } : {}) });
        } catch (e) {
          if (e instanceof HotcrpError) {
            err(`pcs solve-assignments: ${e.message}`);
            return 1;
          }
          throw e;
        }
        for (const line of describeSolve(report)) out(line);
        if (outFile) {
          writeFileSync(outFile, report.csv, { mode: 0o600 });
          out(`wrote ${outFile}; upload it in HotCRP (Assignments > Upload) and check the preview before saving. The tool never applies it.`);
        }
        if (reportFile) {
          writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
          out(`wrote ${reportFile}`);
        }
        return report.feasible ? 0 : 1;
      } finally {
        store.close();
      }
    },
  },
};
