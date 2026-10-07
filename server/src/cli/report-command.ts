// `pcs report` and `pcs export` (spec §10.4 G, PLAN M13). Both read the local
// store and the imports only (run `pcs sync` first); neither calls HotCRP.
//
//   pcs report [--do-not-invite <file.csv>]   aggregates (no names, emails, titles, or text);
//                                             optionally writes the do-not-invite carry-forward
//   pcs export --out <dir> [--zip]            pseudonymous CSVs; refuses without PCS_PSEUDONYM_KEY

import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { clockFromConfig } from "../clock.js";
import { loadConfig, orExit, type Config } from "../config.js";
import { formatter } from "../modules/early-reject/index.js";
import {
  doNotInviteCsv,
  EXPORT_FILE_NAMES,
  exportFiles,
  exportZip,
  processReport,
  PseudonymKeyMissingError,
  type ProcessReport,
} from "../modules/report/index.js";
import { StoreError } from "../store/errors.js";
import { openStore, type Store } from "../store/store.js";
import type { Command } from "./main.js";

const out = (s: string) => process.stdout.write(`${s}\n`);
const err = (s: string) => process.stderr.write(`${s}\n`);

export function describeReport(r: ProcessReport, fmt: (t: number) => string): string[] {
  const lines: string[] = [];
  lines.push(`Process report${r.final ? "" : " (provisional)"}, as of ${fmt(r.now)}; phase ${r.phase}`);
  const t = r.totals;
  lines.push(`  ${t.papers} papers, ${t.decided} decided (${t.accepted} accept, ${t.rejected} reject); ${t.reviewerReviews} reviewer reviews, ${t.submitted} submitted`);
  const section = (title: string, rows: { tier: string; reason: string }[]) => {
    lines.push("", `[${title}]`);
    for (const row of rows) lines.push(`  ${row.tier}: ${row.reason}`);
  };
  section(`depth (words; floor ${r.depth.minWords})`, r.depth.rows);
  section(`timeliness (review deadline ${fmt(r.timeliness.reviewDue)})`, r.timeliness.rows);
  section(`merit distribution (${r.merits.field})`, r.merits.rows);
  section("review ratings", r.ratings.rows);
  section("score agreement", r.agreement.rows);
  lines.push("", "[reserve activation and dropout]", `  ${r.reserve.reason}`);
  lines.push("", "[early-reject yield]", `  ${r.earlyReject.reason}`);
  lines.push("", "[quick/desk reject]", `  ${r.quickReject.reason}`);
  lines.push(
    "",
    "[do-not-invite carry-forward]",
    `  ${r.doNotInvite.run ? `import run ${r.doNotInvite.run.id}, ${r.doNotInvite.run.rows} entries; write it with pcs report --do-not-invite <file.csv>` : "no do-not-invite import"}`,
  );
  lines.push("", "[pseudonymous export]", `  ${r.export.keyConfigured ? `ready (key id ${r.export.keyId}); pcs export --out <dir>` : r.export.note}`);
  for (const n of r.notes) lines.push(`note: ${n}`);
  return lines;
}

function withStore(cfg: Config, run: (store: Store) => number): number {
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
    return run(store);
  } finally {
    store.close();
  }
}

/** Write a private file (0600) and say so. */
function writePrivate(path: string, data: string | Buffer): void {
  writeFileSync(path, data, { mode: 0o600 });
  chmodSync(path, 0o600);
}

const REPORT_USAGE =
  "usage: pcs report [--do-not-invite <file.csv>]\n" +
  "  Prints the process report (aggregates only; groups under PCS_REPORT_MIN_CELL people suppressed).\n" +
  "  --do-not-invite <file.csv>  also write the do-not-invite carry-forward (keeps emails: the chair's own list)";
const EXPORT_USAGE =
  "usage: pcs export --out <dir> [--zip]\n" +
  `  Writes ${EXPORT_FILE_NAMES.join(", ")} (and pcs-export.zip with --zip) into <dir>.\n` +
  "  Every row is pseudonymous (HMAC-SHA256 with PCS_PSEUDONYM_KEY); refuses to run without the key.";

function parseArgs(args: string[], flags: Record<string, "value" | "bool">): { opts: Record<string, string | true>; error?: string; help?: boolean } {
  const opts: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--help" || a === "-h") return { opts, help: true };
    const kind = flags[a];
    if (!kind) return { opts, error: `unexpected argument ${JSON.stringify(a)}` };
    if (kind === "bool") opts[a] = true;
    else {
      const v = args[++i];
      if (v === undefined || v.startsWith("--")) return { opts, error: `${a} needs a value` };
      opts[a] = v;
    }
  }
  return { opts };
}

export const REPORT_COMMANDS: Record<string, Command> = {
  report: {
    summary: "Process report: depth, timeliness, ratings, agreement by tier; reserve, early/quick reject (aggregates only)",
    usage: REPORT_USAGE,
    run(args) {
      const p = parseArgs(args, { "--do-not-invite": "value" });
      if (p.help) return (out(REPORT_USAGE), 0);
      if (p.error) return (err(`pcs report: ${p.error}\n${REPORT_USAGE}`), 2);
      const cfg = orExit(() => loadConfig());
      return withStore(cfg, (store) => {
        const clock = clockFromConfig(cfg);
        for (const l of describeReport(processReport(store, cfg, clock), formatter(cfg.tz))) out(l);
        const file = p.opts["--do-not-invite"];
        if (typeof file === "string") {
          const d = doNotInviteCsv(store, clock.now());
          writePrivate(resolve(file), d.csv);
          out(`wrote ${d.rows} do-not-invite entries to ${file} (mode 0600; it holds emails: hand it to the next chair privately)`);
        }
        return 0;
      });
    },
  },
  export: {
    summary: "Pseudonymous per-review and per-reviewer CSVs (HMAC with PCS_PSEUDONYM_KEY; no emails, names, titles, or text)",
    usage: EXPORT_USAGE,
    run(args) {
      const p = parseArgs(args, { "--out": "value", "--zip": "bool" });
      if (p.help) return (out(EXPORT_USAGE), 0);
      if (p.error) return (err(`pcs export: ${p.error}\n${EXPORT_USAGE}`), 2);
      const dir = p.opts["--out"];
      if (typeof dir !== "string") return (err(`pcs export: --out <dir> is required\n${EXPORT_USAGE}`), 2);
      const cfg = orExit(() => loadConfig());
      if (!cfg.report?.pseudonymKey) {
        err(`pcs export: ${new PseudonymKeyMissingError().message}`);
        return 1;
      }
      return withStore(cfg, (store) => {
        const clock = clockFromConfig(cfg);
        const files = exportFiles(store, cfg, clock);
        const target = resolve(dir);
        if (!existsSync(target)) mkdirSync(target, { recursive: true, mode: 0o700 });
        for (const name of EXPORT_FILE_NAMES) {
          writePrivate(join(target, name), files[name]);
          const rows = name.endsWith(".csv") ? files[name].trimEnd().split("\n").length - 1 : null;
          out(`wrote ${join(dir, name)}${rows === null ? "" : ` (${rows} rows)`}`);
        }
        if (p.opts["--zip"]) {
          writePrivate(join(target, "pcs-export.zip"), exportZip(files, clock.now()));
          out(`wrote ${join(dir, "pcs-export.zip")}`);
        }
        out(`pseudonymous export done (key id ${files["manifest.csv"].split("\n")[1]!.split(",")[2]}); rows carry HMAC pseudonyms, no emails`);
        return 0;
      });
    },
  },
};
