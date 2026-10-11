// The Fastify API (server/app.ts) via inject(): routes, filters, sync-now
// concurrency, security headers, and the token never reaching the client.
// Store: the fake HotCRP smallWorld synced into memory. Synthetic data only.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixedClock } from "../../src/clock.js";
import { loadConfig, RULE_NAMES, type Config } from "../../src/config.js";
import type { MetaResponse, PaperDetail, SyncStatus, TriageResponse } from "../../src/server/api-types.js";
import { buildApp, CSP, listRoutes, type App } from "../../src/server/app.js";
import { SyncRunner } from "../../src/server/sync-runner.js";
import { memoryStore, type Store } from "../../src/store/store.js";
import { runSync, type SyncResult } from "../../src/sync/sync.js";
import { RULES_ENV } from "../fixtures/builder.js";
import { smallWorld, type FakeHotcrp } from "./fake-source.js";

const TOKEN = RULES_ENV.PCS_HOTCRP_TOKEN!;
const T1 = new Date("2030-02-14T12:00:00Z");
const NOW = "2030-02-26T12:00";

let cfg: Config;
let hc: FakeHotcrp;
let store: Store;
let gate: (() => void) | undefined;
let api: App;
let webDir: string;

const syncOpts = (at: Date) => ({
  clock: fixedClock(at),
  chunkSize: 200,
  concurrency: 2,
  tierTags: cfg.tierTags,
  acRole: cfg.acRole,
});

beforeAll(async () => {
  cfg = loadConfig({ ...RULES_ENV, PCS_NOW: NOW, PCS_TIER_TAGS: "junior=junior,reciprocal=reciprocal" });
  hc = smallWorld();
  store = memoryStore();
  const first = await runSync(store.db, hc, syncOpts(T1));
  expect(first.ok).toBe(true);
  // A score change seen later, so the drawer has a version history.
  Object.assign(hc.reviewList.find((r) => r.rid === 12)!, { OveMer: 4, version: 7012, modified_at: 1_900_000_500 });
  const sync = new SyncRunner(async (): Promise<SyncResult> => {
    await new Promise<void>((r) => (gate = r));
    return runSync(store.db, hc, syncOpts(new Date("2030-02-20T12:00:00Z")));
  });
  webDir = mkdtempSync(join(tmpdir(), "pcs-web-"));
  writeFileSync(join(webDir, "index.html"), "<!doctype html><title>PC Supervisor</title><div id=root></div>");
  writeFileSync(join(webDir, "app.js"), "console.log(1)");
  api = await buildApp({ cfg, store, clock: fixedClock(cfg.now!), sync, webDir });
});

afterAll(async () => {
  await api.app.close();
  store.close();
  rmSync(webDir, { recursive: true, force: true });
});

const get = (url: string, headers: Record<string, string> = {}) => api.app.inject({ method: "GET", url, headers });
const json = async <T>(url: string): Promise<T> => {
  const r = await get(url);
  expect(r.statusCode, `${url}: ${r.body}`).toBe(200);
  return r.json() as T;
};

describe("GET /api/meta", () => {
  it("has phase, now, the HotCRP base URL for deep links, and every rule", async () => {
    const m = await json<MetaResponse>("/api/meta");
    expect(m).toMatchObject({ now: cfg.now!.getTime(), pinned: true, phase: "discussion", hotcrpUrl: "http://127.0.0.1:8080", tz: "America/New_York" });
    expect(m.rules.map((r) => r.name)).toEqual(RULE_NAMES);
    expect(m.tiers).toEqual(["senior", "junior", "reciprocal"]);
    // Score scales come from the synced review form.
    expect(m.scales.merit).toMatchObject({ uid: cfg.fields.merit, scheme: "sv" });
    expect(m.scales.merit!.labels.length).toBeGreaterThanOrEqual(2);
  });
});

describe("GET /api/triage", () => {
  it("lists every paper in triage order with reasons, AC, scores, tiers", async () => {
    const t = await json<TriageResponse>("/api/triage");
    expect(t.total).toBe(3);
    const sev = t.papers.map((p) => p.severity);
    expect([...sev].sort((a, b) => b - a)).toEqual(sev);
    const p1 = t.papers.find((p) => p.pid === 1)!;
    expect(p1).toMatchObject({
      title: "Paper One",
      acs: [{ email: "ben@example.org", name: "Ben Area", tier: "senior" }],
      merits: [2, 4],
      expertise: [3, 4],
      reviews: { submitted: 2, assigned: 2 },
      tiers: { junior: 1, senior: 1 },
    });
    expect(p1.reasons.map((r) => r.rule)).toContain("SPLIT");
    expect(p1.reasons.find((r) => r.rule === "SPLIT")!.reason).toMatch(/2\/4/);
    // The decided paper fires nothing.
    expect(t.papers.find((p) => p.pid === 3)).toMatchObject({ decision: "Accepted", severity: 0, reasons: [] });
    expect(t.facets.acs).toEqual([{ email: "ben@example.org", name: "Ben Area", tier: "senior", papers: 2 }]);
    expect(t.facets.tiers.map((x) => x.tier)).toEqual(["junior", "reciprocal", "senior"]);
  });

  it("filters by AC, rule and tier", async () => {
    const pids = async (q: string) => (await json<TriageResponse>(`/api/triage?${q}`)).papers.map((p) => p.pid).sort();
    expect(await pids("ac=ben@example.org")).toEqual([1, 2]);
    expect(await pids("ac=BEN@example.org,nobody@example.org")).toEqual([1, 2]);
    expect(await pids("rule=SPLIT")).toEqual([1]);
    expect(await pids("tier=reciprocal")).toEqual([2]);
    expect(await pids("tier=junior,reciprocal")).toEqual([1, 2]);
    expect(await pids("tier=senior&rule=SPLIT")).toEqual([1]);
    expect(await pids("ac=eve@example.org")).toEqual([]);
    const t = await json<TriageResponse>("/api/triage?rule=SPLIT");
    expect(t.total).toBe(3);
  });
});

describe("GET /api/papers/:pid", () => {
  it("returns the drawer: reviews with text, comments with mentions and text, a timeline", async () => {
    const d = await json<PaperDetail>("/api/papers/1");
    expect(d.title).toBe("Paper One");
    const r12 = d.reviews.find((r) => r.rid === 12)!;
    expect(r12).toMatchObject({ ordinal: "A", role: "reviewer", merit: 2, reviewer: { email: "cy@example.org", tier: "junior" } });
    expect(r12.text).toEqual([
      { field: "Paper summary", text: "Short summary here." },
      { field: "Comments for authors", text: "Needs more evaluation work." },
    ]);
    expect(d.reviews.find((r) => r.rid === 11)).toMatchObject({ role: "AC", rtype: 5 });
    const c101 = d.comments.find((c) => c.cid === 101)!;
    expect(c101).toMatchObject({
      role: "AC",
      author: { email: "ben@example.org", name: "Ben Area" },
      mentions: [{ email: "cy@example.org", name: "Cy Junior", tier: "junior" }],
      wordCount: 9,
      text: "@Cy Junior can you say more about the evaluation?",
    });
    expect(d.timeline.map((e) => e.kind)).toEqual(["review", "review", "comment", "comment"]);
    const times = d.timeline.map((e) => e.at);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it("400s on a bad pid and 404s on an unknown one", async () => {
    expect((await get("/api/papers/abc")).statusCode).toBe(400);
    const r = await get("/api/papers/99");
    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual({ error: "no paper #99 in the local store" });
  });
});

describe("sync now", () => {
  it("starts one sync, refuses a concurrent one, and re-ranks when it finishes", async () => {
    const s0 = await json<SyncStatus>("/api/sync/status");
    expect(s0).toMatchObject({ running: false, lastError: null, intervalMin: 15 });
    expect(s0.last).toMatchObject({ ok: true, kind: "sync", nowUsed: T1.getTime() });
    const first = await api.app.inject({ method: "POST", url: "/api/sync" });
    expect(first.statusCode).toBe(202);
    expect(first.json()).toMatchObject({ running: true });
    const second = await api.app.inject({ method: "POST", url: "/api/sync" });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ error: "a sync is already running", running: true });
    while (!gate) await new Promise((r) => setTimeout(r, 5));
    gate();
    // Wait for the in-flight run.
    for (let i = 0; i < 200 && (await json<SyncStatus>("/api/sync/status")).running; i++) await new Promise((r) => setTimeout(r, 5));
    const s1 = await json<SyncStatus>("/api/sync/status");
    expect(s1.running).toBe(false);
    expect(s1.last!.id).toBeGreaterThan(s0.last!.id);
    // The new version is in the drawer (the cache was keyed on the sync run).
    const d = await json<PaperDetail>("/api/papers/1");
    const r12 = d.reviews.find((r) => r.rid === 12)!;
    expect(r12.versions.map((v) => v.merit)).toEqual([2, 4]);
    expect(d.timeline.some((e) => e.kind === "score" && e.rid === 12 && e.from === 2 && e.to === 4)).toBe(true);
  });

  it("answers 503 when the server has no sync runner", async () => {
    const ro = await buildApp({ cfg, store, clock: fixedClock(cfg.now!), webDir: null });
    expect((await ro.app.inject({ method: "POST", url: "/api/sync" })).statusCode).toBe(503);
    await ro.app.close();
  });
});

describe("serving the web app", () => {
  it("serves index.html, assets, and falls back to index.html for client routes", async () => {
    expect((await get("/")).body).toContain("PC Supervisor");
    expect((await get("/app.js")).body).toContain("console.log");
    const deep = await get("/papers/4");
    expect(deep.statusCode).toBe(200);
    expect(deep.headers["content-type"]).toMatch(/text\/html/);
    const api404 = await get("/api/nope");
    expect(api404.statusCode).toBe(404);
    expect(api404.json()).toEqual({ error: "no route GET /api/nope" });
  });

  it("sends a CSP that allows only this origin", async () => {
    for (const url of ["/", "/api/meta", "/api/nope"]) {
      const r = await get(url);
      expect(r.headers["content-security-policy"]).toBe(CSP);
      expect(r.headers["x-content-type-options"]).toBe("nosniff");
    }
    expect(CSP).not.toMatch(/https?:|\*|unsafe/);
    expect((await get("/api/meta")).headers["cache-control"]).toBe("no-store");
  });

  it("refuses a non-loopback Host (DNS rebinding)", async () => {
    const r = await get("/api/meta", { host: "evil.example.com" });
    expect(r.statusCode).toBe(421);
    expect((await get("/api/meta", { host: "127.0.0.1:5317" })).statusCode).toBe(200);
    expect((await get("/api/meta", { host: "localhost:5317" })).statusCode).toBe(200);
  });
});

describe("the token never reaches the client", () => {
  it("appears in no response body or header, including errors", async () => {
    // A failed sync whose error text carries the token (in memory and in sync_run): it must come back redacted.
    const failing = new SyncRunner(async () => ({ runId: 0, ok: false, counts: {}, errors: [`boom Bearer ${TOKEN}`], durationMs: 0 }));
    const leaky = await buildApp({ cfg, store, clock: fixedClock(cfg.now!), sync: failing, webDir });
    await leaky.app.inject({ method: "POST", url: "/api/sync" });
    await failing.current;
    store.db.prepare("insert into sync_run (kind, started_at, finished_at, now_used, ok, errors) values ('sync', 1, 2, 3, 0, ?)").run(
      JSON.stringify([`HotCRP said ${TOKEN}`]),
    );
    const urls = ["/", "/app.js", "/papers/1", "/api/meta", "/api/triage", "/api/triage?rule=SPLIT", "/api/papers/1", "/api/papers/2", "/api/papers/3", "/api/papers/x", "/api/papers/99", "/api/sync/status", "/api/reserve", "/api/quickreject", "/api/nope", `/api/nope?t=${TOKEN}`];
    const responses = [
      ...(await Promise.all(urls.map((url) => leaky.app.inject({ method: "GET", url })))),
      await leaky.app.inject({ method: "POST", url: "/api/sync" }),
      await leaky.app.inject({ method: "DELETE", url: "/api/triage" }),
      await leaky.app.inject({ method: "GET", url: "/api/meta", headers: { host: "evil.example" } }),
    ];
    expect((await leaky.app.inject({ method: "GET", url: "/api/sync/status" })).json()).toMatchObject({ lastError: "boom Bearer [REDACTED]" });
    for (const r of responses) {
      expect(r.body).not.toContain(TOKEN);
      expect(r.body).not.toContain("hct_");
      expect(JSON.stringify(r.headers)).not.toContain(TOKEN);
    }
    await leaky.app.close();
  });
});

describe("SyncRunner", () => {
  it("redacts the secrets it was given from a thrown error", async () => {
    const secret = "plain-secret-value";
    const runner = new SyncRunner(
      async () => {
        throw new Error(`fetch failed for ${secret}`);
      },
      undefined,
      [secret],
    );
    runner.start();
    await runner.current?.catch(() => undefined);
    await new Promise((r) => setImmediate(r));
    expect(runner.lastError).toBe("fetch failed for [REDACTED]");
  });
});

describe("listRoutes", () => {
  it("lists every API route ROUTES registers, without serving", async () => {
    const routes = await listRoutes({ cfg, store, clock: fixedClock(cfg.now!) });
    const keys = routes.map((r) => `${r.method} ${r.url}`);
    for (const k of ["GET /api/meta", "GET /api/papers/:pid", "GET /api/people/:email", "GET /api/reserve", "GET /api/report/export/:file", "POST /api/tags/commit", "POST /api/sync"]) {
      expect(keys).toContain(k);
    }
    expect(routes.every((r) => r.url.startsWith("/api/"))).toBe(true);
  });
});
