// PLAN M12: the `earlyreject` scenario and the stage-time `assign` event,
// without a harness.
import { describe, expect, it } from "vitest";
import { loadConfig, loadPhaseConfig } from "@pcs/server/config";
import type { Scenario } from "../../src/format.js";
import { replay, reviewKey } from "../../src/model.js";
import { resolveWhen } from "../../src/time.js";
import { CLOSE_AT, E, OPEN_AT, earlyRejectEnv, scenario } from "../../scenarios/earlyreject/scenario.js";

const CI_ENV = {
  PCS_TZ: "America/New_York",
  PCS_PHASE_REVIEW_DUE: "2030-02-01T23:59",
  PCS_PHASE_RESPONSE_OPEN: "2030-02-08T00:00",
  PCS_PHASE_RESPONSE_CLOSE: "2030-02-11T23:59",
  PCS_PHASE_DISCUSSION_OPEN: "2030-02-12T00:00",
  PCS_PHASE_DISCUSSION_CLOSE: "2030-03-01T23:59",
  PCS_PHASE_DECISIONS_DUE: "2030-03-03T23:59",
};
const ctx = loadPhaseConfig(CI_ENV);

describe("earlyreject scenario", () => {
  it("replays both stages; stage 2 adds s5 on #6 at its event time", () => {
    const s1 = replay(scenario, ctx, 1);
    const s2 = replay(scenario, ctx, 2);
    expect(s1.reviews.has(reviewKey(6, E.s5))).toBe(false);
    const added = s2.reviews.get(reviewKey(6, E.s5))!;
    expect(added).toMatchObject({ role: "pcreview", status: "empty", removed: false });
    expect(added.requestedAt.toISOString()).toBe("2030-02-04T14:00:00.000Z");
    expect(s2.reviews.get(reviewKey(7, E.r1))!.status).toBe("complete");
  });

  it("its window env passes M9's ordering checks with the ci.yml dates", () => {
    const env = earlyRejectEnv(ctx);
    expect([env.PCS_PHASE_EARLYREJECT_OPEN, env.PCS_PHASE_EARLYREJECT_CLOSE]).toEqual(["2030-02-03T09:00", "2030-02-05T09:00"]);
    const cfg = loadConfig({ ...CI_ENV, ...env, NODE_ENV: "test", PCS_HOTCRP_URL: "http://127.0.0.1:1", PCS_HOTCRP_TOKEN: "hct_x" });
    expect(cfg.phases.earlyRejectOpen!.getTime()).toBe(resolveWhen(OPEN_AT, ctx).getTime());
    expect(cfg.phases.earlyRejectClose!.getTime()).toBe(resolveWhen(CLOSE_AT, ctx).getTime());
  });

  it("an assign event is checked like a stage-1 assignment", () => {
    const withAssign = (email: string, pid = 6): Scenario => ({
      ...scenario,
      stages: [scenario.stages[0]!, { ...scenario.stages[1]!, events: [{ type: "assign", pid, email, role: "pcreview", at: { phase: "reviewDue", day: 3, time: "08:00" } }] }],
    });
    expect(() => replay(withAssign(E.a1), ctx)).toThrow(/not on the PC/);
    expect(() => replay(withAssign(E.r2, 1), ctx)).toThrow(/author of paper 1/);
    expect(() => replay(withAssign(E.s2), ctx)).toThrow(/already assigned to paper 6/);
  });
});
