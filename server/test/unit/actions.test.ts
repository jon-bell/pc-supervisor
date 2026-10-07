// PLAN M8 v1 actions: the dry-run/confirm state machine (actions/tagging.ts),
// the tag routes over a HotcrpClient with a fake fetch, nudge drafts,
// copyable searches, and the token never reaching the client.
// Synthetic data only (example.org); no network.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nudgeDraft } from "../../src/actions/nudge.js";
import { hotcrpPidSearch, hotcrpSearchUrl } from "../../src/actions/search.js";
import { TagFlow, TagFlowError, type TagWriter } from "../../src/actions/tagging.js";
import { fixedClock } from "../../src/clock.js";
import { loadConfig, type Config } from "../../src/config.js";
import { HotcrpClient } from "../../src/hotcrp/client.js";
import type { TagChange, TagDiff } from "../../src/hotcrp/tag-assign.js";
import { analyze } from "../../src/rules/index.js";
import type { ActionsInfo, NudgeResponse, TagCommitResponse, TagPreviewResponse } from "../../src/server/action-types.js";
import { buildApp, type App } from "../../src/server/app.js";
import { allowedOrigins } from "../../src/server/routes/actions.js";
import { SyncRunner } from "../../src/server/sync-runner.js";
import { memoryStore, type Store } from "../../src/store/store.js";
import { runSync } from "../../src/sync/sync.js";
import { contextAt, RULES_ENV } from "../fixtures/builder.js";
import { E, GOLDEN_NOW, goldenSnapshot } from "../fixtures/golden.js";
import { smallWorld } from "./fake-source.js";

const TAG = "chair-attention";
const TOKEN = RULES_ENV.PCS_HOTCRP_TOKEN!;

/** A fake HotCRP holding paper tags: dry runs report the diff, writes apply it. */
class FakeTags implements TagWriter {
  tagged = new Set<number>();
  calls: { changes: TagChange[]; dryRun: boolean; allowWrites: boolean }[] = [];
  async assignTags(changes: readonly TagChange[], tag: string, opts: { dryRun: true } | { dryRun: false; allowWrites: true }): Promise<TagDiff> {
    expect(tag).toBe(TAG);
    const allowWrites = !opts.dryRun && opts.allowWrites;
    this.calls.push({ changes: [...changes], dryRun: opts.dryRun, allowWrites });
    const gain = changes.filter((c) => c.op === "add" && !this.tagged.has(c.pid)).map((c) => c.pid);
    const lose = changes.filter((c) => c.op === "remove" && this.tagged.has(c.pid)).map((c) => c.pid);
    if (!opts.dryRun) {
      if (!allowWrites) throw new Error("write without allowWrites");
      for (const p of gain) this.tagged.add(p);
      for (const p of lose) this.tagged.delete(p);
    }
    return { gain: gain.sort((a, b) => a - b), lose: lose.sort((a, b) => a - b) };
  }
  get writes() {
    return this.calls.filter((c) => !c.dryRun);
  }
}

function flow(over: Partial<ConstructorParameters<typeof TagFlow>[0]> = {}) {
  const hc = new FakeTags();
  let t = 1000;
  let n = 0;
  const f = new TagFlow({ writer: hc, tag: TAG, ttlMs: 60_000, monotonic: () => t, newToken: () => `tok${++n}`, ...over });
  return { f, hc, advance: (ms: number) => (t += ms) };
}

async function rejected(p: Promise<unknown>): Promise<TagFlowError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof TagFlowError) return e;
    throw e;
  }
  throw new Error("expected a TagFlowError");
}

describe("TagFlow: dry run, then a single-use, short-lived, exact confirmation", () => {
  it("preview dry-runs and issues a token for exactly HotCRP's diff; commit re-checks, then writes with allowWrites", async () => {
    const { f, hc } = flow();
    hc.tagged.add(3);
    hc.tagged.add(7);
    const p = await f.preview({ add: [5, 3, 4], remove: [7, 9] });
    expect(p).toEqual({ tag: TAG, token: "tok1", gain: [4, 5], lose: [7], unchanged: [3, 9], expiresInMs: 60_000 });
    expect(hc.calls).toHaveLength(1);
    expect(hc.calls[0]!.dryRun).toBe(true);
    expect([...hc.tagged].sort()).toEqual([3, 7]);

    const done = await f.commit({ token: "tok1", gain: [5, 4], lose: [7], confirm: TAG });
    expect(done).toEqual({ gain: [4, 5], lose: [7] });
    // Dry run again (unchanged), then the write, which carries only the previewed diff.
    expect(hc.calls.map((c) => [c.dryRun, c.allowWrites])).toEqual([
      [true, false],
      [true, false],
      [false, true],
    ]);
    expect(hc.writes[0]!.changes).toEqual([
      { pid: 4, op: "add" },
      { pid: 5, op: "add" },
      { pid: 7, op: "remove" },
    ]);
    expect([...hc.tagged].sort()).toEqual([3, 4, 5]);
    expect(f.pendingCount).toBe(0);
  });

  it("an empty diff issues no token", async () => {
    const { f, hc } = flow();
    hc.tagged.add(2);
    expect(await f.preview({ add: [2], remove: [8] })).toMatchObject({ token: null, gain: [], lose: [], unchanged: [2, 8] });
    expect(f.pendingCount).toBe(0);
  });

  it("a token works once", async () => {
    const { f, hc } = flow();
    await f.preview({ add: [1] });
    await f.commit({ token: "tok1", gain: [1], lose: [], confirm: TAG });
    const e = await rejected(f.commit({ token: "tok1", gain: [1], lose: [], confirm: TAG }));
    expect([e.code, e.status]).toEqual(["unknown_token", 409]);
    expect(hc.writes).toHaveLength(1);
  });

  it("rejects unknown, missing and expired tokens, and consumes an expired one", async () => {
    const { f, hc, advance } = flow();
    expect((await rejected(f.commit({ token: "never-issued", gain: [1], lose: [], confirm: TAG }))).code).toBe("unknown_token");
    expect((await rejected(f.commit({ gain: [1], lose: [], confirm: TAG }))).code).toBe("invalid");
    await f.preview({ add: [1] });
    advance(60_001);
    const e = await rejected(f.commit({ token: "tok1", gain: [1], lose: [], confirm: TAG }));
    expect([e.code, e.status]).toEqual(["expired", 410]);
    expect((await rejected(f.commit({ token: "tok1", gain: [1], lose: [], confirm: TAG }))).code).toBe("unknown_token");
    expect(hc.writes).toHaveLength(0);
  });

  it("expiry runs on the monotonic clock, not PCS_NOW: within the TTL it still works", async () => {
    const { f, advance } = flow();
    await f.preview({ add: [1] });
    advance(59_000);
    await expect(f.commit({ token: "tok1", gain: [1], lose: [], confirm: TAG })).resolves.toEqual({ gain: [1], lose: [] });
  });

  it("rejects a commit whose sets differ from the preview, and burns the token", async () => {
    const { f, hc } = flow();
    for (const bad of [
      { gain: [1, 2], lose: [] },
      { gain: [1], lose: [3] },
      { gain: [], lose: [1] },
      { gain: "1", lose: [] },
      { gain: [1.5], lose: [] },
    ]) {
      const { token } = await f.preview({ add: [1] });
      const e = await rejected(f.commit({ token, ...bad, confirm: TAG }));
      expect(e.code, JSON.stringify(bad)).toBe("mismatch");
      expect((await rejected(f.commit({ token, gain: [1], lose: [], confirm: TAG }))).code).toBe("unknown_token");
    }
    expect(hc.writes).toHaveLength(0);
  });

  it("requires the tag name typed out", async () => {
    const { f, hc } = flow();
    for (const confirm of [undefined, true, "yes", "Chair-Attention ", `#${TAG}`]) {
      const { token } = await f.preview({ add: [1] });
      expect((await rejected(f.commit({ token, gain: [1], lose: [], confirm }))).code).toBe("not_confirmed");
    }
    expect(hc.writes).toHaveLength(0);
  });

  it("refuses to write when HotCRP changed since the preview", async () => {
    const { f, hc } = flow();
    await f.preview({ add: [1, 2] });
    hc.tagged.add(2); // someone tagged #2 in HotCRP meanwhile
    const e = await rejected(f.commit({ token: "tok1", gain: [1, 2], lose: [], confirm: TAG }));
    expect([e.code, e.status]).toEqual(["stale", 409]);
    expect(hc.writes).toHaveLength(0);
  });

  it("validates preview requests", async () => {
    const { f, hc } = flow({ maxPids: 3 });
    for (const bad of [{}, { add: [] }, { add: "1" }, { add: [0] }, { add: [-1] }, { add: [1.5] }, { add: [1], remove: [1] }, { add: [1, 2, 3, 4] }]) {
      expect((await rejected(f.preview(bad))).code, JSON.stringify(bad)).toBe("invalid");
    }
    expect(hc.calls).toHaveLength(0);
  });

  it("keeps a bounded number of pending previews (oldest dropped)", async () => {
    const { f } = flow({ maxPending: 2 });
    await f.preview({ add: [1] });
    await f.preview({ add: [2] });
    await f.preview({ add: [3] });
    expect(f.pendingCount).toBe(2);
    expect((await rejected(f.commit({ token: "tok1", gain: [1], lose: [], confirm: TAG }))).code).toBe("unknown_token");
    await expect(f.commit({ token: "tok3", gain: [3], lose: [], confirm: TAG })).resolves.toEqual({ gain: [3], lose: [] });
  });

  it("concurrent commits with one token: exactly one writes", async () => {
    const { f, hc } = flow();
    await f.preview({ add: [1] });
    const rs = await Promise.allSettled([1, 2, 3].map(() => f.commit({ token: "tok1", gain: [1], lose: [], confirm: TAG })));
    expect(rs.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(hc.writes).toHaveLength(1);
  });

  it("default tokens are long and random", async () => {
    const hc = new FakeTags();
    const f = new TagFlow({ writer: hc, tag: TAG });
    const a = (await f.preview({ add: [1] })).token!;
    const b = (await f.preview({ add: [2] })).token!;
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });
});

describe("copyable HotCRP searches", () => {
  it("collapses consecutive pids into ranges", () => {
    expect(hotcrpPidSearch([12, 4, 5])).toBe("4 5 12");
    expect(hotcrpPidSearch([9, 2, 3, 4, 12, 11, 11])).toBe("2-4 9 11 12");
    expect(hotcrpPidSearch([1, 2, 3, 4, 5, 7, 8, 9, 20])).toBe("1-5 7-9 20");
    expect(hotcrpPidSearch([])).toBe("");
    expect(hotcrpSearchUrl("http://127.0.0.1:8080/", "2-4 9")).toBe("http://127.0.0.1:8080/search?q=2-4+9&t=all");
  });
});

describe("nudge drafts (golden fixture)", () => {
  const ctx = contextAt(GOLDEN_NOW);
  const a = analyze(goldenSnapshot(), ctx);
  const people = a.evaluation.index.people;
  const draft = (pid: number) => nudgeDraft(a.evaluation.facts.get(pid)!, a.evaluation.byPid.get(pid)!, people, ctx);

  it("a split paper @mentions the reviewers with no comments since discussion opened, with the reasons", () => {
    const d = draft(4);
    expect(d.audience).toBe("reviewers-without-comments");
    expect(d.mentions.map((m) => m.email)).toEqual([E.silent, E.pinged]);
    expect(d.text.split("\n")[0]).toBe("@Sam Silvermoon @Pat Pingleton");
    expect(d.text).toContain("- Scores are split: merit 2/4/4 (range 2 >= 2; scores on both sides of 3)");
    expect(d.text).toContain("- No score movement yet: scores 2/4/4; no movement since discussion opened 14.5 days ago (limit 5 days)");
    expect(d.text).toMatch(/could you add a comment with your current view\?/);
    expect(d.text.trim().endsWith("Thank you!")).toBe(true);
  });

  it("missing reviews @mention the reviewer whose review isn't submitted", () => {
    const d = draft(2);
    expect(d.audience).toBe("unsubmitted-reviewers");
    expect(d.mentions.map((m) => m.email)).toEqual([E.recip]);
    expect(d.text).toMatch(/^@Remy Reciprocca\n/);
    expect(d.text).toContain("Could you submit your review when you can");
  });

  it("a silent paper with no AC comment @mentions the reviewers and the AC", () => {
    const d = draft(5);
    expect(d.mentions.map((m) => m.email)).toEqual([E.dee, E.fay, E.gus, E.acIdle]);
    expect(d.text).toContain("@Indra Idleworth, could you also post a short summary");
  });

  it("AC-only rules go to the AC", () => {
    expect(draft(7)).toMatchObject({ audience: "acs", mentions: [{ email: E.acIdle }] });
    expect(draft(9)).toMatchObject({ audience: "acs", mentions: [{ email: E.acBusy }] });
  });

  it("an unanswered author response asks about the response", () => {
    expect(draft(11).text).toContain("whether the other reviews and the author response change your assessment");
  });

  it("follows the spec §7 wording: no judgments of people", () => {
    for (const pid of [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
      expect(draft(pid).text).not.toMatch(/disengaged|absent\b|lazy|inactive|failed to|ranking/i);
    }
  });
});

// ---------------------------------------------------------------------------
// The routes, over the real HotcrpClient with a fake HotCRP fetch.

interface FakeAssign {
  tagged: Set<number>;
  requests: { url: URL; body: unknown }[];
  /** Make the next response an HTTP error whose message carries the token. */
  failNext: boolean;
}

function fakeHotcrpFetch(state: FakeAssign): typeof globalThis.fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = JSON.parse(String(init?.body ?? "[]")) as { pid: number; action: string; tag: string }[];
    state.requests.push({ url, body });
    if (url.pathname !== "/api/assign") return new Response("{}", { status: 404 });
    if (state.failNext) {
      state.failNext = false;
      return new Response(JSON.stringify({ ok: false, message_list: [{ status: 2, message: `<0>bad token ${TOKEN}` }] }), { status: 400 });
    }
    const dry = url.searchParams.get("dry_run") === "1";
    const rows = body.filter((r) => (r.action === "tag" ? !state.tagged.has(r.pid) : state.tagged.has(r.pid)));
    if (!dry) {
      for (const r of rows) {
        if (r.action === "tag") state.tagged.add(r.pid);
        else state.tagged.delete(r.pid);
      }
    }
    return new Response(JSON.stringify({ ok: true, ...(dry ? { dry_run: true } : {}), valid: true, assignment_count: rows.length, assignments: rows }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
}

describe("tag routes", () => {
  let cfg: Config;
  let store: Store;
  let api: App;
  let state: FakeAssign;
  let syncs = 0;

  beforeAll(async () => {
    cfg = loadConfig({ ...RULES_ENV, PCS_NOW: "2030-02-26T12:00" });
    store = memoryStore();
    expect((await runSync(store.db, smallWorld(), { clock: fixedClock(new Date("2030-02-14T12:00:00Z")), chunkSize: 200, concurrency: 2, tierTags: {}, acRole: cfg.acRole })).ok).toBe(true);
    state = { tagged: new Set([2]), requests: [], failNext: false };
    const client = new HotcrpClient({ baseUrl: cfg.hotcrp.url, token: TOKEN, fetch: fakeHotcrpFetch(state), sleep: async () => undefined });
    const tagFlow = new TagFlow({ writer: client, tag: cfg.attentionTag });
    const sync = new SyncRunner(async () => {
      syncs++;
      return { runId: 0, ok: true, counts: {}, errors: [], durationMs: 0 };
    });
    api = await buildApp({ cfg, store, clock: fixedClock(cfg.now!), sync, tagFlow, webDir: null });
  });

  afterAll(async () => {
    await api.app.close();
    store.close();
  });

  const post = (url: string, payload: unknown, headers: Record<string, string> = {}) => api.app.inject({ method: "POST", url, payload: payload as object, headers });

  it("GET /api/actions names the tag (PCS_ATTENTION_TAG, default chair-attention)", async () => {
    const r = (await api.app.inject({ method: "GET", url: "/api/actions" })).json() as ActionsInfo;
    expect(r).toEqual({ attentionTag: "chair-attention", taggingAvailable: true, previewTtlMs: 300_000 });
    expect(loadConfig({ ...RULES_ENV, PCS_ATTENTION_TAG: "#needs-chair" }).attentionTag).toBe("needs-chair");
    expect(() => loadConfig({ ...RULES_ENV, PCS_ATTENTION_TAG: "two words" })).toThrow(/PCS_ATTENTION_TAG/);
  });

  it("preview changes nothing; commit with the token writes, then starts a re-sync", async () => {
    const before = state.requests.length;
    const p = (await post("/api/tags/preview", { add: [1, 2], remove: [3] })).json() as TagPreviewResponse;
    expect(p).toMatchObject({ tag: TAG, gain: [{ pid: 1, title: "Paper One" }], lose: [], unchanged: [2, 3] });
    expect(p.token).toBeTruthy();
    expect([...state.tagged]).toEqual([2]);
    expect(state.requests.slice(before).every((r) => r.url.searchParams.get("dry_run") === "1")).toBe(true);

    const r = await post("/api/tags/commit", { token: p.token, gain: [1], lose: [], confirm: TAG });
    expect(r.statusCode, r.body).toBe(200);
    const c = r.json() as TagCommitResponse;
    expect(c).toEqual({ tag: TAG, gain: [1], lose: [], syncStarted: true });
    expect([...state.tagged].sort()).toEqual([1, 2]);
    expect(state.requests.at(-1)!.url.searchParams.has("dry_run")).toBe(false);
    expect(state.requests.at(-1)!.body).toEqual([{ pid: 1, action: "tag", tag: TAG }]);
    expect(syncs).toBe(1);

    // The same token again: refused, and nothing more is written.
    const n = state.requests.length;
    const again = await post("/api/tags/commit", { token: p.token, gain: [1], lose: [], confirm: TAG });
    expect(again.statusCode).toBe(409);
    expect(state.requests.length).toBe(n);
  });

  it("refuses mismatched sets, missing confirmation and made-up tokens without writing", async () => {
    const writes = () => state.requests.filter((r) => !r.url.searchParams.has("dry_run")).length;
    const w = writes();
    const p1 = (await post("/api/tags/preview", { remove: [1] })).json() as TagPreviewResponse;
    expect((await post("/api/tags/commit", { token: p1.token, gain: [], lose: [1, 2], confirm: TAG })).statusCode).toBe(409);
    const p2 = (await post("/api/tags/preview", { remove: [1] })).json() as TagPreviewResponse;
    expect((await post("/api/tags/commit", { token: p2.token, gain: [], lose: [1], confirm: "" })).statusCode).toBe(400);
    expect((await post("/api/tags/commit", { token: "forged", gain: [], lose: [1], confirm: TAG })).statusCode).toBe(409);
    expect((await post("/api/tags/commit", { gain: [], lose: [1], confirm: TAG })).statusCode).toBe(400);
    expect((await post("/api/tags/preview", { add: ["1"] })).statusCode).toBe(400);
    expect(writes()).toBe(w);
  });

  it("refuses cross-origin requests; answers 503 without a tag flow", async () => {
    const r = await post("/api/tags/preview", { add: [1] }, { origin: "https://evil.example" });
    expect(r.statusCode).toBe(403);
    expect((await post("/api/tags/preview", { add: [3] }, { origin: "http://127.0.0.1:5317" })).statusCode).toBe(200);
    expect((await post("/api/tags/preview", { add: [3] }, { origin: "http://localhost:5317" })).statusCode).toBe(200);
    // Another loopback port (some other local page) is cross-origin too, as is the Vite port outside PCS_DEV.
    for (const origin of ["http://127.0.0.1:8000", "http://127.0.0.1:5173", "https://127.0.0.1:5317", "http://127.0.0.1"]) {
      expect((await post("/api/tags/preview", { add: [3] }, { origin })).statusCode, origin).toBe(403);
    }
    const bare = await buildApp({ cfg, store, clock: fixedClock(cfg.now!), webDir: null });
    expect((await bare.app.inject({ method: "POST", url: "/api/tags/preview", payload: { add: [1] } })).statusCode).toBe(503);
    expect((await bare.app.inject({ method: "GET", url: "/api/actions" })).json()).toMatchObject({ taggingAvailable: false });
    await bare.app.close();
  });

  it("accepts the Vite dev origin only under PCS_DEV", async () => {
    expect([...allowedOrigins(5317, false)]).toEqual(["http://127.0.0.1:5317", "http://localhost:5317", "http://[::1]:5317"]);
    expect(allowedOrigins(5317, true).has("http://127.0.0.1:5173")).toBe(true);
    expect(loadConfig({ ...RULES_ENV, PCS_DEV: "true" }).dev).toBe(true);
    expect(loadConfig(RULES_ENV).dev).toBe(false);
    const dev = await buildApp({ cfg: { ...cfg, dev: true }, store, clock: fixedClock(cfg.now!), webDir: null });
    const r = await dev.app.inject({ method: "POST", url: "/api/tags/preview", payload: { add: [1] }, headers: { origin: "http://127.0.0.1:5173" } });
    expect(r.statusCode).toBe(503); // past the Origin check; this app has no tag flow
    const other = await dev.app.inject({ method: "POST", url: "/api/tags/preview", payload: { add: [1] }, headers: { origin: "http://127.0.0.1:5174" } });
    expect(other.statusCode).toBe(403);
    await dev.app.close();
  });

  it("GET /api/papers/:pid/nudge returns a draft with @mentions", async () => {
    const n = (await api.app.inject({ method: "GET", url: "/api/papers/2/nudge" })).json() as NudgeResponse;
    expect(n.pid).toBe(2);
    expect(n.text).toMatch(/^@/);
    expect((await api.app.inject({ method: "GET", url: "/api/papers/99/nudge" })).statusCode).toBe(404);
    expect((await api.app.inject({ method: "GET", url: "/api/papers/x/nudge" })).statusCode).toBe(400);
  });

  it("the token appears in no response body or header of the new routes, including HotCRP errors", async () => {
    const responses = [
      await api.app.inject({ method: "GET", url: "/api/actions" }),
      await api.app.inject({ method: "GET", url: "/api/papers/1/nudge" }),
      await api.app.inject({ method: "GET", url: "/api/papers/2/nudge" }),
      await api.app.inject({ method: "GET", url: `/api/papers/${TOKEN}/nudge` }),
    ];
    const p = await post("/api/tags/preview", { add: [3] });
    responses.push(p);
    responses.push(await post("/api/tags/commit", { token: (p.json() as TagPreviewResponse).token, gain: [3], lose: [], confirm: TAG }));
    state.failNext = true;
    const failed = await post("/api/tags/preview", { add: [4] });
    expect(failed.statusCode).toBe(502);
    expect(failed.json()).toMatchObject({ code: "hotcrp" });
    responses.push(failed);
    responses.push(await post("/api/tags/commit", { token: TOKEN, gain: [], lose: [], confirm: TAG }));
    responses.push(await post("/api/tags/preview", { add: [TOKEN] }));
    for (const r of responses) {
      expect(r.body).not.toContain(TOKEN);
      expect(r.body).not.toContain("hct_");
      expect(JSON.stringify(r.headers)).not.toContain(TOKEN);
    }
  });
});
