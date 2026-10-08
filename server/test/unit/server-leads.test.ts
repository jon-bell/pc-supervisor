// The discussion-lead view (/api/leads, /api/leads/:email) and the
// tiersConfigured flag on /api/meta, via inject() over the fake HotCRP
// smallWorld synced into memory. Synthetic data only.
//
// smallWorld plus a second lead: Ben leads pid 1 (and commented there before
// discussion opened), Eve leads pid 2 (no comment from her yet) and pid 3
// (decided). PCS_NOW 2030-02-26 is in discussion.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixedClock } from "../../src/clock.js";
import { loadConfig, type Config } from "../../src/config.js";
import type { LeadDetailResponse, LeadsResponse, MetaResponse } from "../../src/server/api-types.js";
import { buildApp, type App } from "../../src/server/app.js";
import { memoryStore, type Store } from "../../src/store/store.js";
import { runSync } from "../../src/sync/sync.js";
import { RULES_ENV } from "../fixtures/builder.js";
import { smallWorld, type FakeHotcrp } from "./fake-source.js";

async function serve(world: FakeHotcrp, env: Record<string, string>): Promise<{ api: App; store: Store; cfg: Config }> {
  const cfg = loadConfig({ ...RULES_ENV, PCS_NOW: "2030-02-26T12:00", ...env });
  const store = memoryStore();
  const r = await runSync(store.db, world, {
    clock: fixedClock(new Date("2030-02-14T12:00:00Z")),
    chunkSize: 200,
    concurrency: 2,
    tierTags: cfg.tierTags,
    acRole: cfg.acRole,
  });
  expect(r.ok, r.errors.join("; ")).toBe(true);
  return { api: await buildApp({ cfg, store, clock: fixedClock(cfg.now!), webDir: null }), store, cfg };
}

const json = async <T>(api: App, url: string, status = 200): Promise<T> => {
  const r = await api.app.inject({ method: "GET", url });
  expect(r.statusCode, `${url}: ${r.body}`).toBe(status);
  return r.json() as T;
};

describe("GET /api/leads", () => {
  let s: Awaited<ReturnType<typeof serve>>;
  beforeAll(async () => {
    const w = smallWorld();
    w.leads.push({ pid: 2, email: "eve@example.org" }, { pid: 3, email: "eve@example.org" });
    s = await serve(w, { PCS_TIER_TAGS: "junior=junior,reciprocal=reciprocal" });
  });
  afterAll(async () => {
    await s.api.app.close();
    s.store.close();
  });

  it("has one row per lead, alphabetical, with papers, review progress, comments and flags", async () => {
    const r = await json<LeadsResponse>(s.api, "/api/leads");
    expect(r).toMatchObject({ papers: 3, papersWithLead: 3, maxLoad: 2 });
    expect(r.leads.map((l) => l.person.name)).toEqual(["Ben Area", "Eve Senior"]);
    const [ben, eve] = r.leads;
    expect(ben).toMatchObject({
      pids: [1],
      load: 1,
      // pid 1: Cy and Eve both submitted.
      reviews: { submitted: 2, assigned: 2, complete: 0 },
      // Ben's and Cy's comments, both before discussion opened.
      comments: { total: 2, discussion: 0 },
      leadComments: { total: 1, discussion: 0 },
      commentedPids: [1],
      notYetPids: [],
    });
    expect(ben!.flaggedPids).toEqual([1]);
    expect(eve).toMatchObject({
      pids: [2, 3],
      // pid 2: Dee's draft + Eve's review; pid 3: Eve's.
      reviews: { submitted: 2, assigned: 3, complete: 0 },
      comments: { total: 1, discussion: 0 },
      leadComments: { total: 0, discussion: 0 },
      commentedPids: [],
      notYetPids: [2, 3],
    });
    expect(eve!.activity.daily).toHaveLength(15);
  });

  it("drills down to one lead's papers", async () => {
    const d = await json<LeadDetailResponse>(s.api, "/api/leads/EVE%40example.org");
    expect(d.lead.person.email).toBe("eve@example.org");
    expect(d.reviewsRequired).toBe(s.cfg.reviewsRequired);
    expect(d.papers.map((p) => [p.pid, p.title, p.decision])).toEqual([
      [2, "Paper Two", null],
      [3, "Paper Three", "Accepted"],
    ]);
    expect(d.papers[0]).toMatchObject({
      acs: [{ email: "ben@example.org", name: "Ben Area" }],
      reviews: { submitted: 1, assigned: 2 },
      comments: { total: 1, discussion: 0 },
      leadComments: { total: 0, discussion: 0 },
      leadLastComment: null,
    });
    expect(d.papers[0]!.reasons.map((x) => x.rule)).toContain("MISSING_REVIEWS");
    expect(d.papers[1]!.severity).toBe(0);
  });

  it("404s for someone who leads nothing, 400s for a non-email", async () => {
    await json(s.api, "/api/leads/cy%40example.org", 404);
    await json(s.api, "/api/leads/not-an-email", 400);
  });

  it("meta says tiers are configured", async () => {
    const m = await json<MetaResponse>(s.api, "/api/meta");
    expect(m.tiersConfigured).toBe(true);
    expect(m.tiers).toEqual(["senior", "junior", "reciprocal"]);
  });
});

describe("no leads, no tiers", () => {
  let s: Awaited<ReturnType<typeof serve>>;
  beforeAll(async () => {
    const w = smallWorld();
    w.leads = [];
    s = await serve(w, { PCS_TIER_TAGS: "" });
  });
  afterAll(async () => {
    await s.api.app.close();
    s.store.close();
  });

  it("/api/leads is empty but says how many papers there are (for the empty state)", async () => {
    const r = await json<LeadsResponse>(s.api, "/api/leads");
    expect(r).toEqual({ now: s.cfg.now!.getTime(), maxLoad: 0, papers: 3, papersWithLead: 0, leads: [] });
  });

  it("meta says tiers are not configured (the UI hides tier fields)", async () => {
    const m = await json<MetaResponse>(s.api, "/api/meta");
    expect(m.tiersConfigured).toBe(false);
    expect(m.tiers).toEqual(["senior"]);
  });
});
