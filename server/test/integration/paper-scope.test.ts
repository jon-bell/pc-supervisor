// PCS_PAPER_SEARCH and the in-app ?search= filter against the harness.
//   (a) pinned to a paper tag: the sync stores only those papers, with their
//       reviews, comments and assignments; every other harness paper is absent
//   (b) the composed query keeps HotCRP's pid-list union inside parentheses
//   (c) a paper tagged into scope later is restored with approximate times;
//       one untagged leaves every live read
//   (d) a scope HotCRP warns about fails the sync, changing nothing
//   (e) the filter endpoint and a filtered view, ANDed with the scope; a bad
//       search comes back with HotCRP's warning (as HotCRP shows it), cleaned
// Isolation: MiniSeed (fresh pids, run-unique users and tags). Temp DB.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixedClock } from "../../src/clock.js";
import { loadConfig, type Config } from "../../src/config.js";
import { clientFromConfig, type HotcrpClient } from "../../src/hotcrp/client.js";
import type { PaperSearchResponse, TriageResponse } from "../../src/server/api-types.js";
import { buildApp, type App } from "../../src/server/app.js";
import { openStore, type Store } from "../../src/store/store.js";
import { clientSource } from "../../src/sync/source.js";
import { runSync, type SyncOptions } from "../../src/sync/sync.js";
import { MiniSeed } from "../support/mini-seed.js";

const T1 = new Date("2030-02-14T12:00:00Z");
const T2 = new Date("2030-02-18T12:00:00Z");
const T3 = new Date("2030-02-19T12:00:00Z");
const s = (d: Date) => d.getTime() / 1000;

let seed: MiniSeed;
let dir: string;
let cfg: Config;
let store: Store;
let client: HotcrpClient;
let P: number;
let Q: number;
let R: number;
const rid: Record<string, number> = {};
const cid: Record<string, number> = {};

const scopeTag = () => `scope${seed.run}`;
const hotTag = () => `hot${seed.run}`;

function opts(at: Date): SyncOptions {
  return { clock: fixedClock(at), chunkSize: 2, concurrency: 2, tierTags: { junior: `jr${seed.run}` }, acRole: { kind: "meta" } };
}

const meta = (key: string) => (store.db.prepare("select value from meta where key = ?").get(key) as { value: string } | undefined)?.value;

beforeAll(async () => {
  seed = await MiniSeed.create();
  dir = mkdtempSync(join(tmpdir(), "pcs-scope-int-"));
  cfg = loadConfig({
    ...process.env,
    PCS_DB_PATH: join(dir, "scope.db"),
    PCS_DB_KEY: "scope-integration-key",
    PCS_NOW: undefined,
    PCS_TIER_TAGS: `junior=jr${seed.run}`,
    PCS_PAPER_SEARCH: `#${scopeTag()}`,
  });
  store = openStore(cfg);
  client = clientFromConfig(cfg.hotcrp, { chunkSize: 2 });

  seed.openReviewing();
  const run = seed.run;
  seed.saveUsers([
    { key: "ac", first: "Ada", last: `Scope${run}` },
    { key: "r1", first: "Rhea", last: `Scope${run}`, tags: [`jr${run}`] },
    { key: "r2", first: "Remy", last: `Scope${run}` },
  ]);
  P = await seed.nextPid();
  Q = P + 1;
  R = P + 2;
  seed.savePapers([
    { pid: P, title: `Scope paper P ${run}` },
    { pid: Q, title: `Scope paper Q ${run}` },
    { pid: R, title: `Scope paper R ${run}` },
  ]);
  seed.assign([
    [P, "metareview", "ac"],
    [P, "primary", "r1"],
    [Q, "metareview", "ac"],
    [Q, "primary", "r2"],
    [R, "metareview", "ac"],
    [R, "primary", "r1"],
  ]);
  seed.tagPapers([
    [P, scopeTag()],
    [Q, scopeTag()],
    [P, hotTag()],
    [R, hotTag()],
  ]);
  rid.r1P = await seed.submitReview(P, "r1", { OveMer: 2, RevExp: 3, PapSum: "Thin evaluation.", ComAut: "Add baselines." });
  rid.r2Q = await seed.submitReview(Q, "r2", { OveMer: 4, RevExp: 4, PapSum: "Solid.", ComAut: "Accept." });
  rid.r1R = await seed.submitReview(R, "r1", { OveMer: 3, RevExp: 2, PapSum: "Okay.", ComAut: "Borderline." });
  seed.backdateRequests([P, Q, R]);
  cid.P = await seed.comment(P, "ac", "Any thoughts on the evaluation?");
  cid.R = await seed.comment(R, "ac", "Please discuss.");
}, 120_000);

afterAll(() => {
  store?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("PCS_PAPER_SEARCH against the harness", () => {
  it("(a) syncs only the papers the search matches, with their reviews, comments and assignments", async () => {
    const r = await runSync(store.db, clientSource(client), opts(T1));
    expect(r.ok, r.errors.join("; ")).toBe(true);
    // The harness holds other suites' papers too: none of them may appear.
    expect(store.papers().map((p) => p.pid)).toEqual([P, Q]);
    expect(store.reviews().map((x) => x.pid).every((pid) => pid === P || pid === Q)).toBe(true);
    expect(store.reviews().map((x) => x.rid)).toEqual(expect.arrayContaining([rid.r1P, rid.r2Q]));
    expect(store.reviews().some((x) => x.rid === rid.r1R)).toBe(false);
    expect(store.comments().map((c) => c.cid)).toEqual([cid.P]);
    expect([...new Set(store.assignments().map((a) => a.pid))]).toEqual([P, Q]);
    // Tier tags are still found (the tag query runs on scoped pid lists).
    expect(store.people().find((p) => p.email === seed.email("r1"))?.tier).toBe("junior");
    expect(meta("paper_search")).toBe(`#${scopeTag()}`);
  });

  it("(b) a pid list inside the scope stays a union of papers", async () => {
    const rs = await client.reviews({ q: `${P} ${Q} ${R}`, t: "all" });
    expect([...new Set(rs.map((x) => x.pid))].sort()).toEqual([P, Q]);
    const ids = (await client.search({ q: `${P} ${R}`, t: "all" })).ids;
    expect(ids).toEqual([P]);
  });

  it("(c) tagged into scope -> restored with approximate times; untagged -> gone from every live read", async () => {
    seed.tagPapers([[R, scopeTag()]]);
    seed.php("batch/assign.php", [], `paper,action,tag\n${Q},cleartag,${scopeTag()}\n`);
    const r = await runSync(store.db, clientSource(client), opts(T2));
    expect(r.ok, r.errors.join("; ")).toBe(true);
    expect(store.papers().map((p) => p.pid)).toEqual([P, R]);
    const rv = store.reviews().find((x) => x.rid === rid.r1R)!;
    expect(rv.firstSeenApprox).toBe(true);
    expect(rv.firstSeenAt).toBe(rv.modifiedAt);
    expect(store.comments().find((c) => c.cid === cid.R)?.firstSeenApprox).toBe(true);
    // Q: kept, marked gone, with its review and assignments.
    expect(store.papers({ includeGone: true }).find((p) => p.pid === Q)?.deletedSeenAt).toBe(s(T2));
    expect(store.reviews().some((x) => x.pid === Q)).toBe(false);
    expect(store.reviews({ includeGone: true }).find((x) => x.rid === rid.r2Q)?.deletedSeenAt).toBe(s(T2));
    expect(store.assignments().some((a) => a.pid === Q)).toBe(false);
  });

  it("(d) a scope HotCRP warns about fails the sync and changes nothing", async () => {
    const bad = clientFromConfig({ ...cfg.hotcrp, paperSearch: `nosuchkeyword${seed.run}:x` });
    const before = store.papers().map((p) => p.pid);
    const r = await runSync(store.db, clientSource(bad), opts(T3));
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/search/i);
    expect(store.papers().map((p) => p.pid)).toEqual(before);
    expect(meta("paper_search")).toBe(`#${scopeTag()}`);
  });
});

describe("the in-app filter against the harness", () => {
  let api: App;
  beforeAll(async () => {
    api = await buildApp({ cfg, store, clock: fixedClock(T3), webDir: null, paperSearcher: client });
  });
  afterAll(async () => {
    await api?.app.close();
  });
  const get = (url: string) => api.app.inject({ method: "GET", url });
  const q = (search: string) => new URLSearchParams({ search }).toString();

  it("resolves a search ANDed with the scope", async () => {
    // #hot is on P and R; both are in scope after (c).
    const r = await get(`/api/paper-search?${q(`#${hotTag()}`)}`);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ search: `#${hotTag()}`, t: "", scope: `#${scopeTag()}`, pids: [P, R], inStore: 2, warnings: [] });
    // Q matches the pid but is out of scope: nothing.
    expect((await get(`/api/paper-search?${q(String(Q))}`)).json<PaperSearchResponse>().pids).toEqual([]);
  });

  it("filters a view to the matching papers", async () => {
    const all = (await get("/api/triage")).json<TriageResponse>();
    expect(all.papers.map((p) => p.pid).sort()).toEqual([P, R]);
    const r = await get(`/api/triage?${q(`#${hotTag()} -${R}`)}`);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json<TriageResponse>().papers.map((p) => p.pid)).toEqual([P]);
  });

  it("a search HotCRP warns about: its (empty) answer, with the warning, cleaned", async () => {
    const r = await get(`/api/paper-search?${q(`nosuchkeyword${seed.run}:x`)}`);
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json<PaperSearchResponse>();
    expect(body.pids).toEqual([]);
    expect(body.warnings.join(" ")).toMatch(/Unknown search keyword/);
    expect(r.body).not.toContain(process.env.PCS_HOTCRP_TOKEN!);
    expect(r.body).not.toContain("hct_");
    expect(r.body).not.toContain(cfg.hotcrp.url);
    expect(r.body).not.toContain("<");
    expect((await get(`/api/triage?${q(`nosuchkeyword${seed.run}:x`)}`)).json<TriageResponse>().papers).toEqual([]);
  });
});
