// Phase-2 seeder foundations (PLAN M10) and the `assignment` scenario's
// oracle, without a harness: the scenario replays, the driver's settings carry
// the rounds and submission options, and the validator, fed the scenario's
// own data plus the fixture imports, reports exactly expected.ts.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fixedClock } from "@pcs/server/clock";
import { loadConfig, loadPhaseConfig } from "@pcs/server/config";
import { importCsv, rowsAsOf } from "@pcs/server/imports/store";
import { validate } from "@pcs/server/modules/assignment/validate";
import type { PersonInfo, ValidatorInput } from "@pcs/server/modules/assignment/types";
import { memoryStore } from "@pcs/server/store/store";
import { scenarioSettings } from "../../src/driver.js";
import { QUICKREJECT_ROUND, TIER_TAGS, TIER_TAGS_ENV, type Scenario } from "../../src/format.js";
import { replay, ScenarioError } from "../../src/model.js";
import { EXPECTED_HOTCRP, EXPECTED_TPMS, EXPECTED_TPMS_FIXUP } from "../../scenarios/assignment/expected.js";
import { A, ASSIGNMENT_ENV, FIXTURES, scenario } from "../../scenarios/assignment/scenario.js";

const CI_ENV = {
  PCS_TZ: "America/New_York",
  PCS_PHASE_REVIEW_DUE: "2030-02-01T23:59",
  PCS_PHASE_DISCUSSION_OPEN: "2030-02-12T00:00",
  PCS_PHASE_DISCUSSION_CLOSE: "2030-03-01T23:59",
  PCS_PHASE_DECISIONS_DUE: "2030-03-03T23:59",
};
const ctx = loadPhaseConfig(CI_ENV);

describe("phase-2 scenario format", () => {
  it("the assignment scenario replays", () => {
    const st = replay(scenario, ctx);
    expect([...st.reviews.values()].filter((r) => r.role !== "metareview")).toHaveLength(24);
  });

  it("rejects an author assigned to their own paper, unknown options and rounds", () => {
    const bad = (patch: Partial<Scenario>) => () => replay({ ...scenario, ...patch }, ctx);
    expect(bad({ assignments: [{ pid: 1, email: A.s2, role: "primary" }] })).toThrow(/author of paper 1/);
    expect(bad({ assignments: [{ pid: 1, email: A.s1, role: "primary", round: "nosuch" }] })).toThrow(/not in reviewRounds/);
    expect(bad({ papers: [{ ...scenario.papers[0]!, options: { Nope: "x" } }] })).toThrow(ScenarioError);
    expect(bad({ papers: [{ ...scenario.papers[0]!, options: { "Reserve exemption": "bogus" } }] })).toThrow(/not a value/);
  });

  it("settings add the rounds and options (matched by name) on top of the harness settings", () => {
    const s = scenarioSettings(scenario) as { review: { name: string }[]; sf: { name: string; type: string; visibility: string; values?: { name: string }[] }[] };
    expect(s.review.map((r) => r.name)).toEqual(["", QUICKREJECT_ROUND]);
    expect(s.sf.map((f) => [f.name, f.type, f.visibility])).toEqual([
      ["Reserve designee", "text", "admin"],
      ["Reserve exemption", "dropdown", "admin"],
    ]);
    expect(scenarioSettings({ ...scenario, submissionFields: [], reviewRounds: [] })).not.toHaveProperty("sf");
  });

  it("TIER_TAGS_ENV is a valid PCS_TIER_TAGS for the four tiers", () => {
    const cfg = loadConfig({ ...CI_ENV, NODE_ENV: "test", PCS_HOTCRP_URL: "http://127.0.0.1:1", PCS_HOTCRP_TOKEN: "hct_x", PCS_TIER_TAGS: TIER_TAGS_ENV });
    expect(cfg.tierTags).toEqual(TIER_TAGS);
  });
});

describe("assignment scenario oracle (no harness)", () => {
  const cfg = loadConfig({ ...CI_ENV, ...ASSIGNMENT_ENV, NODE_ENV: "test", PCS_HOTCRP_URL: "http://127.0.0.1:1", PCS_HOTCRP_TOKEN: "hct_x" });
  const tierOf = (tags: readonly string[] = []) =>
    Object.entries(cfg.tierTags).find(([, tag]) => tags.includes(tag))?.[0] ?? "senior";

  function input(source: "hotcrp" | "tpms"): ValidatorInput {
    const store = memoryStore();
    const clock = fixedClock(new Date("2030-01-11T17:00:00Z"));
    for (const kind of ["invites", "do-not-invite", "tpms-assignments"] as const) {
      const r = importCsv(store.db, kind, readFileSync(FIXTURES[kind]), { tz: ctx.tz, clock });
      expect(r.ok).toBe(true);
    }
    const acs = new Set(scenario.assignments.filter((a) => a.role === "metareview").map((a) => a.email));
    const people = new Map<string, PersonInfo>(
      scenario.people.map((p) => [p.email, { email: p.email, affiliation: p.affiliation ?? null, isPc: p.roles.includes("pc"), tier: tierOf(p.tags), exempt: acs.has(p.email) }]),
    );
    const papers = new Map(scenario.papers.map((p) => [p.pid, { pid: p.pid, authors: p.authors.map((a) => ({ email: a.email, affiliation: a.affiliation ?? null })) }]));
    const ROLE = { primary: "primary", secondary: "secondary", pcreview: "pc" } as const;
    const current = scenario.assignments
      .filter((a) => a.role !== "metareview")
      .map((a) => ({ pid: a.pid, email: a.email, role: ROLE[a.role as keyof typeof ROLE], status: "empty" }));
    const at = clock.now();
    const inv = rowsAsOf(store.db, "invites", at);
    const dni = rowsAsOf(store.db, "do-not-invite", at);
    const tpms = rowsAsOf(store.db, "tpms-assignments", at);
    return {
      source,
      papers,
      people,
      proposal: source === "tpms" ? tpms.rows.map((r) => ({ pid: r.pid, email: r.email, score: r.score })) : current.map((c) => ({ pid: c.pid, email: c.email, score: null })),
      current,
      invites: { runId: inv.run!.id, rows: inv.rows },
      doNotInvite: { runId: dni.run!.id, rows: dni.rows },
      ...(source === "tpms" ? { tpmsRunId: tpms.run!.id } : {}),
    };
  }

  const summary = (r: ReturnType<typeof validate>) => r.findings.map((f) => `${f.code} ${f.pid ?? "-"} ${f.emails.join(" ")}`).sort();

  it("the HotCRP assignment yields exactly EXPECTED_HOTCRP", () => {
    expect(summary(validate(input("hotcrp"), cfg.assignment!))).toEqual([...EXPECTED_HOTCRP].sort());
  });

  it("the TPMS fixture yields exactly EXPECTED_TPMS and EXPECTED_TPMS_FIXUP", () => {
    const r = validate(input("tpms"), cfg.assignment!);
    expect(summary(r)).toEqual([...EXPECTED_TPMS].sort());
    expect(r.fixup.csv).toBe(`${EXPECTED_TPMS_FIXUP.join("\n")}\n`);
  });
});
