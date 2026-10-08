// GET /api/search-completions (server/search-completions.ts) over the fake
// HotCRP smallWorld synced into memory, with fake /searchcompletion and
// /alltags. Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixedClock } from "../../src/clock.js";
import { loadConfig, type Config } from "../../src/config.js";
import { HotcrpError } from "../../src/hotcrp/errors.js";
import { SEARCH_COLLECTIONS } from "../../src/hotcrp/collections.js";
import type { SearchCompletionsResponse } from "../../src/server/api-types.js";
import { buildApp } from "../../src/server/app.js";
import type { PaperSearcher } from "../../src/server/paper-filter.js";
import { flattenCompletion, quote, type SearchCompleter } from "../../src/server/search-completions.js";
import { memoryStore, type Store } from "../../src/store/store.js";
import { runSync } from "../../src/sync/sync.js";
import { RULES_ENV } from "../fixtures/builder.js";
import { smallWorld } from "./fake-source.js";

const TOKEN = RULES_ENV.PCS_HOTCRP_TOKEN!;
let cfg: Config;
let store: Store;
let calls = 0;

const searcher: PaperSearcher = {
  search: (async () => ({ ok: true, ids: [], search_params: "q=NONE&t=s" })) as unknown as PaperSearcher["search"],
};
const completer: SearchCompleter = {
  searchCompletion: (async () => {
    calls++;
    return {
      ok: true,
      searchcompletion: [
        "has:lead",
        "abstract:{text}",
        "ResDes:{text}",
        { pri: -1, nosort: true, i: ["dec:any", "dec:none"] },
        "dec:Accepted",
        "dec:Rejected",
        "show:#{tag}",
        "show:OveMer",
      ],
    };
  }) as unknown as SearchCompleter["searchCompletion"],
  allTags: (async () => ({ ok: true, tags: ["accept-maybe", "fresh"] })) as unknown as SearchCompleter["allTags"],
};

beforeAll(async () => {
  cfg = loadConfig({ ...RULES_ENV, PCS_NOW: "2030-02-26T12:00", PCS_TIER_TAGS: "junior=junior" });
  store = memoryStore();
  const r = await runSync(store.db, smallWorld(), {
    clock: fixedClock(new Date("2030-02-14T12:00:00Z")),
    chunkSize: 200,
    concurrency: 2,
    tierTags: cfg.tierTags,
    acRole: cfg.acRole,
  });
  expect(r.ok).toBe(true);
  // Tags with values and a twiddle tag (what /search `tags` gives the chair).
  const set = store.db.prepare("update paper set tags = ? where pid = ?");
  set.run(JSON.stringify(["accept-maybe", "order#2", "~mine"]), 1);
  set.run(JSON.stringify(["accept-maybe", "order#1"]), 2);
  set.run(JSON.stringify(["Order#3"]), 3);
});

afterAll(() => store.close());

async function completions(opts: { completer?: SearchCompleter; scope?: string } = {}) {
  const c = opts.scope === undefined ? cfg : loadConfig({ ...RULES_ENV, PCS_NOW: "2030-02-26T12:00", PCS_PAPER_SEARCH: opts.scope });
  const api = await buildApp({ cfg: c, store, clock: fixedClock(c.now!), webDir: null, paperSearcher: searcher, searchCompleter: opts.completer });
  const r = await api.app.inject({ method: "GET", url: "/api/search-completions" });
  await api.app.close();
  expect(r.statusCode, r.body).toBe(200);
  expect(r.body).not.toContain(TOKEN);
  return r.json<SearchCompletionsResponse>();
}

describe("GET /api/search-completions", () => {
  it("tags by how many papers carry them, case-merged, with values; HotCRP-only tags at 0", async () => {
    const r = await completions({ completer });
    expect(r.tags).toEqual([
      { tag: "order", count: 3, values: ["1", "2", "3"] },
      { tag: "accept-maybe", count: 2, values: [] },
      { tag: "~mine", count: 1, values: [] },
      { tag: "fresh", count: 0, values: [] },
    ]);
  });

  it("with PCS_PAPER_SEARCH, tags no in-scope paper has are left out", async () => {
    const r = await completions({ completer, scope: "#shadow" });
    expect(r.tags.map((t) => t.tag)).not.toContain("fresh");
  });

  it("PC members, decisions with counts, score values, HotCRP's own completions merged", async () => {
    const r = await completions({ completer });
    expect(r.pc.map((p) => p.email)).toEqual(["ada@example.org", "ben@example.org", "cy@example.org", "dee@example.org", "eve@example.org"]);
    const v = new Map(r.values.map((x) => [x.text, x]));
    expect(v.get("dec:Accepted")).toMatchObject({ count: 1 });
    expect(v.has("dec:Rejected")).toBe(true);
    expect(v.has("has:lead")).toBe(true);
    expect(v.has("show:OveMer")).toBe(true);
    expect([...v.keys()].some((k) => k.includes("{"))).toBe(false);
    // HotCRP's priority group comes first, as in its own search box.
    expect(r.values.findIndex((x) => x.text === "dec:any")).toBeLessThan(r.values.findIndex((x) => x.text === "dec:Rejected"));
    // Review fields from the store: OveMer is a score field.
    expect(v.has("OveMer:>=4")).toBe(true);
    expect(r.keywords.find((k) => k.text === "OveMer:")?.hint).toMatch(/^score: /);
    // A submission field HotCRP offers becomes a keyword; abstract: is already ab:'s alias.
    expect(r.keywords.find((k) => k.text === "ResDes:")).toBeTruthy();
    expect(r.keywords.filter((k) => k.text === "abstract:")).toEqual([]);
    expect(r.keywords.find((k) => k.text === "re:")).toMatchObject({ values: "pc" });
    expect(r.operators.map((o) => o.text)).toEqual(["OR", "AND", "NOT", "XOR", "THEN", "HIGHLIGHT"]);
    expect(r.collections).toEqual(SEARCH_COLLECTIONS);
    expect(r.defaultCollection).toBe("s");
    expect(r.hotcrp).toBe(true);
  });

  it("HotCRP unreachable: the store's completions still come back, nothing leaks", async () => {
    const down: SearchCompleter = {
      searchCompletion: (async () => {
        throw new HotcrpError("network", "GET /searchcompletion", `fetch failed with ${TOKEN}`);
      }) as unknown as SearchCompleter["searchCompletion"],
      allTags: (async () => {
        throw new HotcrpError("network", "GET /alltags", `fetch failed with ${TOKEN}`);
      }) as unknown as SearchCompleter["allTags"],
    };
    const r = await completions({ completer: down });
    expect(r.hotcrp).toBe(false);
    expect(r.tags[0]).toEqual({ tag: "order", count: 3, values: ["1", "2", "3"] });
    expect(r.values.some((x) => x.text === "dec:Accepted")).toBe(true);
    expect((await completions()).hotcrp).toBe(false);
  });

  it("is cached: one HotCRP call for repeated requests", async () => {
    const api = await buildApp({ cfg, store, clock: fixedClock(cfg.now!), webDir: null, paperSearcher: searcher, searchCompleter: completer });
    const before = calls;
    for (let i = 0; i < 3; i++) expect((await api.app.inject({ method: "GET", url: "/api/search-completions" })).statusCode).toBe(200);
    expect(calls - before).toBe(1);
    await api.app.close();
  });
});

describe("helpers", () => {
  it("flattenCompletion orders groups by pri like HotCRP's script.js", () => {
    expect(flattenCompletion(["b", { pri: -1, i: ["x", "y"] }, "a", { pri: 2, i: "z" }])).toEqual(["x", "y", "b", "a", "z"]);
  });

  it("quote follows SearchWord::quote", () => {
    expect(quote("Accepted")).toBe("Accepted");
    expect(quote("r-ana@example.org")).toBe("r-ana@example.org");
    expect(quote("Major revision")).toBe('"Major revision"');
    expect(quote('say "hi"')).toBe('"say \\"hi\\""');
    expect(quote("")).toBe("");
  });
});
