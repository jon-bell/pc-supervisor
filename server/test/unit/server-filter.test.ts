// The in-app paper filter (?search=, paper-filter.ts) via inject(), over the
// fake HotCRP smallWorld synced into memory, with a fake /search. Synthetic
// data only. smallWorld: Ben Area chairs 1 and 2; Eve reviews 1, 2 and 3.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fixedClock } from "../../src/clock.js";
import { loadConfig, type Config } from "../../src/config.js";
import { HotcrpError } from "../../src/hotcrp/errors.js";
import type {
  AcsResponse,
  LeadDetailResponse,
  LeadsResponse,
  MetaResponse,
  OverviewResponse,
  PaperSearchResponse,
  PersonResponse,
  ReviewersResponse,
  TriageResponse,
} from "../../src/server/api-types.js";
import { buildApp, type App } from "../../src/server/app.js";
import { CACHE_MS, PaperFilter, type PaperSearcher } from "../../src/server/paper-filter.js";
import { memoryStore, type Store } from "../../src/store/store.js";
import { runSync } from "../../src/sync/sync.js";
import { RULES_ENV } from "../fixtures/builder.js";
import { smallWorld } from "./fake-source.js";

const TOKEN = RULES_ENV.PCS_HOTCRP_TOKEN!;
let cfg: Config;
let store: Store;
let api: App;
let asked: string[] = [];

/** A fake HotCRP /search: "#one" = paper 1, "#two" = 2, "#gone" = 99 (not in the store). */
const searcher: PaperSearcher = {
  search: (async (opts: { q?: string }) => {
    const q = opts.q ?? "";
    asked.push(q);
    if (q === "bad:x") {
      throw new HotcrpError("api", "GET /search", "warnings", {
        messages: [{ status: 1, message: `<5>Unknown search keyword <b>bad</b> (${TOKEN})` }],
      });
    }
    if (q === "#down") throw new HotcrpError("network", "GET /search", `fetch failed for http://127.0.0.1:1/api/search?q=x with ${TOKEN}`);
    const ids = q === "#one" ? [1] : q === "#two" ? [2] : q === "#gone" ? [99, 1] : [];
    return { ok: true, ids, search_params: "t=all" };
  }) as unknown as PaperSearcher["search"],
};

beforeAll(async () => {
  cfg = loadConfig({ ...RULES_ENV, PCS_NOW: "2030-02-26T12:00", PCS_TIER_TAGS: "junior=junior,reciprocal=reciprocal", PCS_PAPER_SEARCH: "#shadow" });
  store = memoryStore();
  const r = await runSync(store.db, smallWorld(), {
    clock: fixedClock(new Date("2030-02-14T12:00:00Z")),
    chunkSize: 200,
    concurrency: 2,
    tierTags: cfg.tierTags,
    acRole: cfg.acRole,
  });
  expect(r.ok).toBe(true);
  api = await buildApp({ cfg, store, clock: fixedClock(cfg.now!), webDir: null, paperSearcher: searcher });
});

beforeEach(() => {
  asked = [];
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
const s = (q: string) => `search=${encodeURIComponent(q)}`;

describe("?search= on the paper-centric routes", () => {
  it("triage lists only the matching papers, facets included", async () => {
    const all = await json<TriageResponse>("/api/triage");
    expect(all.total).toBe(3);
    const t = await json<TriageResponse>(`/api/triage?${s("#one")}`);
    expect(t.total).toBe(1);
    expect(t.papers.map((p) => p.pid)).toEqual([1]);
    expect(t.facets.acs).toEqual([expect.objectContaining({ email: "ben@example.org", papers: 1 })]);
    // Combines with the other filters.
    expect((await json<TriageResponse>(`/api/triage?${s("#one")}&ac=nobody@example.org`)).papers).toEqual([]);
  });

  it("AC rows are computed over the matching papers", async () => {
    const a = await json<AcsResponse>(`/api/acs?${s("#two")}`);
    expect(a.acs.map((x) => [x.person.email, x.pids, x.load])).toEqual([["ben@example.org", [2], 1]]);
    expect(a.maxLoad).toBe(1);
  });

  it("discussion-lead rows and the lead drill-down use the matching papers", async () => {
    // smallWorld: Ben leads pid 1 only.
    const one = await json<LeadsResponse>(`/api/leads?${s("#one")}`);
    expect(one).toMatchObject({ papers: 1, papersWithLead: 1 });
    expect(one.leads.map((x) => [x.person.email, x.pids])).toEqual([["ben@example.org", [1]]]);
    const two = await json<LeadsResponse>(`/api/leads?${s("#two")}`);
    expect(two).toMatchObject({ papers: 1, papersWithLead: 0, leads: [] });
    expect((await json<LeadDetailResponse>(`/api/leads/ben%40example.org?${s("#one")}`)).papers.map((p) => p.pid)).toEqual([1]);
    expect((await get(`/api/leads/ben%40example.org?${s("#two")}`)).statusCode).toBe(404);
    expect((await get(`/api/leads?${s("bad:x")}`)).statusCode).toBe(400);
  });

  it("overview counts only the matching papers", async () => {
    expect((await json<OverviewResponse>("/api/overview")).counts.papers).toBe(3);
    const o = await json<OverviewResponse>(`/api/overview?${s("#one")}`);
    expect(o.counts.papers).toBe(1);
    expect(o.flaggedPerAc.map((x) => x.load)).toEqual([1]);
  });

  it("reviewer lists and the person page see only the matching papers", async () => {
    const r = await json<ReviewersResponse>(`/api/reviewers?${s("#two")}`);
    const emails = new Set(r.lists.flatMap((l) => l.byTier.flatMap((g) => g.entries.flatMap((e) => e.pids))));
    expect([...emails].every((pid) => pid === 2)).toBe(true);
    const eve = await json<PersonResponse>(`/api/people/eve%40example.org?${s("#one")}`);
    expect(eve.papers.map((p) => p.pid)).toEqual([1]);
    expect(eve.reviewer?.assigned).toBe(1);
  });

  it("a search matching nothing in the store gives empty views, not errors", async () => {
    const t = await json<TriageResponse>(`/api/triage?${s("#none")}`);
    expect(t.papers).toEqual([]);
    expect((await json<AcsResponse>(`/api/acs?${s("#none")}`)).acs).toEqual([]);
  });

  it("caches each search briefly: one HotCRP call for several views", async () => {
    const filter = new PaperFilter(searcher);
    await filter.resolve("#two");
    await filter.resolve(" #two ");
    expect(asked).toEqual(["#two"]);
    let wall = 0;
    const timed = new PaperFilter(searcher, [], { now: () => new Date(wall), pinned: true });
    await timed.resolve("#one");
    wall = CACHE_MS - 1;
    await timed.resolve("#one");
    wall = CACHE_MS + 1;
    await timed.resolve("#one");
    expect(asked).toEqual(["#two", "#one", "#one"]);
  });
});

describe("GET /api/paper-search", () => {
  it("resolves a search and says how many matches the store holds", async () => {
    const r = await json<PaperSearchResponse>(`/api/paper-search?${s("#gone")}`);
    expect(r).toEqual({ search: "#gone", scope: "#shadow", pids: [1, 99], inStore: 1 });
  });

  it("an empty search is no filter", async () => {
    expect(await json<PaperSearchResponse>("/api/paper-search")).toEqual({ search: "", scope: "#shadow", pids: null, inStore: null });
    expect(asked).toEqual([]);
  });

  it("meta reports the pinned scope", async () => {
    expect((await json<MetaResponse>("/api/meta")).paperSearch).toBe("#shadow");
  });
});

describe("filter errors are clean", () => {
  it("HotCRP's complaint about the search: 400, tags stripped, token redacted", async () => {
    for (const url of [`/api/paper-search?${s("bad:x")}`, `/api/triage?${s("bad:x")}`, `/api/acs?${s("bad:x")}`]) {
      const r = await get(url);
      expect(r.statusCode).toBe(400);
      const body = r.json() as { error: string };
      expect(body.error).toMatch(/^HotCRP could not use that search: Unknown search keyword bad/);
      expect(r.body).not.toContain(TOKEN);
      expect(r.body).not.toContain("hct_");
      expect(r.body).not.toContain("<b>");
    }
  });

  it("an unbalanced search is refused before asking HotCRP", async () => {
    const r = await get(`/api/triage?${s("#a) OR (#b")}`);
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({ error: "That search has a ) without a matching (." });
    expect(asked).toEqual([]);
  });

  it("HotCRP unreachable: 502 naming the failure kind only", async () => {
    const r = await get(`/api/overview?${s("#down")}`);
    expect(r.statusCode).toBe(502);
    expect(r.json()).toEqual({ error: "Could not run the search on HotCRP (network). Try again, or clear the filter." });
  });

  it("no searcher: 503", async () => {
    const bare = await buildApp({ cfg, store, clock: fixedClock(cfg.now!), webDir: null });
    const r = await bare.app.inject({ method: "GET", url: `/api/triage?${s("#one")}` });
    expect(r.statusCode).toBe(503);
    expect((await bare.app.inject({ method: "GET", url: "/api/triage" })).statusCode).toBe(200);
    await bare.app.close();
  });
});
