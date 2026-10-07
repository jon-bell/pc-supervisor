// Extended phase model (spec §10.1) and module activation (§10.4), PLAN M9.
import { describe, expect, it } from "vitest";
import { ConfigError, describeConfig, loadConfig } from "../../../src/config.js";
import {
  EXTENDED_PHASES,
  MODULES,
  activeModules,
  extendedPhaseAt,
  phaseAt,
  phaseTimesFromConfig,
  type ExtendedPhaseName,
  type ModuleId,
  type PhaseTimes,
} from "../../../src/rules/phase.js";
import { RULES_ENV, at, contextAt } from "../../fixtures/builder.js";

/** Synthetic large-conference dates around the ci.yml MVP dates. */
const EXTENDED_ENV: Record<string, string> = {
  PCS_PHASE_REGISTRATION_DUE: "2029-10-01T23:59",
  PCS_PHASE_SUBMISSION_DUE: "2029-10-08T23:59",
  PCS_PHASE_QUICKREJECT_DUE: "2029-10-22T23:59",
  PCS_PHASE_ASSIGNMENT_DONE: "2029-11-05T23:59",
  PCS_PHASE_EARLYREJECT_OPEN: "2030-02-03T00:00",
  PCS_PHASE_EARLYREJECT_CLOSE: "2030-02-04T23:59",
};

const full = (over: Record<string, string> = {}) =>
  phaseTimesFromConfig(loadConfig({ ...RULES_ENV, ...EXTENDED_ENV, ...over }).phases);
const P = full();
const MVP = contextAt("2030-02-26T12:00").phases;

function problems(over: Record<string, string>): Record<string, string> {
  try {
    loadConfig({ ...RULES_ENV, ...over });
  } catch (e) {
    if (e instanceof ConfigError) return Object.fromEntries(e.problems.map((p) => [p.name, p.message]));
    throw e;
  }
  return {};
}

describe("extendedPhaseAt", () => {
  const cases: [string, ExtendedPhaseName][] = [
    ["2029-09-01T12:00", "registration"],
    ["2029-10-01T23:59", "registration"], // the deadline belongs to the phase it ends
    ["2029-10-02T00:00", "submission"],
    ["2029-10-08T23:59", "submission"],
    ["2029-10-15T12:00", "quick-reject"],
    ["2029-11-01T12:00", "assignment"],
    ["2029-11-06T00:00", "before-review-due"],
    ["2030-02-01T23:59", "before-review-due"],
    ["2030-02-02T12:00", "reviewing-late"], // review due .. early-reject open
    ["2030-02-03T00:00", "early-reject"],
    ["2030-02-04T23:59", "early-reject"],
    ["2030-02-05T00:00", "reviewing-late"],
    ["2030-02-09T12:00", "response"],
    ["2030-02-20T12:00", "discussion"],
    ["2030-03-02T12:00", "decisions"],
    ["2030-03-10T12:00", "after-decisions"],
  ];
  for (const [now, phase] of cases) {
    it(`${now} -> ${phase}`, () => {
      expect(extendedPhaseAt(P, at(now))).toBe(phase);
    });
  }

  it("equals phaseAt when no extended date is configured", () => {
    const start = at("2029-09-01T00:00");
    for (let t = start; t < at("2030-03-10T00:00"); t += 6 * 3_600_000) {
      expect(extendedPhaseAt(MVP, t)).toBe(phaseAt(MVP, t));
    }
  });

  it("phaseAt itself ignores the extended dates (MVP behavior unchanged)", () => {
    expect(phaseAt(P, at("2029-10-15T12:00"))).toBe("before-review-due");
    expect(phaseAt(P, at("2030-02-03T12:00"))).toBe("reviewing-late");
  });

  it("drops unset phases: each pre-review phase starts at the previous set deadline", () => {
    const onlySub: PhaseTimes = { ...MVP, submissionDue: at("2029-10-08T23:59"), assignmentDone: at("2029-11-05T23:59") };
    expect(extendedPhaseAt(onlySub, at("2029-09-01T12:00"))).toBe("submission");
    expect(extendedPhaseAt(onlySub, at("2029-10-15T12:00"))).toBe("assignment");
    expect(extendedPhaseAt(onlySub, at("2029-12-01T12:00"))).toBe("before-review-due");
  });

  it("lists every phase once, in order", () => {
    expect(new Set(EXTENDED_PHASES).size).toBe(EXTENDED_PHASES.length);
    const seen = cases.map(([, p]) => p);
    for (const p of EXTENDED_PHASES) expect(seen).toContain(p);
  });
});

describe("activeModules", () => {
  const cases: [string, ModuleId[]][] = [
    ["2029-09-01T12:00", ["reserve-compliance"]],
    ["2029-10-15T12:00", ["reserve-compliance", "quick-reject"]],
    ["2029-11-01T12:00", ["quick-reject", "assignment-validator"]],
    ["2029-12-01T12:00", ["assignment-validator", "reviewing-by-tier"]],
    ["2030-02-03T12:00", ["assignment-validator", "reviewing-by-tier", "early-reject"]],
    ["2030-02-09T12:00", ["reviewing-by-tier", "discussion"]],
    ["2030-02-20T12:00", ["discussion"]],
    ["2030-03-02T12:00", ["discussion"]],
    ["2030-03-10T12:00", ["process-report"]],
  ];
  for (const [now, mods] of cases) {
    it(`${now}: ${mods.map((m) => MODULES[m].letter).join("")}`, () => {
      expect(activeModules(extendedPhaseAt(P, at(now)))).toEqual(mods);
    });
  }

  it("every module is active in some phase", () => {
    const all = new Set(EXTENDED_PHASES.flatMap((p) => activeModules(p)));
    expect([...all].sort()).toEqual(Object.keys(MODULES).sort());
  });
});

describe("extended phase config", () => {
  it("is optional: the MVP env loads with every extended date undefined", () => {
    const c = loadConfig(RULES_ENV);
    expect(c.phases.registrationDue).toBeUndefined();
    expect(c.phases.earlyRejectClose).toBeUndefined();
  });

  it("parses the dates in PCS_TZ", () => {
    const c = loadConfig({ ...RULES_ENV, ...EXTENDED_ENV });
    expect(c.phases.submissionDue?.toISOString()).toBe("2029-10-09T03:59:00.000Z"); // EDT
    expect(c.phases.earlyRejectOpen?.toISOString()).toBe("2030-02-03T05:00:00.000Z"); // EST
  });

  it("reports every ordering problem at once", () => {
    const p = problems({
      PCS_PHASE_REGISTRATION_DUE: "2029-10-10T00:00",
      PCS_PHASE_SUBMISSION_DUE: "2029-10-08T23:59", // before registration
      PCS_PHASE_ASSIGNMENT_DONE: "2030-02-05T00:00", // after review due
      PCS_PHASE_EARLYREJECT_OPEN: "2030-02-09T00:00", // inside the response window
      PCS_PHASE_EARLYREJECT_CLOSE: "2030-02-10T00:00",
    });
    expect(p).toEqual({
      PCS_PHASE_SUBMISSION_DUE: "must not be earlier than PCS_PHASE_REGISTRATION_DUE",
      PCS_PHASE_ASSIGNMENT_DONE: "must not be later than PCS_PHASE_REVIEW_DUE",
      PCS_PHASE_EARLYREJECT_CLOSE: "must not be later than PCS_PHASE_RESPONSE_OPEN",
    });
  });

  it("keeps early reject before discussion even with a response window", () => {
    const q = problems({
      PCS_PHASE_RESPONSE_OPEN: "2030-02-20T00:00",
      PCS_PHASE_RESPONSE_CLOSE: "2030-02-21T00:00",
      PCS_PHASE_EARLYREJECT_OPEN: "2030-02-13T00:00",
      PCS_PHASE_EARLYREJECT_CLOSE: "2030-02-14T00:00",
    });
    expect(q).toEqual({ PCS_PHASE_EARLYREJECT_CLOSE: "must not be later than PCS_PHASE_DISCUSSION_OPEN" });
  });

  it("requires both early-reject dates or neither", () => {
    expect(problems({ PCS_PHASE_EARLYREJECT_OPEN: "2030-02-03T00:00" })).toEqual({
      PCS_PHASE_EARLYREJECT_CLOSE: "set both PCS_PHASE_EARLYREJECT_OPEN and PCS_PHASE_EARLYREJECT_CLOSE, or neither",
    });
  });

  it("config-check lists the extended dates only when any is set", () => {
    expect(describeConfig(loadConfig(RULES_ENV)).some((l) => l.startsWith("Early reject"))).toBe(false);
    const lines = describeConfig(loadConfig({ ...RULES_ENV, ...EXTENDED_ENV }));
    expect(lines).toContain("Early reject      2030-02-03T00:00:00-05:00 .. 2030-02-04T23:59:00-05:00");
    expect(lines).toContain("Submission due    2029-10-08T23:59:00-04:00");
  });

  it("validates each date's format with the other phase dates", () => {
    expect(problems({ PCS_PHASE_QUICKREJECT_DUE: "2029-10-22" }).PCS_PHASE_QUICKREJECT_DUE).toMatch(/ISO date-time/);
  });
});
