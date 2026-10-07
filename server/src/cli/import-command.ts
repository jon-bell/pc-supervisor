// `pcs import <kind> <file>` and `pcs import --list [kind]` (spec §10.3, PLAN M9).
// Output is counts, run ids, hashes, and line/column numbers only: never a
// cell value (these files hold reviewer identities and the do-not-invite list).

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { clockFromConfig } from "../clock.js";
import { loadConfig, orExit } from "../config.js";
import { IMPORT_KINDS, describeKind, isImportKind, type ImportKind } from "../imports/kinds.js";
import { formatProblem } from "../imports/parse.js";
import { diffWithPrevious, importCsv, listRuns } from "../imports/store.js";
import { StoreError } from "../store/errors.js";
import { openStore, type Store } from "../store/store.js";
import { formatInZone } from "../tz.js";
import type { Command } from "./main.js";

const out = (s: string) => process.stdout.write(`${s}\n`);
const err = (s: string) => process.stderr.write(`${s}\n`);

/** At most this many problems are printed; the rest are counted. */
const MAX_PROBLEMS = 50;

export const IMPORT_USAGE = [
  "usage: pcs import <kind> <file.csv>   import a CSV as a new version (all rows or none)",
  "       pcs import --list [<kind>]     import history (counts only)",
  "       pcs import --help              kinds and their columns",
  `kinds: ${IMPORT_KINDS.join(", ")}`,
].join("\n");

function helpText(): string {
  const kinds = IMPORT_KINDS.flatMap((k) => describeKind(k));
  return (
    `${IMPORT_USAGE}\n\nColumns (* = required). Headers are case-insensitive, any order; extra columns are ignored.\n` +
    `Emails are lowercased. Dates: YYYY-MM-DD or YYYY-MM-DDTHH:MM, in PCS_TZ.\n${kinds.map((l) => `  ${l}`).join("\n")}\n`
  );
}

function openOrReport(): { store: Store; tz: string; clock: ReturnType<typeof clockFromConfig> } | undefined {
  const cfg = orExit(() => loadConfig());
  try {
    return { store: openStore(cfg), tz: cfg.tz, clock: clockFromConfig(cfg) };
  } catch (e) {
    if (e instanceof StoreError) {
      err(`pcs: ${e.message}`);
      return undefined;
    }
    throw e;
  }
}

function runList(kind: ImportKind | undefined): number {
  const o = openOrReport();
  if (!o) return 1;
  try {
    const runs = listRuns(o.store.db, kind);
    if (runs.length === 0) {
      out(kind ? `no ${kind} imports yet` : "no imports yet");
      return 0;
    }
    out("run  kind                imported at                rows  vs previous          sha256");
    for (const r of runs) {
      const d = diffWithPrevious(o.store.db, r);
      const delta = `+${d.added.length} -${d.removed.length} ~${d.changed.length}`;
      out(
        `${String(r.id).padStart(3)}  ${r.kind.padEnd(18)}  ${formatInZone(new Date(r.importedAt * 1000), o.tz)}  ` +
          `${String(r.rowCount).padStart(5)}  ${delta.padEnd(19)}  ${r.fileSha256.slice(0, 12)}`,
      );
    }
    return 0;
  } finally {
    o.store.close();
  }
}

function runImport(kind: ImportKind, file: string): number {
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch (e) {
    err(`pcs import: cannot read ${file}: ${(e as NodeJS.ErrnoException).code ?? "error"}`);
    return 1;
  }
  const o = openOrReport();
  if (!o) return 1;
  try {
    const r = importCsv(o.store.db, kind, bytes, { tz: o.tz, clock: o.clock, fileName: basename(file) });
    if (!r.ok) {
      const n = r.problems.length;
      err(`pcs import: ${basename(file)} has ${n} problem${n === 1 ? "" : "s"}; nothing was imported`);
      for (const p of r.problems.slice(0, MAX_PROBLEMS)) err(`  ${formatProblem(p)}`);
      if (n > MAX_PROBLEMS) err(`  ... and ${n - MAX_PROBLEMS} more`);
      return 1;
    }
    const d = diffWithPrevious(o.store.db, r.run);
    out(
      `import #${r.run.id} ${kind}: ${r.run.rowCount} row(s); vs previous +${d.added.length} -${d.removed.length} ` +
        `~${d.changed.length} (sha256 ${r.run.fileSha256.slice(0, 12)})`,
    );
    if (r.sameAsRunId !== null) out(`  note: identical file to import #${r.sameAsRunId}`);
    if (r.ignoredColumns.length > 0) out(`  ignored ${r.ignoredColumns.length} unrecognized column(s)`);
    return 0;
  } finally {
    o.store.close();
  }
}

export const IMPORT_COMMANDS: Record<string, Command> = {
  import: {
    summary: "Import a local CSV (invites, TPMS, refcheck, do-not-invite) as a new version; --list for history",
    usage: IMPORT_USAGE,
    run(args) {
      const [a, b, ...rest] = args;
      if (a === "--help" || a === "-h") {
        process.stdout.write(helpText());
        return 0;
      }
      if (a === "--list" && rest.length === 0) {
        if (b !== undefined && !isImportKind(b)) {
          err(`pcs import: unknown kind ${JSON.stringify(b)}\n${IMPORT_USAGE}`);
          return 2;
        }
        return runList(b);
      }
      if (a === undefined || b === undefined || rest.length > 0 || a.startsWith("-")) {
        err(IMPORT_USAGE);
        return 2;
      }
      if (!isImportKind(a)) {
        err(`pcs import: unknown kind ${JSON.stringify(a)}\n${IMPORT_USAGE}`);
        return 2;
      }
      return runImport(a, b);
    },
  },
};
