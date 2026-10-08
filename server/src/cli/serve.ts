// `pcs serve [--watch]`: the local JSON API and the built web app on
// 127.0.0.1:PCS_PORT (PLAN M5). --watch also syncs every
// PCS_SYNC_INTERVAL_MIN; "sync now" in the UI works either way.
// Output: the URL and sync one-liners only (never the token or content).

import { TagFlow } from "../actions/tagging.js";
import { clockFromConfig } from "../clock.js";
import { loadConfig, orExit } from "../config.js";
import { clientFromConfig } from "../hotcrp/client.js";
import { redact } from "../redact.js";
import { buildApp, defaultWebDir } from "../server/app.js";
import { SyncRunner } from "../server/sync-runner.js";
import { StoreError } from "../store/errors.js";
import { openStore } from "../store/store.js";
import { clientSource } from "../sync/source.js";
import { runSync } from "../sync/sync.js";
import type { Command } from "./main.js";
import { describeSync } from "./store-commands.js";

const out = (s: string) => process.stdout.write(`${s}\n`);
const err = (s: string) => process.stderr.write(`${s}\n`);

export const HOST = "127.0.0.1";

export const SERVE_COMMAND: Command = {
  summary: "Serve the dashboard and JSON API on 127.0.0.1:PCS_PORT (--watch: also sync every PCS_SYNC_INTERVAL_MIN)",
  usage: "pcs serve [--watch]",
  async run(args) {
    const bad = args.filter((a) => a !== "--watch");
    if (bad.length > 0) {
      err(`pcs serve: unknown argument ${JSON.stringify(bad[0])}\nusage: pcs serve [--watch]`);
      return 2;
    }
    const cfg = orExit(() => loadConfig());
    const clock = clockFromConfig(cfg);
    let store;
    try {
      store = openStore(cfg);
    } catch (e) {
      if (e instanceof StoreError) {
        err(`pcs serve: ${e.message}`);
        return 1;
      }
      throw e;
    }
    const client = clientFromConfig(cfg.hotcrp);
    const source = clientSource(client);
    // The one write path (PLAN M8): dry run, explicit confirmation, then the write.
    const tagFlow = new TagFlow({ writer: client, tag: cfg.attentionTag });
    const sync = new SyncRunner(
      async () => {
        const r = await runSync(store.db, source, {
          clock,
          chunkSize: cfg.sync.chunk,
          concurrency: cfg.sync.concurrency,
          tierTags: cfg.tierTags,
          acRole: cfg.acRole,
        });
        return { ...r, errors: r.errors.map((e) => redact(e, [cfg.hotcrp.token])) };
      },
      (r) => {
        out(describeSync(r, clock));
        for (const e of r.errors) err(`  ${r.ok ? "warning" : "error"}: ${e}`);
      },
      [cfg.hotcrp.token],
    );
    const webDir = defaultWebDir();
    const { app } = await buildApp({ cfg, store, clock, sync, tagFlow, webDir, solverHotcrp: client, paperSearcher: client });
    if (!webDir) err("pcs serve: web/dist not found; serving the API only (run `npm run build -w @pcs/web`)");
    if (!store.lastSuccessfulSync()) err("pcs serve: the local store is empty; run `pcs sync` or press \"Sync now\"");

    await app.listen({ host: HOST, port: cfg.port });
    out(`pcs serve: http://${HOST}:${cfg.port}/ (clock ${clock.pinned ? `pinned at ${clock.now().toISOString()}` : "live"})`);

    let timer: NodeJS.Timeout | undefined;
    if (args.includes("--watch")) {
      sync.start();
      timer = setInterval(() => sync.start(), cfg.sync.intervalMin * 60_000);
    }
    await new Promise<void>((resolve) => {
      const stop = () => resolve();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
    if (timer) clearInterval(timer);
    await app.close();
    await sync.current?.catch(() => undefined);
    store.close();
    return 0;
  },
};
