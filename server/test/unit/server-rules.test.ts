// The rule-settings and flag-history routes via inject(): GET/PUT /api/rules,
// preview, revisions, revert, the cross-origin guard, triage re-ranking
// without HotCRP, flag history after a sync and a rule change, the chair's tag
// writes in the paper history, and `pcs rules` in a subprocess.
// Store: the fake HotCRP smallWorld synced into memory. Synthetic data only.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixedClock } from "../../src/clock.js";
import { loadConfig, type Config } from "../../src/config.js";
import { recordTagWrite } from "../../src/history/chair-actions.js";
import { backfillFlagHistory, recordStoreFlags } from "../../src/history/flags.js";
import { fixedActor } from "../../src/rule-settings/actor.js";
import type { TriageResponse } from "../../src/server/api-types.js";
import { buildApp, type App } from "../../src/server/app.js";
import type {
  FlagHistoryResponse,
  PaperFlagHistoryResponse,
  RevisionsResponse,
  RulesChangeResponse,
  RulesPreviewResponse,
  RulesResponse,
} from "../../src/server/rules-types.js";
import { memoryStore, type Store } from "../../src/store/store.js";
import { runSync } from "../../src/sync/sync.js";
import { RULES_ENV } from "../fixtures/builder.js";
import { BASE_ENV } from "./env.js";
import { smallWorld } from "./fake-source.js";

const NOW = "2030-02-26T12:00";
let cfg: Config;
let store: Store;
let api: App;

beforeAll(async () => {
  cfg = loadConfig({ ...RULES_ENV, PCS_NOW: NOW, PCS_TIER_TAGS: "junior=junior,reciprocal=reciprocal" });
  store = memoryStore();
  const clock = fixedClock(cfg.now!);
  const s = await runSync(store.db, smallWorld(), { clock, chunkSize: 200, concurrency: 2, tierTags: cfg.tierTags, acRole: cfg.acRole });
  expect(s.ok).toBe(true);
  recordStoreFlags(store, cfg, clock, { cause: "data", syncRunId: s.runId });
  backfillFlagHistory(store, cfg, clock);
  api = await buildApp({ cfg, store, clock, webDir: null, actor: fixedActor("admin@example.org") });
});

afterAll(async () => {
  await api.app.close();
  store.close();
});

const req = async <T>(method: "GET" | "PUT" | "POST", url: string, body?: unknown, headers: Record<string, string> = {}) => {
  const r = await api.app.inject({ method, url, payload: body as Record<string, unknown> | undefined, headers });
  return { status: r.statusCode, body: r.json() as T };
};
const triage = async () => (await req<TriageResponse>("GET", "/api/triage")).body;
const rulesOf = (t: TriageResponse, pid: number) => t.papers.find((p) => p.pid === pid)!.reasons.map((r) => r.rule);

describe("GET /api/rules", () => {
  it("lists every rule and setting with effective value, env default, unit, range and phase", async () => {
    const { status, body } = await req<RulesResponse>("GET", "/api/rules");
    expect(status).toBe(200);
    expect(body.revision).toBeNull();
    expect(body.rules.find((r) => r.name === "SPLIT")).toMatchObject({ enabled: true, weight: 3, phase: "any", phaseLabel: "any phase", papers: 1 });
    expect(body.settings.find((s) => s.key === "PCS_THRESH_STALE_DAYS")).toMatchObject({ value: 4, default: 4, overridden: false, unit: "days", min: 0, max: 1_000_000 });
    expect(body.counts.byRule.SPLIT).toBe(1);
  });
});

describe("changing the rules", () => {
  it("previews without saving", async () => {
    const { status, body } = await req<RulesPreviewResponse>("POST", "/api/rules/preview", { changes: { PCS_RULE_SPLIT_ENABLED: false } });
    expect(status).toBe(200);
    expect(body.current.byRule.SPLIT).toBe(1);
    expect(body.proposed.byRule.SPLIT).toBe(0);
    expect(body.changes.map((c) => [c.pid, c.lost])).toEqual([[1, ["SPLIT"]]]);
    expect((await req<RevisionsResponse>("GET", "/api/rules/revisions")).body.revisions).toEqual([]);
    expect(rulesOf(await triage(), 1)).toContain("SPLIT");
  });

  it("rejects invalid values with per-key errors, and cross-origin writes", async () => {
    const bad = await req<{ code: string; errors: { key: string }[] }>("PUT", "/api/rules", { changes: { PCS_THRESH_STALE_DAYS: -2, PCS_NOPE: 1 } });
    expect(bad.status).toBe(400);
    expect(bad.body.errors.map((e) => e.key)).toEqual(["PCS_THRESH_STALE_DAYS", "PCS_NOPE"]);
    expect((await req("POST", "/api/rules/preview", { changes: { PCS_THRESH_STALE_DAYS: "x" } })).status).toBe(400);
    for (const [m, u] of [["PUT", "/api/rules"], ["POST", "/api/rules/preview"], ["POST", "/api/rules/revert"]] as const) {
      expect((await req(m, u, { changes: {} }, { origin: "https://evil.example" })).status, u).toBe(403);
    }
    expect((await req<RevisionsResponse>("GET", "/api/rules/revisions")).body.revisions).toEqual([]);
  });

  let rev1 = 0;
  it("saves a revision, re-ranks triage at once (no HotCRP), and records flag history", async () => {
    const { status, body } = await req<RulesChangeResponse>("PUT", "/api/rules", { changes: { PCS_RULE_SPLIT_ENABLED: false }, note: "trying without SPLIT" });
    expect(status).toBe(200);
    rev1 = body.revision.id;
    expect(body.revision).toMatchObject({ kind: "set", actor: "admin@example.org", note: "trying without SPLIT", at: cfg.now!.getTime() });
    expect(body.history).toEqual({ raised: 0, cleared: 1 });
    expect(body.rules.settings.find((s) => s.key === "PCS_RULE_SPLIT_ENABLED")).toMatchObject({ value: false, default: true, overridden: true });
    expect(rulesOf(await triage(), 1)).not.toContain("SPLIT");
    const meta = (await req<{ rules: { name: string; weight: number }[] }>("GET", "/api/meta")).body;
    expect(meta.rules.find((r) => r.name === "SPLIT")!.weight).toBe(0);
    expect((await req("PUT", "/api/rules", { changes: { PCS_RULE_SPLIT_ENABLED: false } })).status).toBe(409);
  });

  it("lists revisions with their diffs and reverts to the env defaults", async () => {
    await req("PUT", "/api/rules", { changes: { PCS_THRESH_STALE_DAYS: 9 } });
    const revs = (await req<RevisionsResponse>("GET", "/api/rules/revisions")).body.revisions;
    expect(revs.map((r) => [r.id, r.diff.map((d) => `${d.key}:${d.from}->${d.to}`)])).toEqual([
      [rev1 + 1, ["PCS_THRESH_STALE_DAYS:4->9"]],
      [rev1, ["PCS_RULE_SPLIT_ENABLED:true->false"]],
    ]);
    expect((await req("POST", "/api/rules/revert", { to: 77 })).status).toBe(404);
    const back = await req<RulesChangeResponse>("POST", "/api/rules/revert", { to: 0, note: "back to env" });
    expect(back.status).toBe(200);
    expect(back.body.revision).toMatchObject({ kind: "revert", revertedTo: 0, overrideCount: 0 });
    expect(back.body.history.raised).toBe(1);
    expect(rulesOf(await triage(), 1)).toContain("SPLIT");
  });
});

describe("flag history routes", () => {
  it("the feed shows the rule-caused clear and re-raise with their revisions, newest first", async () => {
    recordTagWrite(store.db, { atMs: cfg.now!.getTime(), actor: "admin@example.org", tag: "chair-attention", gain: [1], lose: [] });
    const { body } = await req<FlagHistoryResponse>("GET", "/api/flag-history");
    const split = body.items.filter((i) => i.type === "flag" && i.pid === 1 && i.rule === "SPLIT" && i.cause === "rules");
    expect(split.map((i) => (i.type === "flag" ? [i.kind, i.why] : null))).toEqual([
      ["raised", expect.stringMatching(/^after rule change #\d+$/)],
      ["cleared", `after rule change #${1}`],
    ]);
    expect(body.items.some((i) => i.type === "action" && i.pid === 1 && i.kind === "tag")).toBe(true);
    expect(body.series.ts.length).toBe(body.series.flagged.length);
    expect(body.summary.find((s) => s.rule === "SPLIT")!.open).toBe(1);
    const only = (await req<FlagHistoryResponse>("GET", "/api/flag-history?rule=SPLIT")).body;
    expect(only.rules).toEqual(["SPLIT"]);
    expect(only.items.every((i) => i.type === "flag" && i.rule === "SPLIT")).toBe(true);
    // ?search= needs HotCRP search, which this server has none of.
    expect((await req("GET", "/api/flag-history?search=1")).status).toBe(503);
  });

  it("the paper's spans and tag writes", async () => {
    const { status, body } = await req<PaperFlagHistoryResponse>("GET", "/api/papers/1/flag-history");
    expect(status).toBe(200);
    const split = body.spans.filter((s) => s.rule === "SPLIT");
    expect(split.length).toBeGreaterThanOrEqual(2);
    expect(split.at(-1)).toMatchObject({ clearedAt: null, raisedWhy: expect.stringMatching(/after rule change/) });
    expect(body.actions).toMatchObject([{ kind: "tag", tag: "chair-attention", actor: "admin@example.org" }]);
    expect((await req("GET", "/api/papers/99/flag-history")).status).toBe(404);
    expect((await req("GET", "/api/papers/x/flag-history")).status).toBe(400);
  });
});

describe("pcs rules (subprocess)", { timeout: 180_000 }, () => {
  const CLI = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
  let dir: string;
  let env: Record<string, string>;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "pcs-rules-cli-"));
    // Port 9 (discard) on loopback: the /whoami for the actor fails fast; the change still goes through.
    env = { ...BASE_ENV, PCS_HOTCRP_URL: "http://127.0.0.1:9", PCS_DB_PATH: join(dir, "pcs.db"), PCS_DB_KEY: "cli-unit-key", PCS_NOW: NOW };
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const pcs = (args: string[]) => {
    const r = spawnSync(process.execPath, ["--import", "tsx", CLI, "rules", ...args], { env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8" });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };

  it("show, set, history, revert, and usage errors", () => {
    expect(pcs(["show"]).out).toMatch(/env defaults \(no revisions\)[\s\S]*PCS_THRESH_STALE_DAYS\s+4/);
    const bad = pcs(["set", "THRESH_STALE_DAYS=-1"]);
    expect(bad.code).toBe(2);
    expect(bad.err).toMatch(/PCS_THRESH_STALE_DAYS: expected a number at least 0/);
    expect(pcs(["preview", "THRESH_STALE_DAYS=7"]).out).toMatch(/^flagged papers: 0 -> 0 of 0/);
    const set = pcs(["set", "THRESH_STALE_DAYS=7", "RULE_SPLIT_ENABLED=false", "--note", "a week is fine"]);
    expect(set.code).toBe(0);
    expect(set.out).toContain("saved rule revision #1");
    expect(set.out).toContain("PCS_THRESH_STALE_DAYS: 4 (env default) -> 7");
    expect(pcs(["show", "--json"]).out).toContain('"revision": 1');
    expect(pcs(["set", "THRESH_STALE_DAYS=default"]).code).toBe(0);
    const hist = pcs(["history"]).out;
    expect(hist).toMatch(/#2 .* set\n {2}PCS_THRESH_STALE_DAYS: 7 -> 4 \(env default\)/);
    expect(hist).toMatch(/#1 .* set\s{2}"a week is fine"/);
    expect(pcs(["revert", "defaults"]).out).toContain("saved rule revision #3 (revert to env defaults)");
    expect(pcs(["revert", "defaults"]).code).toBe(1);
    expect(pcs(["frob"]).code).toBe(2);
    expect(pcs(["revert"]).code).toBe(2);
  });
});
