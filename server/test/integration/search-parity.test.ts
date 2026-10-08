// Search parity against the harness: the in-app filter (?search=, ?t=, with
// PCS_PAPER_SEARCH) must match exactly the papers HotCRP's own /search does.
// For each query q and collection t from HotCRP's help/search docs
// (src/help/h_keywords.php, h_search.php, h_tags.php):
//
//   filter(q, t)  ==  HotCRP /search(q, t)  ∩  HotCRP /search(scope, t=all)
//
// where the right side is two direct requests with raw fetch (not our
// client, not our query composition). Warnings must agree too: HotCRP warns
// <=> the filter reports warnings. Then every completion the server offers
// must be a search HotCRP accepts without a warning.
// Isolation: MiniSeed (fresh pids, run-unique users, titles and tags).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixedClock } from "../../src/clock.js";
import { loadConfig, type Config } from "../../src/config.js";
import { SEARCH_COLLECTIONS } from "../../src/hotcrp/collections.js";
import { clientFromConfig, type HotcrpClient } from "../../src/hotcrp/client.js";
import { fetchRetrying429 } from "../../src/hotcrp/harness-verify.js";
import type { PaperSearchResponse, SearchCompletionsResponse } from "../../src/server/api-types.js";
import { buildApp, type App } from "../../src/server/app.js";
import { openStore, type Store } from "../../src/store/store.js";
import { clientSource } from "../../src/sync/source.js";
import { runSync } from "../../src/sync/sync.js";
import { MiniSeed } from "../support/mini-seed.js";

let seed: MiniSeed;
let dir: string;
let cfg: Config;
let store: Store;
let client: HotcrpClient;
let api: App;
let P: number;
let run: string;

const scopeTag = () => `par${run}`;
const hot = () => `phot${run}`;
const rank = () => `prank${run}`;

interface Direct {
  ids: number[];
  warnings: string[];
  t: string | null;
}

// This file makes ~200 HotCRP requests; HotCRP allows 250 a minute. When the
// budget runs low, wait for HotCRP's reset so this file (and the next one in
// the run) never sits in 429 backoff.
const LOW_WATER = 100;
let remaining = Infinity;
let resetAt = 0;
async function politely(lowWater = LOW_WATER): Promise<void> {
  if (remaining >= lowWater) return;
  const wait = Math.min(65_000, Math.max(0, resetAt * 1000 - Date.now()) + 500);
  await new Promise((r) => setTimeout(r, wait));
  remaining = Infinity;
}

/** HotCRP's own /search, by hand: no client, no composition. */
async function direct(q: string, t: string): Promise<Direct> {
  const u = new URL(`${seed.url}/api/search`);
  u.searchParams.set("q", q);
  if (t) u.searchParams.set("t", t);
  u.searchParams.set("forceShow", "1");
  await politely();
  const res = await fetchRetrying429(u, { headers: { Authorization: `Bearer ${process.env.PCS_HOTCRP_TOKEN}` } });
  remaining = Number(res.headers.get("x-ratelimit-remaining") ?? Infinity);
  resetAt = Number(res.headers.get("x-ratelimit-reset") ?? 0);
  const j = (await res.json()) as { ok: boolean; ids: number[]; search_params: string; message_list?: { status: number; message?: string }[] };
  expect(j.ok, `${q}: ${JSON.stringify(j)}`).toBe(true);
  return {
    ids: j.ids,
    warnings: (j.message_list ?? []).filter((m) => m.status >= 1).map((m) => m.message ?? ""),
    t: new URLSearchParams(j.search_params).get("t"),
  };
}

const scopeIds = new Map<string, Set<number>>();
async function inScope(): Promise<Set<number>> {
  const hit = scopeIds.get("all");
  if (hit) return hit;
  const ids = new Set((await direct(`#${scopeTag()}`, "all")).ids);
  scopeIds.set("all", ids);
  return ids;
}

async function filtered(q: string, t: string): Promise<{ status: number; body: PaperSearchResponse & { error?: string } }> {
  const qs = new URLSearchParams({ search: q });
  if (t) qs.set("t", t);
  const r = await api.app.inject({ method: "GET", url: `/api/paper-search?${qs.toString()}` });
  return { status: r.statusCode, body: r.json() };
}

async function expectParity(q: string, t = ""): Promise<number[]> {
  const theirs = await direct(q, t);
  const [mine, scope] = await Promise.all([filtered(q, t), inScope()]);
  const label = `q=${JSON.stringify(q)} t=${t || "(default)"}`;
  expect(mine.status, `${label}: ${JSON.stringify(mine.body)}`).toBe(200);
  const want = [...new Set(theirs.ids)].filter((id) => scope.has(id)).sort((a, b) => a - b);
  expect(mine.body.pids, label).toEqual(want);
  expect(mine.body.warnings.length > 0, `${label} warnings: ours ${JSON.stringify(mine.body.warnings)} vs HotCRP ${JSON.stringify(theirs.warnings)}`).toBe(
    theirs.warnings.length > 0,
  );
  expect(mine.body.collection, label).toBe(theirs.t);
  return want;
}

beforeAll(async () => {
  seed = await MiniSeed.create();
  run = seed.run;
  dir = mkdtempSync(join(tmpdir(), "pcs-parity-int-"));
  cfg = loadConfig({
    ...process.env,
    PCS_DB_PATH: join(dir, "parity.db"),
    PCS_DB_KEY: "parity-integration-key",
    PCS_NOW: undefined,
    PCS_TIER_TAGS: "",
    PCS_PAPER_SEARCH: `#${scopeTag()}`,
  });
  store = openStore(cfg);
  client = clientFromConfig(cfg.hotcrp);

  seed.openReviewing();
  seed.saveUsers([
    { key: "ac", first: "Ada", last: `Parity${run}` },
    { key: "r1", first: "Rhea", last: `Parity${run}` },
    { key: "r2", first: "Remy", last: `Parity${run}` },
  ]);
  P = await seed.nextPid();
  // Titles carry the run id so text searches only hit these papers.
  seed.savePapers([
    { pid: P, title: `Flexible kernel scheduling q${run}` },
    { pid: P + 1, title: `Very new storage q${run}` },
    { pid: P + 2, title: `Newest compilers q${run}` },
    { pid: P + 3, title: `Café networking & more q${run}` },
    { pid: P + 4, title: `Plus+percent 100% study q${run}` },
    { pid: P + 5, title: `Out of scope very new q${run}` },
  ]);
  seed.assign([
    [P, "metareview", "ac"],
    [P, "primary", "r1"],
    [P + 1, "primary", "r2"],
    [P + 2, "primary", "r1"],
    [P + 3, "primary", "r2"],
    [P + 5, "primary", "r1"],
  ]);
  seed.tagPapers([
    ...[0, 1, 2, 3, 4].map((i) => [P + i, scopeTag()] as [number, string]),
    [P, hot()],
    [P + 2, hot()],
    [P + 5, hot()],
    [P, `${rank()}#1`],
    [P + 1, `${rank()}#2`],
    [P + 2, `${rank()}#3`],
  ]);
  const csv = (rows: string[]) => seed.php("batch/assign.php", [], `${rows.join("\n")}\n`);
  csv(["paper,action,user", `${P},lead,${seed.email("ac")}`, `${P + 1},shepherd,${seed.email("ac")}`]);
  csv(["paper,action,decision", `${P},decision,Accepted`, `${P + 1},decision,Rejected`]);
  csv(["paper,action", `${P + 4},withdraw`]);
  seed.backdateRequests([P, P + 1, P + 2, P + 3]);
  await seed.submitReview(P, "r1", { OveMer: 4, RevExp: 3, PapSum: "Synthetic.", ComAut: "Synthetic." });
  await seed.submitReview(P + 1, "r2", { OveMer: 2, RevExp: 2, PapSum: "Synthetic.", ComAut: "Synthetic." });
  await seed.submitReview(P + 2, "r1", { OveMer: 5, RevExp: 4, PapSum: "Synthetic.", ComAut: "Synthetic." });
  await seed.comment(P, "ac", "Synthetic discussion.");

  const r = await runSync(store.db, clientSource(client), {
    clock: fixedClock(new Date("2030-02-20T12:00:00Z")),
    chunkSize: cfg.sync.chunk,
    concurrency: 2,
    tierTags: cfg.tierTags,
    acRole: cfg.acRole,
  });
  expect(r.ok, r.errors.join("; ")).toBe(true);
  api = await buildApp({ cfg, store, clock: fixedClock(new Date("2030-02-20T12:00:00Z")), webDir: null, paperSearcher: client, searchCompleter: client });
}, 180_000);

afterAll(async () => {
  // Leave the next file most of the budget.
  await politely(150);
  await api?.app.close();
  store?.close();
  rmSync(dir, { recursive: true, force: true });
}, 70_000);

describe("the filter matches HotCRP's /search exactly (within the scope)", () => {
  // From h_keywords.php / h_search.php / h_tags.php, on this run's papers.
  const queries = (): [string, ...string[]][] => {
    const r1 = seed.email("r1");
    const ac = seed.email("ac");
    return [
      ["all"],
      [`${P}`],
      [`${P}-${P + 2}`],
      [`${P} ${P + 2} ${P + 4} ${P + 5}`],
      [`#${hot()}`],
      [`-#${hot()}`],
      [`NOT #${hot()}`],
      [`#${hot()} OR #${rank()}`],
      [`#${rank()}>1`],
      [`#${rank()}#2`],
      [`#${rank().slice(0, -2)}*`],
      [`ti:flexible ti:q${run}`],
      [`ti:"very new storage"`],
      [`very AND new AND q${run}`],
      [`(very AND new) OR newest`],
      [`very -new q${run}`],
      [`ve* q${run}`],
      [`re:any`],
      [`re:none`],
      [`re:${r1}`],
      [`re:complete>0`],
      [`ovemer:>=4`],
      [`OveMer:<3`],
      [`lead:any`],
      [`lead:${ac}`],
      [`shep:any`],
      [`dec:yes`],
      [`dec:no`],
      [`dec:none`],
      [`status:submitted`],
      [`status:withdrawn`, "all"],
      [`has:lead`],
      [`has:cmt`],
      [`#${hot()} THEN ti:flexible`],
      [`${P} THEN ${P + 1} THEN ${P + 3}`],
      [`#${hot()} HIGHLIGHT ${P}`],
      [`${P}-${P + 4} HIGHLIGHT:green #${hot()}`],
      [`#${hot()} sort:-status show:tags`],
      [`show:OveMer sort:id`],
      [`in:all ti:study`],
      // HotCRP is forgiving about brackets and quotes; so is the filter.
      [`(#${hot()}`],
      [`#${hot()})`],
      [`ti:"very new`],
      [`(${P} OR ${P + 1}`],
      // Characters that must survive URL encoding.
      [`ti:café`],
      [`ti:"café networking"`],
      [`ti:plus+percent`],
      [`ti:100%`],
      [`+ti:flexible`],
      [`#${hot()} && ti:q${run}`],
      [`ti:"networking & more"`],
      [`#${hot()} XOR ${P}`],
      // A search HotCRP warns about: same papers, and a warning.
      [`nosuchkw${run}:x`],
      [`re:nosuchuser${run}@example.org`],
    ];
  };

  it("for every query in the default collection", async () => {
    let nonEmpty = 0;
    for (const [q, t] of queries()) if ((await expectParity(q, t)).length > 0) nonEmpty++;
    // The table must exercise something: most queries match some papers.
    expect(nonEmpty).toBeGreaterThan(30);
  }, 240_000);

  it("in every collection HotCRP offers (Search in)", async () => {
    for (const { t } of SEARCH_COLLECTIONS) {
      await expectParity("", t);
      await expectParity(`#${hot()} OR dec:any`, t);
    }
    // Withdrawn papers: only in t=all.
    expect(await expectParity(`${P + 4}`, "all")).toEqual([P + 4]);
    expect(await expectParity(`${P + 4}`, "s")).toEqual([]);
  }, 240_000);

  it("the default collection is HotCRP's own default for the chair", async () => {
    const d = await direct("NONE", "");
    const r = await filtered(`${P}`, "");
    expect(r.body.collection).toBe(d.t);
    const c = (await api.app.inject({ method: "GET", url: "/api/search-completions" })).json<SearchCompletionsResponse>();
    expect(c.defaultCollection).toBe(d.t);
  });
});

describe("completions", () => {
  let c: SearchCompletionsResponse;
  beforeAll(async () => {
    const r = await api.app.inject({ method: "GET", url: "/api/search-completions" });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.body).not.toContain(process.env.PCS_HOTCRP_TOKEN!);
    c = r.json();
  });

  it("proxies HotCRP's /searchcompletion and ranks this run's tags by in-scope papers", () => {
    expect(c.hotcrp).toBe(true);
    const t = new Map(c.tags.map((x) => [x.tag.toLowerCase(), x]));
    expect(t.get(hot())?.count).toBe(2); // P+5 is out of scope
    expect(t.get(rank())).toMatchObject({ count: 3, values: ["1", "2", "3"] });
    expect(t.has(scopeTag())).toBe(true);
    expect(c.pc.some((p) => p.email === seed.email("r1"))).toBe(true);
    expect(c.values.some((v) => v.text === "dec:Accepted")).toBe(true);
    expect(c.values.some((v) => v.text === "OveMer:>=4")).toBe(true);
    expect(c.values.some((v) => v.text.startsWith("show:"))).toBe(true);
  });

  it("every completion it offers is a search HotCRP accepts without a warning", async () => {
    const all = [
      ...c.values.map((v) => v.text),
      ...c.keywords.flatMap((k) => (k.fixed ?? []).map((f) => `${k.text}${f}`)),
      ...c.tags.slice(0, 20).map((x) => `#${x.tag}`),
      ...c.tags.flatMap((x) => x.values.map((v) => `#${x.tag}#${v}`)).slice(0, 20),
      ...c.pc.slice(0, 10).flatMap((p) => ["re:", "lead:", "shepherd:", "manager:", "pri:", "sec:"].map((k) => `${k}${p.email}`)),
      ...c.operators.map((o) => `${P} ${o.text} ${P + 1}`),
    ];
    expect(all.length).toBeGreaterThan(50);
    // One HotCRP request per 40 terms: OR them together; a bad term warns by name.
    for (let i = 0; i < all.length; i += 40) {
      const chunk = all.slice(i, i + 40);
      const res = await client.search({ q: chunk.map((x) => `(${x})`).join(" OR "), t: "all", keepWarnings: true });
      const warnings = (res.message_list ?? []).filter((m) => m.status >= 1).map((m) => m.message);
      expect(warnings, chunk.join(" | ")).toEqual([]);
    }
  }, 120_000);
});
