// PLAN M10b API via inject(): GET /api/assignment (M10's validator, now
// routed), GET/POST /api/assignment/solve (the solver, cached), over the fake
// HotCRP smallWorld synced into memory, with a fake solver HotCRP client. Plus
// the CLI renderer. Nothing carries review or comment text or the token.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { describeSolve } from "../../src/cli/solver-command.js";
import { fixedClock } from "../../src/clock.js";
import { loadConfig, type Config } from "../../src/config.js";
import type { SolverHotcrp } from "../../src/modules/solver/load.js";
import { buildApp, type App } from "../../src/server/app.js";
import type { AssignmentResponse, SolveResponse } from "../../src/server/assignment-types.js";
import { memoryStore, type Store } from "../../src/store/store.js";
import { runSync } from "../../src/sync/sync.js";
import { RULES_ENV } from "../fixtures/builder.js";
import { smallWorld } from "./fake-source.js";

const TOKEN = RULES_ENV.PCS_HOTCRP_TOKEN!;
const TEXT = ["Short summary here", "Needs more evaluation", "A solid paper", "baselines are weak", "thoughts?", "can you say more"];
let cfg: Config;
let store: Store;
let api: App;
let bare: App;
const calls: string[] = [];
const fakeHotcrp: SolverHotcrp = {
  pcConflicts: async () => (calls.push("pcconf"), []),
  allRevPrefs: async () => (calls.push("allrevpref"), []),
};

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
  api = await buildApp({ cfg, store, clock: fixedClock(cfg.now!), webDir: null, solverHotcrp: fakeHotcrp });
  bare = await buildApp({ cfg, store, clock: fixedClock(cfg.now!), webDir: null });
});

afterAll(async () => {
  await api.app.close();
  await bare.app.close();
  store.close();
});

function clean(body: string) {
  expect(body).not.toContain(TOKEN);
  for (const t of TEXT) expect(body).not.toContain(t);
}

describe("GET /api/assignment", () => {
  it("validates the current HotCRP assignment, with the module window", async () => {
    const r = await api.app.inject({ method: "GET", url: "/api/assignment" });
    expect(r.statusCode).toBe(200);
    clean(r.body);
    const j = r.json() as AssignmentResponse;
    expect(j.module.letter).toBe("C");
    expect(j.report.source).toBe("hotcrp");
    expect(j.report.counts.papers).toBeGreaterThan(0);
    expect(j.report.fixup.csv.startsWith("paper,action,user\n")).toBe(true);
  });

  it("?source=tpms without an import is a 404 with the hint; a bad source is a 400", async () => {
    const r = await api.app.inject({ method: "GET", url: "/api/assignment?source=tpms" });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual({ error: expect.stringContaining("pcs import tpms-assignments") });
    expect((await api.app.inject({ method: "GET", url: "/api/assignment?source=x" })).statusCode).toBe(400);
  });
});

describe("/api/assignment/solve", () => {
  it("GET before any solve: no report", async () => {
    const r = await api.app.inject({ method: "GET", url: "/api/assignment/solve" });
    expect(r.json()).toMatchObject({ report: null, computedAt: null, running: false, available: true });
  });

  it("POST solves (reading conflicts and preferences), caches, and GET returns the cached report", async () => {
    const r = await api.app.inject({ method: "POST", url: "/api/assignment/solve", payload: {} });
    expect(r.statusCode, r.body).toBe(200);
    clean(r.body);
    const j = r.json() as SolveResponse;
    expect(j.running).toBe(false);
    expect(j.computedAt).toBe(cfg.now!.getTime());
    expect(j.report!.mode).toBe("soft");
    expect(j.report!.csv.startsWith("paper,action,email,round\n")).toBe(true);
    expect(j.report!.crossCheck.unexplained).toBe(0);
    expect(calls.sort()).toEqual(["allrevpref", "pcconf"]);
    const g = (await api.app.inject({ method: "GET", url: "/api/assignment/solve" })).json() as SolveResponse;
    expect(g.report!.objective).toBe(j.report!.objective);
    // The CLI renderer prints the same report.
    const lines = describeSolve(j.report!);
    expect(lines[0]).toMatch(/^Solved \(soft\): \d+ papers/);
    expect(lines).toContain("[load by tier]");
  });

  it("POST {hard: true} solves with lower bounds; a non-boolean hard is a 400", async () => {
    const r = await api.app.inject({ method: "POST", url: "/api/assignment/solve", payload: { hard: true } });
    expect((r.json() as SolveResponse).report!.mode).toBe("hard");
    expect((await api.app.inject({ method: "POST", url: "/api/assignment/solve", payload: { hard: "yes" } })).statusCode).toBe(400);
  });

  it("refuses cross-origin POSTs, and answers 503 without a HotCRP client", async () => {
    const x = await api.app.inject({ method: "POST", url: "/api/assignment/solve", payload: {}, headers: { origin: "https://evil.example" } });
    expect(x.statusCode).toBe(403);
    const b = await bare.app.inject({ method: "POST", url: "/api/assignment/solve", payload: {} });
    expect(b.statusCode).toBe(503);
    expect((await bare.app.inject({ method: "GET", url: "/api/assignment/solve" })).json()).toMatchObject({ available: false });
  });
});
