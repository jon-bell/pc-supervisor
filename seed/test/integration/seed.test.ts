// Seed -> verify on the local harness. Each test RESETS the harness first, so
// whatever ran before leaves no trace; the file leaves `golden` seeded.

import { describe, expect, it } from "vitest";
import { resetHarness, seedContextFromEnv, seededState, seedScenario } from "../../src/driver.js";
import { readClient, reviewerEmailsWithTag, verifyScenario } from "../../src/verify.js";
import { scenario as multistage } from "../../scenarios/multistage/scenario.js";
import { P, scenario as golden } from "../../scenarios/golden/scenario.js";

const sc = seedContextFromEnv();

describe("multistage", () => {
  it("stage 1 then stage 2, each verified; stage 1 no longer matches after stage 2", async () => {
    await seedScenario(multistage, { stage: 1, reset: true });
    expect(await seededState(sc)).toEqual({ scenario: "multistage", stage: 1 });
    expect((await verifyScenario(multistage, sc.ctx, 1)).problems).toEqual([]);
    // Stage 1 can't be seeded twice; stage 3 doesn't exist.
    await expect(seedScenario(multistage, { stage: 1 })).rejects.toThrow(/not empty/);
    await seedScenario(multistage, { stage: 2 });
    expect((await verifyScenario(multistage, sc.ctx, 2)).problems).toEqual([]);
    const stale = await verifyScenario(multistage, sc.ctx, 1);
    expect(stale.problems.length).toBeGreaterThan(0);
  });
});

describe("golden", () => {
  it("seeds exactly the PLAN.md table, with backdated times within ±60 s", async () => {
    await resetHarness(sc);
    await expect(seedScenario(golden, { stage: 2 })).rejects.toThrow(/has stages 1..1/);
    await seedScenario(golden);
    const { problems, checks } = await verifyScenario(golden, sc.ctx);
    expect(problems).toEqual([]);
    expect(checks).toBeGreaterThan(500);
  });

  it("tiers are readable through the API: /reviews rq=re:#<tag>", async () => {
    const client = readClient();
    expect([...(await reviewerEmailsWithTag(client, "junior"))]).toEqual([P.silent]);
    expect([...(await reviewerEmailsWithTag(client, "reciprocal"))]).toEqual([P.recip]);
  });
});
