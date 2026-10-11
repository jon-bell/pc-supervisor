// PLAN M12 API via inject(): GET /api/tier-progress and GET /api/early-reject
// over the fake HotCRP smallWorld synced into memory (see server-people.test.ts),
// plus the CLI renderers. Neither carries review or comment text or the token.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { describeEarlyReject, describeTierProgress } from "../../src/cli/progress-command.js";
import { fixedClock } from "../../src/clock.js";
import { loadConfig, type Config } from "../../src/config.js";
import { formatter, type EarlyRejectReport } from "../../src/modules/early-reject/index.js";
import type { TierProgressReport } from "../../src/modules/tier-progress/index.js";
import { buildApp, type App } from "../../src/server/app.js";
import { memoryStore, type Store } from "../../src/store/store.js";
import { runSync } from "../../src/sync/sync.js";
import { RULES_ENV } from "../fixtures/builder.js";
import { smallWorld } from "./fake-source.js";

const TOKEN = RULES_ENV.PCS_HOTCRP_TOKEN!;
/** Review and comment text in smallWorld; none of it may appear. */
const TEXT = ["Short summary here", "Needs more evaluation", "A solid paper", "baselines are weak", "thoughts?", "can you say more"];
let cfg: Config;
let store: Store;
let api: App;

beforeAll(async () => {
  cfg = loadConfig({
    ...RULES_ENV,
    PCS_NOW: "2030-02-26T12:00",
    PCS_TIER_TAGS: "junior=junior,reciprocal=reciprocal",
    PCS_PHASE_EARLYREJECT_OPEN: "2030-02-03T09:00",
    PCS_POLICY_WITHHOLD_REVIEWS: "true",
  });
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

async function get<T>(url: string): Promise<{ body: string; json: T }> {
  const r = await api.app.inject({ method: "GET", url });
  expect(r.statusCode, `${url}: ${r.body}`).toBe(200);
  expect(r.body).not.toContain(TOKEN);
  for (const t of TEXT) expect(r.body, `${url} leaks "${t}"`).not.toContain(t);
  return { body: r.body, json: r.json() as T };
}

describe("GET /api/tier-progress", () => {
  it("late reviews by tier, Dee's reciprocal dropout state, the coaching queue, and the withhold draft", async () => {
    const { json: r } = await get<TierProgressReport>("/api/tier-progress");
    expect(r.tiers.map((t) => t.tier)).toEqual(["senior", "junior", "reciprocal"]);
    expect(r.tiers.find((t) => t.tier === "reciprocal")).toMatchObject({ assigned: 1, outstanding: 1, late: 1 });
    expect(r.dropout.rows.map((d) => [d.pid, d.person.email, d.state])).toEqual([[2, "dee@example.org", "replacement-needed"]]);
    expect(r.coaching.rows.map((c) => [c.pid, c.person.email, c.words])).toEqual([[1, "cy@example.org", 7]]);
    expect(r.accountability.rows.map((a) => a.person.email)).toEqual(["dee@example.org"]);
    expect(r.withhold.enabled).toBe(true);
  });
});

describe("GET /api/early-reject", () => {
  it("reports the closed window (close = open + 48 h) with its definition", async () => {
    const { json: r } = await get<EarlyRejectReport>("/api/early-reject");
    expect(r).toMatchObject({ status: "closed", closeSource: "window-hours", policy: "reject_only", bandMax: 1, minReviews: 3 });
    expect(r.close! - r.open!).toBe(48 * 3_600_000);
    expect(r.candidates).toEqual([]);
  });
});

describe("CLI renderers", () => {
  it("print counts and reasons, never review text", async () => {
    const fmt = formatter(cfg.tz);
    const { json: tp } = await get<TierProgressReport>("/api/tier-progress");
    const { json: er } = await get<EarlyRejectReport>("/api/early-reject");
    const lines = [...describeTierProgress(tp, fmt), ...describeEarlyReject(er, fmt)].join("\n");
    expect(lines).toMatch(/reciprocal: 1 reviewers; 0 of 1 submitted; 1 outstanding; 1 late/);
    expect(lines).toMatch(/#2 dee@example.org: replacement-needed: not submitted 24\.5 days after the review deadline/);
    expect(lines).toMatch(/Candidates as of .*: 0/);
    for (const t of TEXT) expect(lines).not.toContain(t);
    expect(lines).not.toContain("Paper Two"); // no titles either
  });
});
