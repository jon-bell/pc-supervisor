// `pcs export tpms <dir>` (spec §10.3): the file bundle for the TPMS operator.
// Reads the PC, tiers, and ACs from the local store (run `pcs sync` first) and
// HotCRP's PC conflicts (GET /searchaction?action=get/pcconf, read-only).
// Files are written 0600 in a 0700 directory: they hold reviewer emails.

import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig, orExit } from "../config.js";
import { clientFromConfig } from "../hotcrp/client.js";
import { HotcrpError } from "../hotcrp/errors.js";
import { tpmsExport } from "../modules/tpms/index.js";
import { StoreError } from "../store/errors.js";
import { openStore, type Store } from "../store/store.js";

const out = (s: string) => process.stdout.write(`${s}\n`);
const err = (s: string) => process.stderr.write(`${s}\n`);

export const TPMS_EXPORT_USAGE =
  "usage: pcs export tpms <dir>\n" +
  "  Writes the TPMS operator's bundle into <dir>: pc.csv, conflicts.csv, load-<tier>.csv,\n" +
  "  reviews-per-paper.csv, README.txt. Needs a synced store and reads HotCRP's PC conflicts.\n" +
  "  The files contain reviewer emails (TPMS matches reviewers by email), never review text.";

export async function runTpmsExport(args: string[]): Promise<number> {
  if (args[0] === "--help" || args[0] === "-h") return (out(TPMS_EXPORT_USAGE), 0);
  if (args.length !== 1 || args[0]!.startsWith("-")) return (err(TPMS_EXPORT_USAGE), 2);
  const dir = args[0]!;
  const cfg = orExit(() => loadConfig());
  let store: Store;
  try {
    store = openStore(cfg);
  } catch (e) {
    if (e instanceof StoreError) return (err(`pcs: ${e.message}`), 1);
    throw e;
  }
  try {
    if (!store.lastSuccessfulSync()) {
      err("pcs export tpms: the local store has no successful sync yet; run `pcs sync` first");
      return 1;
    }
    let bundle;
    try {
      bundle = await tpmsExport(store, cfg, clientFromConfig(cfg.hotcrp));
    } catch (e) {
      if (e instanceof HotcrpError) return (err(`pcs export tpms: ${e.message}`), 1);
      throw e;
    }
    const target = resolve(dir);
    if (!existsSync(target)) mkdirSync(target, { recursive: true, mode: 0o700 });
    for (const f of bundle.files) {
      const path = join(target, f.name);
      writeFileSync(path, f.content, { mode: 0o600 });
      chmodSync(path, 0o600);
      out(`wrote ${join(dir, f.name)}${f.rows === null ? "" : ` (${f.rows} row${f.rows === 1 ? "" : "s"})`}: ${f.about}`);
    }
    const c = bundle.counts;
    out(`TPMS bundle: ${c.pc} PC members (${c.assignable} assignable in ${c.loadGroups} load group(s), ${c.exempt} chairs/ACs), ${c.conflicts} conflicts.`);
    out("CONFIDENTIAL: these files contain reviewer emails and names (TPMS needs them); no reviews or comments.");
    out("  Send them only to the TPMS operator, privately, and delete local copies afterwards.");
    out("PDFs: download them from HotCRP itself: Search > Submitted > select all > Download > Documents: Submissions (ZIP).");
    return 0;
  } finally {
    store.close();
  }
}
