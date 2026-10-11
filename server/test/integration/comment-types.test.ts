// Comment types over the golden scenario (spec §5e): golden -> sync ->
// classify (heuristic, the default) -> the labels expected.ts names, and
// they flow into the AC metrics (pings) and, with the documented
// COMMENT_TYPE_CASE override, into the rules. Relabels are local and
// audited; a re-sync with no changes classifies nothing.
//
// RESETS the harness and seeds golden. Uses a temp DB (never PCS_DB_PATH).
// Never touches the model (tests never download it).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedScenario } from "@pcs/seed/driver";
import { resolveWhen } from "@pcs/seed/time";
import { P, scenario as golden } from "@pcs/seed/scenarios/golden/scenario";
import { COMMENT_TYPE_CASE, FIRES_AT_PRIMARY, NOW_PRIMARY } from "@pcs/seed/scenarios/golden/expected";
import { fixedClock, type Clock } from "../../src/clock.js";
import { loadConfig, type Config } from "../../src/config.js";
import { CommentClassifier } from "../../src/classifier/service.js";
import { effectiveLabels, labelRevisions, relabel } from "../../src/classifier/store.js";
import { clientFromConfig } from "../../src/hotcrp/client.js";
import { analyze, type Analysis } from "../../src/rules/index.js";
import { effectiveRuleContext, revertRules, updateRules } from "../../src/rule-settings/service.js";
import { openStore, type Store } from "../../src/store/store.js";
import { runBackfill } from "../../src/sync/backfill.js";
import { clientSource, type SyncSource } from "../../src/sync/source.js";
import { runSync } from "../../src/sync/sync.js";
import { buildSnapshot, snapshotOptions } from "../../src/views/snapshot.js";

let dir: string;
let cfg: Config;
let store: Store;
let clock: Clock;
let source: SyncSource;
let classifier: CommentClassifier;

const evaluate = (): Analysis => analyze(buildSnapshot(store, snapshotOptions(cfg)), effectiveRuleContext(store, cfg, clock));
const fired = (a: Analysis, pid: number) => a.evaluation.byPid.get(pid)!.fired.map((f) => f.rule).sort();
const sync = () => runSync(store.db, source, { clock, chunkSize: cfg.sync.chunk, concurrency: cfg.sync.concurrency, tierTags: cfg.tierTags, acRole: cfg.acRole });
const acComments = (pid: number, email: string) =>
  store.db.prepare("select cid from comment where pid = ? and email = ? and deleted_seen_at is null order by cid").all(pid, email) as { cid: number }[];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "pcs-ctypes-"));
  cfg = loadConfig({ ...process.env, PCS_DB_PATH: join(dir, "ctypes.db"), PCS_DB_KEY: "ctypes-integration-key", PCS_NOW: undefined, PCS_COMMENT_CLASSIFIER: "heuristic" });
  clock = fixedClock(resolveWhen(NOW_PRIMARY, cfg));
  await seedScenario(golden, { reset: true });
  store = openStore(cfg);
  source = clientSource(clientFromConfig(cfg.hotcrp));
  const s = await sync();
  expect(s.ok, s.errors.join("; ")).toBe(true);
  const b = await runBackfill(store.db, source, { clock, rps: 50 });
  expect(b.ok, b.errors.join("; ")).toBe(true);
  classifier = new CommentClassifier(store, cfg, clock);
}, 180_000);

afterAll(async () => {
  await classifier?.close();
  store?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the heuristic labels golden's comments", () => {
  it("classifies every published comment once; a re-sync with no changes classifies nothing", async () => {
    const n = (store.db.prepare("select count(*) as n from comment where deleted_seen_at is null and draft = 0 and is_response = 0").get() as { n: number }).n;
    expect((await classifier.run()).classified).toBe(n);
    expect((await sync()).ok).toBe(true);
    expect((await classifier.run()).classified).toBe(0);
  });

  it("pid 4's day +3 AC comment is a ping, pid 13's AC comment non-substantive, everything else discussion (expected.ts COMMENT_KINDS)", () => {
    const pingCid = acComments(4, P.acBusy)[1]!.cid;
    const nonsubCid = acComments(13, P.acNormal)[0]!.cid;
    const all = (store.db.prepare("select cid from comment where deleted_seen_at is null and draft = 0 and is_response = 0").all() as { cid: number }[]).map((r) => r.cid);
    const labels = effectiveLabels(store.db, all);
    expect(labels.size).toBe(all.length);
    for (const cid of all) {
      const want = cid === pingCid ? "ping" : cid === nonsubCid ? "nonsubstantive" : "discussion";
      expect(labels.get(cid)!.kind, `cid ${cid}`).toBe(want);
      expect(labels.get(cid)!.source).toBe("heuristic");
    }
  });

  it("the golden table is unchanged (the ignore options default off)", () => {
    const a = evaluate();
    for (const [pid, rules] of Object.entries(FIRES_AT_PRIMARY)) expect(fired(a, Number(pid)), `pid ${pid}`).toEqual([...rules].sort());
  });
});

describe("labels flow into AC metrics", () => {
  const acOf = (a: Analysis, email: string) => a.acs.find((m) => m.email === email)!;

  it("nudges become ping counts, named after the classifier", () => {
    const a = evaluate();
    expect(acOf(a, P.acBusy).nudges).toMatchObject({ source: "heuristic", pings: 1, total: 1 });
    expect(acOf(a, P.acNormal).nudges).toMatchObject({ source: "heuristic", pings: 0, total: 0 });
    // The proxy is still computed alongside: AC-busy's day +1 posts and the @mention.
    expect(acOf(a, P.acBusy).nudges.mentions).toBe(1);
  });

  it("a relabel counts at once, is audited, and clearing it restores the classifier's label", () => {
    const cid = acComments(13, P.acNormal)[0]!.cid;
    const rev = relabel(store.db, { cid, kind: "ping", actor: "admin@example.org", atMs: clock.now().getTime() });
    expect(rev).toMatchObject({ pid: 13, kind: "ping", previous: "nonsubstantive", previousSource: "heuristic" });
    expect(acOf(evaluate(), P.acNormal).nudges).toMatchObject({ pings: 1, total: 1 });
    relabel(store.db, { cid, kind: null, actor: "admin@example.org", atMs: clock.now().getTime() });
    expect(acOf(evaluate(), P.acNormal).nudges.pings).toBe(0);
    expect(labelRevisions(store.db, { cid }).map((r) => r.kind)).toEqual([null, "ping"]);
  });
});

describe(`the comment-type override case: ${JSON.stringify(COMMENT_TYPE_CASE.changes)}`, () => {
  it("pid 13 gains AC_ABSENT, nothing else changes; a relabel to discussion clears it; revert restores golden", () => {
    const r = updateRules(store, cfg, COMMENT_TYPE_CASE.changes, { actor: "admin@example.org", atMs: clock.now().getTime(), note: "comment-type case" });
    const a = evaluate();
    for (const [pid, rules] of Object.entries(FIRES_AT_PRIMARY)) {
      const want = COMMENT_TYPE_CASE.fires[Number(pid)] ?? rules;
      expect(fired(a, Number(pid)), `pid ${pid}`).toEqual([...want].sort());
    }
    expect(a.evaluation.byPid.get(13)!.fired.find((f) => f.rule === "AC_ABSENT")!.reason).toContain(COMMENT_TYPE_CASE.reason.includes);
    // The chair says the comment is substantive after all: the AC has commented.
    const cid = acComments(13, P.acNormal)[0]!.cid;
    relabel(store.db, { cid, kind: "discussion", actor: "admin@example.org", atMs: clock.now().getTime() });
    expect(fired(evaluate(), 13)).toEqual([...FIRES_AT_PRIMARY[13]!].sort());
    relabel(store.db, { cid, kind: null, actor: "admin@example.org", atMs: clock.now().getTime() });
    expect(fired(evaluate(), 13)).toEqual([...COMMENT_TYPE_CASE.fires[13]!].sort());
    revertRules(store, cfg, 0, { actor: "admin@example.org", atMs: clock.now().getTime() });
    expect(r.revision.id).toBeGreaterThan(0);
    const back = evaluate();
    for (const [pid, rules] of Object.entries(FIRES_AT_PRIMARY)) expect(fired(back, Number(pid)), `pid ${pid}`).toEqual([...rules].sort());
  });
});
