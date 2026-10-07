// `pcs validate-assignments [--tpms] [--out fixup.csv]` (spec §10.4 C, PLAN M10).
// Reads the local store and imports only (run `pcs sync` and `pcs import`
// first); never calls HotCRP. Prints findings (pids, emails, numbers; never
// review text). --out writes the corrected HotCRP assignment CSV, which the
// chair dry-runs in HotCRP before applying.

import { writeFileSync } from "node:fs";
import { clockFromConfig } from "../clock.js";
import { loadConfig, orExit } from "../config.js";
import { NoTpmsImportError, validateAssignments, type AssignmentReport } from "../modules/assignment/index.js";
import { StoreError } from "../store/errors.js";
import { openStore } from "../store/store.js";
import type { Command } from "./main.js";

const out = (s: string) => process.stdout.write(`${s}\n`);
const err = (s: string) => process.stderr.write(`${s}\n`);

export const VALIDATE_USAGE = [
  "usage: pcs validate-assignments [--tpms] [--out fixup.csv]",
  "  (default)  validate the current HotCRP assignment (from the last pcs sync)",
  "  --tpms     validate the latest tpms-assignments import instead",
  "  --out F    write the corrected HotCRP assignment CSV (paper,action,user) to F",
].join("\n");

/** The report as text lines (what the CLI prints). */
export function describeReport(r: AssignmentReport): string[] {
  const lines: string[] = [];
  const src = r.source === "tpms" ? `TPMS proposal (import #${r.imports.tpmsRunId})` : "current HotCRP assignment (last sync)";
  lines.push(`Validated ${src}: ${r.counts.papers} papers, ${r.counts.rows} assignment rows`);
  lines.push(
    `Imports: invites ${r.imports.invitesRunId !== null ? `#${r.imports.invitesRunId}` : "(none)"}, ` +
      `do-not-invite ${r.imports.doNotInviteRunId !== null ? `#${r.imports.doNotInviteRunId}` : "(none)"}`,
  );
  if (r.findings.length === 0) lines.push("No findings.");
  let check = "";
  for (const f of r.findings) {
    if (f.check !== check) {
      check = f.check;
      lines.push("", `[${check}]`);
    }
    lines.push(`  ${f.code}${f.dropped ? " (left out of the fix-up)" : ""}: ${f.reason}`);
  }
  for (const n of r.notes) lines.push(`note: ${n}`);
  const fx = r.fixup;
  const removes = fx.lines.filter((l) => l.slot === "remove").length;
  lines.push("", `Fix-up: ${fx.lines.length - removes} assignment line(s), ${removes} clearreview line(s)`);
  for (const g of fx.gaps) {
    const parts = [g.seniorsMissing > 0 ? `${g.seniorsMissing} senior` : "", g.thirdMissing > 0 ? "the third slot" : ""].filter((x) => x);
    lines.push(`  #${g.pid} still needs ${parts.join(" and ")} after the fix-up`);
  }
  for (const k of fx.keptStarted) lines.push(`  #${k.pid}: ${k.email} kept; review already ${k.status}, so not cleared`);
  return lines;
}

export const ASSIGNMENT_COMMANDS: Record<string, Command> = {
  "validate-assignments": {
    summary: "Check assignments (composition, load, conflicts, reciprocal cycles, reserves); --out writes a fix-up CSV",
    usage: VALIDATE_USAGE,
    run(args) {
      let tpms = false;
      let outFile: string | undefined;
      for (let i = 0; i < args.length; i++) {
        const a = args[i]!;
        if (a === "--tpms") tpms = true;
        else if (a === "--out" && args[i + 1] !== undefined) outFile = args[++i];
        else if (a === "--help" || a === "-h") {
          out(VALIDATE_USAGE);
          return 0;
        } else {
          err(`pcs validate-assignments: unknown argument ${JSON.stringify(a)}\n${VALIDATE_USAGE}`);
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
        const report = validateAssignments(store, cfg, { source: tpms ? "tpms" : "hotcrp", clock: clockFromConfig(cfg) });
        for (const l of describeReport(report)) out(l);
        if (outFile) {
          writeFileSync(outFile, report.fixup.csv, { mode: 0o600 });
          out(`wrote ${outFile}; upload it in HotCRP (Assignments > Upload) and check the preview before saving`);
        }
        return 0;
      } catch (e) {
        if (e instanceof NoTpmsImportError) {
          err(`pcs validate-assignments: ${e.message}`);
          return 1;
        }
        throw e;
      } finally {
        store.close();
      }
    },
  },
};
