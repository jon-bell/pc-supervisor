// Comment types over the API (spec §5e), via inject(): the drawer's type
// chips, /api/meta's classifier state, PUT /api/comments/:cid/label (audit,
// guard, errors), the AC pings column, and a rule that ignores a type
// re-flagging after a relabel. Store: the fake HotCRP smallWorld synced into
// memory, classified by the heuristic. Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixedClock } from "../../src/clock.js";
import { loadConfig, type Config } from "../../src/config.js";
import { CommentClassifier } from "../../src/classifier/service.js";
import { fixedActor } from "../../src/rule-settings/actor.js";
import type { AcsResponse, CommentLabelResponse, MetaResponse, PaperDetail, TriageResponse } from "../../src/server/api-types.js";
import { buildApp, type App } from "../../src/server/app.js";
import { memoryStore, type Store } from "../../src/store/store.js";
import { runSync } from "../../src/sync/sync.js";
import { RULES_ENV } from "../fixtures/builder.js";
import { smallWorld } from "./fake-source.js";

const NOW = "2030-02-26T12:00";
let cfg: Config;
let store: Store;
let api: App;
let classifier: CommentClassifier;

beforeAll(async () => {
  cfg = loadConfig({ ...RULES_ENV, PCS_NOW: NOW });
  store = memoryStore();
  const clock = fixedClock(cfg.now!);
  const s = await runSync(store.db, smallWorld(), { clock, chunkSize: 200, concurrency: 2, tierTags: cfg.tierTags, acRole: cfg.acRole });
  expect(s.ok).toBe(true);
  classifier = new CommentClassifier(store, cfg, clock);
  expect((await classifier.run()).classified).toBeGreaterThan(0);
  api = await buildApp({ cfg, store, clock, webDir: null, actor: fixedActor("admin@example.org"), classifier });
});

afterAll(async () => {
  await api.app.close();
  await classifier.close();
  store.close();
});

const req = async <T>(method: "GET" | "PUT", url: string, body?: unknown, headers: Record<string, string> = {}) => {
  const r = await api.app.inject({ method, url, payload: body as Record<string, unknown> | undefined, headers });
  return { status: r.statusCode, body: r.json() as T };
};

/** The first paper with a published, non-response comment. */
async function aComment(): Promise<{ pid: number; cid: number; detail: PaperDetail }> {
  const t = (await req<TriageResponse>("GET", "/api/triage")).body;
  for (const p of t.papers) {
    const d = (await req<PaperDetail>("GET", `/api/papers/${p.pid}`)).body;
    const c = d.comments.find((x) => !x.isResponse && !x.draft);
    if (c) return { pid: p.pid, cid: c.cid, detail: d };
  }
  throw new Error("smallWorld has no comment");
}

describe("comment types over the API", () => {
  it("/api/meta says which classifier is active", async () => {
    const m = (await req<MetaResponse>("GET", "/api/meta")).body;
    expect(m.commentTypes).toEqual({ configured: "heuristic", active: "heuristic", fallback: null, minConfidence: 0.6, running: false });
  });

  it("the drawer carries each comment's type with its source and confidence; responses have none", async () => {
    const { detail } = await aComment();
    for (const c of detail.comments) {
      if (c.isResponse || c.draft) expect(c.type).toBeNull();
      else expect(c.type).toMatchObject({ source: "heuristic", classifier: null, low: c.type!.confidence < 0.6 });
    }
  });

  it("PUT /api/comments/:cid/label relabels, audits, and the drawer shows it; null clears it", async () => {
    const { pid, cid } = await aComment();
    const r = await req<CommentLabelResponse>("PUT", `/api/comments/${cid}/label`, { kind: "ping" });
    expect(r.status).toBe(200);
    expect(r.body.type).toMatchObject({ kind: "ping", source: "chair", confidence: 1, low: false });
    expect(r.body.revision).toMatchObject({ cid, pid, kind: "ping", actor: "admin@example.org", previousSource: "heuristic" });
    const d = (await req<PaperDetail>("GET", `/api/papers/${pid}`)).body;
    expect(d.comments.find((c) => c.cid === cid)!.type).toMatchObject({ kind: "ping", source: "chair" });
    const log = (await req<{ items: { cid: number; kind: string | null }[] }>("GET", `/api/comment-labels?cid=${cid}`)).body;
    expect(log.items[0]).toMatchObject({ cid, kind: "ping" });
    expect((await req("PUT", `/api/comments/${cid}/label`, { kind: "ping" })).status).toBe(409);
    const back = await req<CommentLabelResponse>("PUT", `/api/comments/${cid}/label`, { kind: null });
    expect(back.body.type!.source).toBe("heuristic");
  });

  it("refuses bad input, unknown comments and cross-origin writes", async () => {
    const { cid } = await aComment();
    expect((await req("PUT", `/api/comments/${cid}/label`, { kind: "spam" })).status).toBe(400);
    expect((await req("PUT", `/api/comments/${cid}/label`, {})).status).toBe(400);
    expect((await req("PUT", "/api/comments/abc/label", { kind: "ping" })).status).toBe(400);
    expect((await req("PUT", "/api/comments/987654/label", { kind: "ping" })).status).toBe(404);
    expect((await req("PUT", `/api/comments/${cid}/label`, { kind: "ping" }, { origin: "https://evil.example.org" })).status).toBe(403);
  });

  it("the AC nudges column counts pings once the classifier is active, named in the source", async () => {
    const acs = (await req<AcsResponse>("GET", "/api/acs")).body.acs;
    expect(acs.length).toBeGreaterThan(0);
    for (const a of acs) expect(a.nudges).toMatchObject({ source: "heuristic", total: a.nudges.pings });
    // Relabels flowing into the count are covered on golden (test/integration/comment-types.test.ts).
  });
});
