// Early reject (spec §10.4 E, PLAN M12): the module's public API.
//
//   import { earlyReject, earlyRejectFrom } from "../modules/early-reject/index.js";
//   const report = earlyReject(store, cfg, clock);            // CLI
//   const report = earlyRejectFrom(index, store, cfg, now);   // server (cached snapshot index)
//
// Read-only over the local store; never calls HotCRP and never sends mail.
// The mail draft is text for the chair to paste into HotCRP's Mail tool.

import type { Clock } from "../../clock.js";
import { DEFAULT_EARLY_REJECT, type Config } from "../../config.js";
import { indexSnapshot, type Millis, type SnapshotIndex } from "../../rules/index.js";
import type { Store } from "../../store/store.js";
import { formatInZone } from "../../tz.js";
import { buildSnapshot } from "../../views/snapshot.js";
import { computeEarlyReject, type EarlyRejectWindow } from "./compute.js";
import type { EarlyRejectReport } from "./types.js";

export type * from "./types.js";
export { bandMax, computeEarlyReject, mailDraft, versionAt, type EarlyRejectOptions, type EarlyRejectWindow } from "./compute.js";

type ModuleConfig = Pick<Config, "phases" | "tz" | "earlyReject">;

export function windowFromConfig(cfg: ModuleConfig): EarlyRejectWindow {
  const open = cfg.phases.earlyRejectOpen?.getTime() ?? null;
  const close = cfg.phases.earlyRejectClose?.getTime() ?? null;
  return {
    open,
    close,
    closeSource: open === null || close === null ? null : cfg.earlyReject?.closeDerived ? "window-hours" : "env",
  };
}

/** "2030-02-03 09:00 EST"-style local time in PCS_TZ, for reasons. */
export function formatter(tz: string): (t: Millis) => string {
  return (t) => formatInZone(new Date(t), tz).slice(0, 16).replace("T", " ");
}

/** From an already-built snapshot index (the server's cached analysis). */
export function earlyRejectFrom(index: SnapshotIndex, store: Store, cfg: ModuleConfig, now: Millis): EarlyRejectReport {
  const win = windowFromConfig(cfg);
  let syncAtOpen: Millis | null = null;
  if (win.open !== null) {
    const row = store.db
      .prepare("select max(now_used) as t from sync_run where kind = 'sync' and ok = 1 and finished_at is not null and now_used <= ?")
      .get(Math.floor(win.open / 1000)) as { t: number | null };
    syncAtOpen = row.t === null ? null : row.t * 1000;
  }
  return computeEarlyReject(index, cfg.earlyReject ?? DEFAULT_EARLY_REJECT, win, now, { tz: cfg.tz, fmt: formatter(cfg.tz), syncAtOpen });
}

/** Build the snapshot and report (the CLI and tests). */
export function earlyReject(store: Store, cfg: Config, clock: Clock): EarlyRejectReport {
  const index = indexSnapshot(buildSnapshot(store, { fields: cfg.fields, acRole: cfg.acRole }));
  return earlyRejectFrom(index, store, cfg, clock.now().getTime());
}
