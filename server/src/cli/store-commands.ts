// `pcs sync [--watch]`, `pcs backfill [--limit N]`, `pcs wipe --yes` (PLAN M3).
// Output is counts, ids, and paths only: never the token, never review or
// comment text.

import { clockFromConfig, type Clock } from "../clock.js";
import { loadConfig, orExit, type Config } from "../config.js";
import { clientFromConfig } from "../hotcrp/client.js";
import { redact } from "../redact.js";
import { StoreError } from "../store/errors.js";
import { openStore, type Store } from "../store/store.js";
import { dbFiles, wipeDb } from "../store/wipe.js";
import { runBackfill } from "../sync/backfill.js";
import { clientSource } from "../sync/source.js";
import { runSync, type SyncResult } from "../sync/sync.js";
import { backfillFlagHistory, recordStoreFlags } from "../history/flags.js";
import type { Command } from "./main.js";

const out = (s: string) => process.stdout.write(`${s}\n`);
const err = (s: string) => process.stderr.write(`${s}\n`);

function openOrReport(cfg: Config): Store | undefined {
  try {
    return openStore(cfg);
  } catch (e) {
    if (e instanceof StoreError) {
      err(`pcs: ${e.message}`);
      return undefined;
    }
    throw e;
  }
}

/** One line per sync: "sync #4 ok in 1.3 s; papers_new=2 reviews_fetched=30 ...". */
export function describeSync(r: SyncResult, clock: Clock): string {
  const counts = Object.entries(r.counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  const head = `${clock.now().toISOString()} sync #${r.runId} ${r.ok ? "ok" : "FAILED"} in ${(r.durationMs / 1000).toFixed(1)} s`;
  return `${head}${counts ? `; ${counts}` : "; no changes"}`;
}

/** Resolve after `ms`, or as soon as `signal` aborts. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done);
  });
}

/** SIGINT/SIGTERM abort `controller`; a second signal exits immediately. */
function onInterrupt(controller: AbortController, what: string): () => void {
  const handler = () => {
    if (controller.signal.aborted) process.exit(130);
    err(`pcs: stopping after the current ${what} (Ctrl-C again to quit now)`);
    controller.abort();
  };
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
  return () => {
    process.off("SIGINT", handler);
    process.off("SIGTERM", handler);
  };
}

export const STORE_COMMANDS: Record<string, Command> = {
  sync: {
    summary: "Fetch everything from HotCRP and diff it into the local store (--watch: every PCS_SYNC_INTERVAL_MIN)",
    usage: "pcs sync [--watch]",
    async run(args) {
      const bad = args.filter((a) => a !== "--watch");
      if (bad.length > 0) {
        err(`pcs sync: unknown argument ${JSON.stringify(bad[0])}\nusage: pcs sync [--watch]`);
        return 2;
      }
      const watch = args.includes("--watch");
      const cfg = orExit(() => loadConfig());
      const clock = clockFromConfig(cfg);
      const store = openOrReport(cfg);
      if (!store) return 1;
      const source = clientSource(clientFromConfig(cfg.hotcrp));
      const once = async () => {
        const r = await runSync(store.db, source, {
          clock,
          chunkSize: cfg.sync.chunk,
          concurrency: cfg.sync.concurrency,
          tierTags: cfg.tierTags,
          acRole: cfg.acRole,
          log: watch ? undefined : (l) => err(`  ${l}`),
        });
        out(describeSync(r, clock));
        for (const e of r.errors) err(`  ${r.ok ? "warning" : "error"}: ${redact(e, [cfg.hotcrp.token])}`);
        if (r.ok) {
          // Flag history (spec §5c): what this sync raised and cleared.
          const h = recordStoreFlags(store, cfg, clock, { cause: "data", syncRunId: r.runId });
          if (!watch) err(`  flag history: ${h.baseline ? "baseline, " : ""}${h.raised} raised, ${h.cleared} cleared`);
        }
        return r.ok;
      };
      try {
        if (!watch) return (await once()) ? 0 : 1;
        const ctl = new AbortController();
        const off = onInterrupt(ctl, "sync");
        out(`pcs sync --watch: every ${cfg.sync.intervalMin} min; Ctrl-C to stop`);
        while (!ctl.signal.aborted) {
          await once();
          await pause(cfg.sync.intervalMin * 60_000, ctl.signal);
        }
        off();
        return 0;
      } finally {
        store.close();
      }
    },
  },

  backfill: {
    summary: "One-time /reviewhistory backfill at PCS_HISTORY_RPS (resumable)",
    usage: "pcs backfill [--limit N]",
    async run(args) {
      let limit: number | undefined;
      for (let i = 0; i < args.length; i++) {
        if (args[i] === "--limit" && /^\d+$/.test(args[i + 1] ?? "")) limit = Number(args[++i]);
        else {
          err(`pcs backfill: unexpected argument ${JSON.stringify(args[i])}\nusage: pcs backfill [--limit N]`);
          return 2;
        }
      }
      const cfg = orExit(() => loadConfig());
      const clock = clockFromConfig(cfg);
      const store = openOrReport(cfg);
      if (!store) return 1;
      const ctl = new AbortController();
      const off = onInterrupt(ctl, "review");
      try {
        if (!store.lastSuccessfulSync()) {
          err("pcs backfill: run `pcs sync` first");
          return 1;
        }
        const r = await runBackfill(store.db, clientSource(clientFromConfig(cfg.hotcrp)), {
          clock,
          rps: cfg.sync.historyRps,
          limit,
          signal: ctl.signal,
          log: (l) => err(`  ${l}`),
        });
        out(
          `backfill #${r.runId} ${r.ok ? "ok" : "stopped"}: ${r.done} review(s) backfilled, ${r.versionsNew} new version(s), ${r.remaining} remaining`,
        );
        for (const e of r.errors.slice(0, 20)) err(`  ${redact(e, [cfg.hotcrp.token])}`);
        // Rebuild the reconstructed flag history from the (now richer) review history.
        const h = backfillFlagHistory(store, cfg, clock);
        out(`flag history: ${h.events} reconstructed event(s) over ${h.points} daily point(s)`);
        return r.ok ? 0 : 1;
      } finally {
        off();
        store.close();
      }
    },
  },

  wipe: {
    summary: "Delete the local database (PCS_DB_PATH and its -wal/-shm files); needs --yes",
    usage: "pcs wipe --yes",
    run(args) {
      const cfg = orExit(() => loadConfig());
      const files = dbFiles(cfg.db.path);
      if (files.length === 0) {
        out(`pcs wipe: nothing to delete at ${cfg.db.path}`);
        return 0;
      }
      if (!(args.length === 1 && args[0] === "--yes")) {
        err(`pcs wipe: this permanently deletes:\n${files.map((f) => `  ${f}`).join("\n")}\nRe-run as: pcs wipe --yes`);
        return 2;
      }
      for (const f of wipeDb(cfg.db.path)) out(`deleted ${f}`);
      return 0;
    },
  },
};
