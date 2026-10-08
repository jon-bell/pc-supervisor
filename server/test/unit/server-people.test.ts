// PLAN M6 API via inject(): /api/acs, /api/reviewers, /api/people/:email,
// /api/overview over the fake HotCRP smallWorld synced into memory, and the
// token never reaching the client. Synthetic data only.
//
// smallWorld at PCS_NOW 2030-02-26 (discussion): Ben Area chairs 1 and 2 and
// commented on both before discussion opened; pid 1 is split 2/4 (Cy junior,
// Eve senior), pid 2 has Dee's (reciprocal) review still a draft, pid 3 is
// decided. Ben's pid 2 comment @mentions Dee and Eve, who never reply.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixedClock } from "../../src/clock.js";
import { loadConfig, type Config } from "../../src/config.js";
import type { AcsResponse, OverviewResponse, PersonResponse, ReviewersResponse } from "../../src/server/api-types.js";
import { buildApp, type App } from "../../src/server/app.js";
import { SyncRunner } from "../../src/server/sync-runner.js";
import { memoryStore, type Store } from "../../src/store/store.js";
import { runSync } from "../../src/sync/sync.js";
import { RULES_ENV } from "../fixtures/builder.js";
import { smallWorld } from "./fake-source.js";

const TOKEN = RULES_ENV.PCS_HOTCRP_TOKEN!;
let cfg: Config;
let store: Store;
let api: App;

beforeAll(async () => {
  cfg = loadConfig({ ...RULES_ENV, PCS_NOW: "2030-02-26T12:00", PCS_TIER_TAGS: "junior=junior,reciprocal=reciprocal" });
  store = memoryStore();
  const r = await runSync(store.db, smallWorld(), {
    clock: fixedClock(new Date("2030-02-14T12:00:00Z")),
    chunkSize: 200,
    concurrency: 2,
    tierTags: cfg.tierTags,
    acRole: cfg.acRole,
  });
  expect(r.ok).toBe(true);
  api = await buildApp({ cfg, store, clock: fixedClock(cfg.now!), webDir: null });
});

afterAll(async () => {
  await api.app.close();
  store.close();
});

const get = (url: string) => api.app.inject({ method: "GET", url });
const json = async <T>(url: string): Promise<T> => {
  const r = await get(url);
  expect(r.statusCode, `${url}: ${r.body}`).toBe(200);
  return r.json() as T;
};

describe("GET /api/acs", () => {
  it("has one row per AC with load vs flagged, coverage, nudges, metareviews and a sparkline", async () => {
    const a = await json<AcsResponse>("/api/acs");
    expect(a.acs.map((x) => x.person.email)).toEqual(["ben@example.org"]);
    expect(a.maxLoad).toBe(2);
    const ben = a.acs[0]!;
    expect(ben).toMatchObject({
      person: { name: "Ben Area", tier: "senior" },
      pids: [1, 2],
      load: 2,
      // Both his comments predate discussion: no coverage, no discussion
      // comments, but the Comments count still shows them (chair feedback).
      coverage: { covered: 0, of: 2, share: 0 },
      comments: 2,
      discussionComments: 0,
      nudges: { total: 0, mentions: 0, proxy: 0 },
      metareview: { byStatus: { empty: 2 }, submitted: 0, of: 2, due: cfg.phases.decisionsDue.getTime() },
    });
    expect(ben.flagged).toBe(ben.flaggedPids.length);
    expect(ben.flaggedPids).toEqual(expect.arrayContaining([1, 2]));
    // Day buckets from DISCUSSION_OPEN to now (14.5 days -> 15 buckets), all zero.
    expect(ben.activity.start).toBe(cfg.phases.discussionOpen.getTime());
    expect(ben.activity.daily).toHaveLength(15);
    expect(ben.activity.daily.every((n) => n === 0)).toBe(true);
  });
});

describe("GET /api/reviewers", () => {
  it("returns the five outlier lists, each split by every configured tier", async () => {
    const r = await json<ReviewersResponse>("/api/reviewers");
    expect(r.tiers).toEqual(["senior", "junior", "reciprocal"]);
    expect(r.lists.map((l) => l.id)).toEqual(["silentOnSplit", "unansweredPings", "late", "thin", "flagged"]);
    for (const l of r.lists) {
      expect(l.byTier.map((g) => g.tier)).toEqual(r.tiers);
      expect(l.total).toBe(l.byTier.reduce((n, g) => n + g.entries.length, 0));
      expect(l.bar).toMatch(/^at least \d+ /);
    }
    const list = (id: string) => Object.fromEntries(r.lists.find((l) => l.id === id)!.byTier.map((g) => [g.tier, g.entries.map((e) => e.person.email)]));
    // Pid 1 is split; neither reviewer has commented since discussion opened.
    expect(list("silentOnSplit")).toEqual({ senior: ["eve@example.org"], junior: ["cy@example.org"], reciprocal: [] });
    // Dee's pid 2 review is a draft after the deadline.
    expect(list("late")).toEqual({ senior: [], junior: [], reciprocal: ["dee@example.org"] });
    const late = r.lists.find((l) => l.id === "late")!.byTier[2]!.entries[0]!;
    expect(late).toMatchObject({ count: 1, pids: [2], detail: "1 review not submitted after the deadline" });
    // Ben's @mention on pid 2 is unanswered by Dee and Eve; his AC comment on pid 1 pings Eve there too.
    expect(list("unansweredPings")).toEqual({ senior: ["eve@example.org"], junior: [], reciprocal: ["dee@example.org"] });
    expect(r.lists.find((l) => l.id === "unansweredPings")!.byTier[0]!.entries[0]!.detail).toMatch(/^2 papers with an unanswered ping; oldest \d+\.\d days$/);
  });
});

describe("GET /api/people/:email", () => {
  it("shows every paper with their score, last comment and open pings", async () => {
    const p = await json<PersonResponse>("/api/people/cy%40example.org");
    expect(p.person).toMatchObject({ email: "cy@example.org", name: "Cy Junior", tier: "junior" });
    expect(p.ac).toBeNull();
    // Their 5-word review is under the word minimum.
    expect(p.outliers).toEqual(["silentOnSplit", "thin"]);
    expect(p.papers).toHaveLength(1);
    expect(p.papers[0]).toMatchObject({
      pid: 1,
      role: "reviewer",
      review: { rid: 12, status: "complete", submitted: true, merit: 2, expertise: 3 },
      merits: [2, 4],
      comments: 1,
      discussionComments: 0,
      lastComment: { cid: 102, wordCount: 5, excerpt: "Sure, the baselines are weak." },
      flags: { silentOnSplit: true, outstanding: false, thin: true, unansweredPing: false },
    });
    expect(p.papers[0]!.rules).toContain("SPLIT");
    // Cy replied to Ben's mention, so nothing is open.
    expect(p.openPings).toEqual([]);
  });

  it("lists open pings with their age, and AC papers with the AC row", async () => {
    const dee = await json<PersonResponse>("/api/people/DEE@example.org");
    expect(dee.person.tier).toBe("reciprocal");
    expect(dee.reviewer).toMatchObject({ assigned: 1, submitted: 0, outstanding: [2], late: true });
    expect(dee.openPings).toHaveLength(1);
    expect(dee.openPings[0]).toMatchObject({ pid: 2, title: "Paper Two", pings: 1, overThreshold: true });
    expect(dee.openPings[0]!.ageDays).toBeGreaterThan(dee.pingDays);
    expect(dee.papers[0]).toMatchObject({ pid: 2, review: { status: "draft", submitted: false }, flags: { outstanding: true, unansweredPing: true } });

    const ben = await json<PersonResponse>("/api/people/ben%40example.org");
    expect(ben.reviewer).toBeNull();
    expect(ben.ac).toMatchObject({ load: 2, pids: [1, 2] });
    expect(ben.papers.map((x) => [x.pid, x.role])).toEqual([
      [1, "AC"],
      [2, "AC"],
    ]);
    expect(ben.papers[0]!.review).toMatchObject({ rid: 11, status: "empty" });
  });

  it("400s on a non-email and 404s on an unknown person", async () => {
    expect((await get("/api/people/not-an-email")).statusCode).toBe(400);
    const r = await get("/api/people/nobody%40example.org");
    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual({ error: "no such person in the local store" });
  });
});

describe("GET /api/overview", () => {
  it("has counts by stage, the spread histogram, flagged per AC and the burndown against phase dates", async () => {
    const o = await json<OverviewResponse>("/api/overview");
    expect(o.phase).toBe("discussion");
    expect(o.phases.map((p) => p.key)).toEqual(["reviewDue", "responseOpen", "responseClose", "discussionOpen", "discussionClose", "decisionsDue"]);
    expect(o.counts).toMatchObject({ papers: 3, decided: 1, noConsensus: 1 });
    expect(o.counts.reviewing + o.counts.discussing + o.counts.decided).toBe(3);
    // Pid 1 is the only paper with two merits: range 2, split.
    expect(o.spread).toEqual([
      { range: 0, papers: 0, split: false },
      { range: 1, papers: 0, split: false },
      { range: 2, papers: 1, split: true },
    ]);
    expect(o.spreadUnknown).toBe(2);
    expect(o.flaggedPerAc).toEqual([{ person: { email: "ben@example.org", name: "Ben Area", tier: "senior" }, load: 2, flagged: expect.any(Number) }]);
    // Daily from REVIEW_DUE to now, ending at now.
    expect(o.burndown[0]!.t).toBe(cfg.phases.reviewDue.getTime());
    expect(o.burndown.at(-1)!.t).toBe(cfg.now!.getTime());
    expect(o.burndown.at(-1)!.noConsensus).toBe(o.counts.noConsensus);
  });
});

describe("the token never reaches the client (M6 routes)", () => {
  it("appears in no response body or header", async () => {
    const leaky = await buildApp({ cfg, store, clock: fixedClock(cfg.now!), sync: new SyncRunner(async () => ({ runId: 0, ok: false, counts: {}, errors: [`x ${TOKEN}`], durationMs: 0 })), webDir: null });
    const urls = [
      "/api/acs",
      "/api/reviewers",
      "/api/overview",
      "/api/people/ben%40example.org",
      "/api/people/cy%40example.org",
      "/api/people/dee%40example.org",
      "/api/people/nobody%40example.org",
      "/api/people/x",
      `/api/people/${TOKEN}`,
    ];
    for (const url of urls) {
      const r = await leaky.app.inject({ method: "GET", url });
      expect(r.body, url).not.toContain(TOKEN);
      expect(r.body, url).not.toContain("hct_");
      expect(JSON.stringify(r.headers), url).not.toContain(TOKEN);
    }
    await leaky.app.close();
  });
});
