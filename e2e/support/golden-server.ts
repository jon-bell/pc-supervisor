// Playwright's webServer command (PLAN M5): prepare the golden state, then
// run `pcs serve` on the built web app.
//
//   1. refuse unless PCS_HOTCRP_URL is the local, disposable harness
//      (AGENTS.md rule 2; harness-verify.ts);
//   2. `seed reset` + `seed golden`;
//   3. sync + /reviewhistory backfill into a fresh temp DB, with the clock
//      pinned at the golden primary instant (PCS_NOW);
//   4. `pcs serve` on 127.0.0.1:PCS_E2E_PORT with that DB and clock.
//
// It runs as the webServer (not globalSetup) because Playwright starts
// webServers before globalSetup; globalSetup re-checks the harness guard and
// that the server is serving the pinned golden state.
// Never sets CI or ARGOS_TOKEN. The temp DB is deleted on exit.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedScenario } from "@pcs/seed/driver";
import { resolveWhen } from "@pcs/seed/time";
import { scenario as golden, NOW_PRIMARY } from "@pcs/seed/scenarios/golden/scenario";
import { SERVE_COMMAND } from "@pcs/server/cli/serve";
import { fixedClock } from "@pcs/server/clock";
import { loadConfig, loadPhaseConfig } from "@pcs/server/config";
import { clientFromConfig } from "@pcs/server/hotcrp/client";
import { verifyHarness } from "@pcs/server/hotcrp/harness-verify";
import { openStore } from "@pcs/server/store/store";
import { runBackfill } from "@pcs/server/sync/backfill";
import { clientSource } from "@pcs/server/sync/source";
import { runSync } from "@pcs/server/sync/sync";
import { formatInZone } from "@pcs/server/tz";
import { E2E_ENV } from "./env.js";

const log = (s: string) => process.stderr.write(`e2e golden-server: ${s}\n`);

async function main(): Promise<number> {
  await verifyHarness();
  const phases = loadPhaseConfig();
  const now = resolveWhen(NOW_PRIMARY, phases);
  const dir = mkdtempSync(join(tmpdir(), "pcs-e2e-"));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  process.on("exit", cleanup);

  Object.assign(process.env, E2E_ENV, {
    PCS_DB_PATH: join(dir, "golden.db"),
    PCS_DB_KEY: "e2e-only-not-secret",
    // Local wall time in PCS_TZ, the format PCS_NOW takes.
    PCS_NOW: formatInZone(now, phases.tz).slice(0, 16),
  });

  await seedScenario(golden, { reset: true, log });
  const cfg = loadConfig();
  const store = openStore(cfg);
  const source = clientSource(clientFromConfig(cfg.hotcrp));
  const clock = fixedClock(cfg.now!);
  const s = await runSync(store.db, source, {
    clock,
    chunkSize: cfg.sync.chunk,
    concurrency: cfg.sync.concurrency,
    tierTags: cfg.tierTags,
    acRole: cfg.acRole,
  });
  if (!s.ok) throw new Error(`sync failed: ${s.errors.join("; ")}`);
  const b = await runBackfill(store.db, source, { clock, rps: cfg.sync.historyRps });
  if (!b.ok) throw new Error(`backfill failed: ${b.errors.join("; ")}`);
  store.close();
  log(`synced golden at PCS_NOW=${process.env.PCS_NOW} (${b.done} reviews backfilled); starting pcs serve`);
  return SERVE_COMMAND.run([]);
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    log(e instanceof Error ? (e.stack ?? e.message) : String(e));
    process.exit(1);
  },
);
