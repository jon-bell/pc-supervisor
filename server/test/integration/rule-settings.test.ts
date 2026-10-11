// Rule settings + flag history over the golden scenario (spec §5c): golden ->
// sync -> baseline -> backfill -> reconstruction, then the documented
// override case (PLAN.md, OVERRIDE_CASE): a chair override changes exactly
// the expected golden flags, the preview predicts exactly that, the change is
// recorded in flag history with its revision, and a revert restores golden.
//
// RESETS the harness and seeds golden. Uses a temp DB (never PCS_DB_PATH).
// No HotCRP call after the sync and backfill: rule changes are local.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedScenario } from "@pcs/seed/driver";
import { resolveWhen } from "@pcs/seed/time";
import { scenario as golden } from "@pcs/seed/scenarios/golden/scenario";
import { FIRES_AT_PRIMARY, NOW_PRIMARY, OVERRIDE_CASE } from "@pcs/seed/scenarios/golden/expected";
import { fixedClock, type Clock } from "../../src/clock.js";
import { loadConfig, type Config } from "../../src/config.js";
import { clientFromConfig } from "../../src/hotcrp/client.js";
import { backfillFlagHistory, flagEvents, historySince, intervalsOf, recordStoreFlags } from "../../src/history/flags.js";
import { analyze, previewRules, type Analysis } from "../../src/rules/index.js";
import { effectiveRuleContext, revertRules, ruleContextWith, updateRules } from "../../src/rule-settings/service.js";
import { openStore, type Store } from "../../src/store/store.js";
import { runBackfill } from "../../src/sync/backfill.js";
import { clientSource } from "../../src/sync/source.js";
import { runSync } from "../../src/sync/sync.js";
import { buildSnapshot, snapshotOptions } from "../../src/views/snapshot.js";

const DAY = 86_400_000;
let dir: string;
let cfg: Config;
let store: Store;
let clock: Clock;
let tPrimary: Date;

const evaluate = (): Analysis => analyze(buildSnapshot(store, snapshotOptions(cfg)), effectiveRuleContext(store, cfg, clock));
const fired = (a: Analysis, pid: number) => a.evaluation.byPid.get(pid)!.fired.map((f) => f.rule).sort();

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "pcs-rules-"));
  cfg = loadConfig({
    ...process.env,
    PCS_DB_PATH: join(dir, "rules.db"),
    PCS_DB_KEY: "rules-integration-key",
    PCS_TIER_TAGS: "junior=junior,reciprocal=reciprocal",
    PCS_NOW: undefined,
  });
  tPrimary = resolveWhen(NOW_PRIMARY, cfg);
  clock = fixedClock(tPrimary);
  await seedScenario(golden, { reset: true });
  store = openStore(cfg);
  const source = clientSource(clientFromConfig(cfg.hotcrp));
  const s = await runSync(store.db, source, { clock, chunkSize: cfg.sync.chunk, concurrency: cfg.sync.concurrency, tierTags: cfg.tierTags, acRole: cfg.acRole });
  expect(s.ok, s.errors.join("; ")).toBe(true);
  const base = recordStoreFlags(store, cfg, clock, { cause: "data", syncRunId: s.runId });
  expect(base.baseline).toBe(true);
  const b = await runBackfill(store.db, source, { clock, rps: 50 });
  expect(b.ok, b.errors.join("; ")).toBe(true);
  backfillFlagHistory(store, cfg, clock);
}, 180_000);

afterAll(() => {
  store?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the env defaults are the golden table", () => {
  it("with no revision, every pid fires exactly FIRES_AT_PRIMARY", () => {
    const a = evaluate();
    for (const [pid, rules] of Object.entries(FIRES_AT_PRIMARY)) expect(fired(a, Number(pid)), `pid ${pid}`).toEqual([...rules].sort());
  });

  it("the baseline holds exactly the golden flags, open at the primary instant", () => {
    expect(historySince(store.db)).toBe(Math.floor(tPrimary.getTime() / 1000) * 1000);
    const open = intervalsOf(flagEvents(store.db)).filter((iv) => iv.cleared === null);
    const got = open.map((iv) => `${iv.pid}:${iv.rule}`).sort();
    const want = Object.entries(FIRES_AT_PRIMARY)
      .flatMap(([pid, rules]) => rules.map((r) => `${pid}:${r}`))
      .sort();
    expect(got).toEqual(want);
  });
});

describe("reconstructed flag history (pcs backfill)", () => {
  const open = () => resolveWhen({ phase: "discussionOpen", day: 0, time: "00:00" }, cfg).getTime();
  const spanOf = (pid: number, rule: string) => intervalsOf(flagEvents(store.db, { pid })).filter((iv) => iv.rule === rule);

  it("pid 5's silent discussion was raised at the first daily point after discussion opened", () => {
    const [iv] = spanOf(5, "SILENT_DISCUSSION");
    expect(iv!.raised.reconstructed).toBe(true);
    expect(iv!.raised.at).toBeGreaterThan(open());
    expect(iv!.raised.at - open()).toBeLessThanOrEqual(DAY);
    expect(iv!.cleared).toBeNull();
  });

  it("pid 6 went quiet about 4 days after its last comment on day +2, and is still quiet", () => {
    const [iv] = spanOf(6, "GONE_QUIET");
    const lastComment = open() + 2 * DAY;
    expect(iv!.raised.reconstructed).toBe(true);
    expect(iv!.raised.at).toBeGreaterThan(lastComment + 4 * DAY - DAY);
    expect(iv!.raised.at).toBeLessThanOrEqual(lastComment + 6 * DAY);
    expect(iv!.cleared).toBeNull();
  });

  it("pid 1 (decided on day +10) had flags that cleared with the decision, not at the baseline", () => {
    const evs = flagEvents(store.db, { pid: 1 });
    for (const iv of intervalsOf(evs)) expect(iv.cleared, iv.rule).not.toBeNull();
  });

  it("never stores a raise while open or a clear while closed after collapsing", () => {
    for (const pid of Object.keys(FIRES_AT_PRIMARY).map(Number)) {
      const byRule = new Map<string, string>();
      for (const e of flagEvents(store.db, { pid })) {
        expect(byRule.get(e.rule) ?? "cleared", `${pid} ${e.rule}`).not.toBe(e.kind);
        byRule.set(e.rule, e.kind);
      }
    }
  });
});

describe(`the override case: ${JSON.stringify(OVERRIDE_CASE.changes)}`, () => {
  let revId = 0;

  it("the preview predicts exactly the documented paper diff", () => {
    const now = evaluate();
    const p = previewRules(now.evaluation, ruleContextWith(cfg, OVERRIDE_CASE.changes, tPrimary.getTime()));
    expect(p.changes.map((c) => ({ pid: c.pid, gained: c.gained, lost: c.lost }))).toEqual(OVERRIDE_CASE.changed);
    expect(p.current.byRule.GONE_QUIET - p.proposed.byRule.GONE_QUIET).toBe(1);
    expect(p.unflagged).toBe(1);
    expect(p.newlyFlagged).toBe(0);
  });

  it("saving it changes exactly the expected golden flags", () => {
    const r = updateRules(store, cfg, OVERRIDE_CASE.changes, { actor: "admin@example.org", atMs: tPrimary.getTime(), note: "golden override case" });
    revId = r.revision.id;
    expect(r.diff).toEqual([{ key: "PCS_THRESH_STALE_DAYS", from: 4, to: 13, fromOverride: false, toOverride: true }]);
    const a = evaluate();
    for (const [pid, rules] of Object.entries(FIRES_AT_PRIMARY)) {
      const want = OVERRIDE_CASE.fires[Number(pid)] ?? rules;
      expect(fired(a, Number(pid)), `pid ${pid}`).toEqual([...want].sort());
    }
    expect(a.evaluation.byPid.get(5)!.fired.find((f) => f.rule === "GONE_QUIET")!.reason).toMatch(/\(limit 13 days\)/);
  });

  it("flag history records the clear with cause 'rules' and the revision id", () => {
    const h = recordStoreFlags(store, cfg, clock, { cause: "rules", revisionId: revId });
    expect(h).toMatchObject({ raised: 0, cleared: 1 });
    const last = flagEvents(store.db, { pid: 6, order: "desc", limit: 1 })[0]!;
    expect(last).toMatchObject({ rule: "GONE_QUIET", kind: "cleared", cause: "rules", revisionId: revId, reconstructed: false });
  });

  it("reverting to the env defaults restores the golden table and re-raises pid 6", () => {
    const r = revertRules(store, cfg, 0, { actor: "admin@example.org", atMs: tPrimary.getTime() });
    expect(r.revision).toMatchObject({ kind: "revert", revertedTo: 0, overrides: {} });
    const h = recordStoreFlags(store, cfg, clock, { cause: "rules", revisionId: r.revision.id });
    expect(h).toMatchObject({ raised: 1, cleared: 0 });
    const a = evaluate();
    for (const [pid, rules] of Object.entries(FIRES_AT_PRIMARY)) expect(fired(a, Number(pid)), `pid ${pid}`).toEqual([...rules].sort());
  });
});
