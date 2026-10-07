import { describe, expect, it } from "vitest";
import { loadPhaseConfig } from "@pcs/server/config";
import { formatInZone } from "@pcs/server/tz";
import { at, type Scenario } from "../../src/format.js";
import { planWaves, replay, ScenarioError, timedEvents } from "../../src/model.js";
import { countWords, fillerWords, reviewText } from "../../src/text.js";
import { mulberry32 } from "../../src/rng.js";
import { resolveWhen } from "../../src/time.js";
import { FIRES_AT_PRIMARY, MERITS } from "../../scenarios/golden/expected.js";
import { NOW_PRIMARY, NOW_SECOND, P, scenario as golden } from "../../scenarios/golden/scenario.js";
import { scenario as multistage, STAGE1_NOW, STAGE2_NOW } from "../../scenarios/multistage/scenario.js";
import { scenario as shadow } from "../../scenarios/shadow/scenario.js";
import { scenario as scale } from "../../scenarios/scale/scenario.js";

// The ci.yml phase dates.
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
const local = (d: Date) => formatInZone(d, ctx.tz).slice(0, 16);

describe("time", () => {
  it("resolves phase-relative times in PCS_TZ", () => {
    expect(local(resolveWhen(NOW_PRIMARY, ctx))).toBe("2030-02-26T12:00");
    expect(local(resolveWhen(NOW_SECOND, ctx))).toBe("2030-03-01T12:00");
    expect(local(resolveWhen(at("responseOpen", 1, "12:00"), ctx))).toBe("2030-02-09T12:00");
    expect(local(resolveWhen(at("reviewDue", -12, "10:00"), ctx))).toBe("2030-01-20T10:00");
    // No time: keep the phase's own time of day.
    expect(local(resolveWhen(at("reviewDue", 1), ctx))).toBe("2030-02-02T23:59");
  });

  it("counts calendar days across DST", () => {
    const c = loadPhaseConfig({ ...CI_ENV, PCS_PHASE_DISCUSSION_OPEN: "2030-03-08T09:00" });
    // US DST starts 2030-03-10: still 09:00 local two days later.
    expect(formatInZone(resolveWhen(at("discussionOpen", 2), c), c.tz)).toBe("2030-03-10T09:00:00-04:00");
  });

  it("rejects unset phases and bad times", () => {
    const c = loadPhaseConfig({ ...CI_ENV, PCS_PHASE_RESPONSE_OPEN: "", PCS_PHASE_RESPONSE_CLOSE: "" });
    expect(() => resolveWhen(at("responseOpen", 0), c)).toThrow(/PCS_PHASE_RESPONSE_OPEN is not set/);
    expect(() => resolveWhen(at("reviewDue", 0, "25:00"), ctx)).toThrow(/HH:MM/);
  });
});

describe("text", () => {
  it("generates exactly the requested words, deterministically", () => {
    for (const n of [0, 1, 2, 35, 200, 250, 711]) {
      expect(countWords(fillerWords(mulberry32(n), n))).toBe(n);
    }
    const a = reviewText("3:r-silent@example.org", 250);
    expect(a).toEqual(reviewText("3:r-silent@example.org", 250));
    expect(Object.values(a).reduce((s, t) => s + countWords(t), 0)).toBe(250);
  });
});

describe("waves", () => {
  it("puts each object's k-th event in wave k", () => {
    const evs = timedEvents(multistage, ctx, 1).concat(timedEvents(multistage, ctx, 2));
    const waves = planWaves(evs);
    expect(waves.length).toBe(2);
    // Stage 2's events on stage-1 objects (score change, edit, delete) land in wave 2;
    // the unassignment is the first event on ms-dee's (never submitted) pid 2 review.
    expect(waves[1]!.map((t) => t.event.type).sort()).toEqual(["commentDelete", "commentEdit", "scoreChange"]);
  });
});

describe("replay validation", () => {
  const base: Scenario = {
    name: "t",
    description: "",
    people: [{ email: "a@example.org", first: "A", last: "B", roles: ["pc"] }],
    papers: [{ pid: 1, title: "T", authors: [{ email: "au@example.org", first: "C", last: "D" }] }],
    assignments: [{ pid: 1, email: "a@example.org", role: "primary" }],
    stages: [{ name: "s", events: [] }],
  };
  const withEvents = (events: Scenario["stages"][number]["events"]): Scenario => ({ ...base, stages: [{ name: "s", events }] });

  it("rejects non-example.org emails", () => {
    expect(() => replay({ ...base, people: [{ ...base.people[0]!, email: "a@real.edu" }] }, ctx)).toThrow(ScenarioError);
  });
  it("rejects reviews before the request, and score changes before submission", () => {
    expect(() => replay(withEvents([{ type: "review", at: at("reviewDue", -40), pid: 1, email: "a@example.org", scores: { OveMer: 1, RevExp: 1 }, words: 10 }]), ctx)).toThrow(/before the review was requested/);
    expect(() => replay(withEvents([{ type: "scoreChange", at: at("reviewDue", 1), pid: 1, email: "a@example.org", scores: { OveMer: 2 } }]), ctx)).toThrow(/not submitted/);
  });
  it("rejects unordered events on one object and unknown comments", () => {
    const r = { type: "review" as const, at: at("reviewDue", -1), pid: 1, email: "a@example.org", scores: { OveMer: 1, RevExp: 1 }, words: 10 };
    expect(() => replay(withEvents([r, { type: "scoreChange", at: at("reviewDue", -1), pid: 1, email: "a@example.org", scores: { OveMer: 2 } }]), ctx)).toThrow(/strictly later/);
    expect(() => replay(withEvents([{ type: "commentEdit", at: at("reviewDue", 0), key: "x" }]), ctx)).toThrow(/unknown comment/);
  });
  it("rejects responses by non-authors", () => {
    expect(() => replay(withEvents([{ type: "response", key: "r", at: at("reviewDue", 1), pid: 1, email: "a@example.org" }]), ctx)).toThrow(/not an author/);
  });
});

describe("golden scenario", () => {
  const state = replay(golden, ctx);
  const nonAc = [...state.reviews.values()].filter((r) => r.role !== "metareview");

  it("has 12 papers with merits as in expected.ts", () => {
    expect(golden.papers.length).toBe(12);
    for (const pid of Object.keys(FIRES_AT_PRIMARY).map(Number)) {
      const merits = nonAc
        .filter((r) => r.pid === pid && r.status === "complete")
        .map((r) => r.scores!.OveMer!)
        .sort((a, b) => a - b);
      expect(merits, `pid ${pid}`).toEqual(MERITS[pid]);
    }
  });

  it("matches the M4 fixture's schedule", () => {
    const comments = [...state.comments.values()];
    const lastReviewerDay = (pid: number) => {
      const ts = comments.filter((c) => c.pid === pid && !c.response && !c.email.startsWith("ac-")).map((c) => c.createdAt.getTime());
      return ts.length ? local(new Date(Math.max(...ts))) : null;
    };
    for (const pid of [2, 3, 4, 7, 8, 9, 10, 12]) expect(lastReviewerDay(pid), `pid ${pid}`).toBe("2030-02-25T12:00");
    expect(lastReviewerDay(5)).toBeNull();
    expect(lastReviewerDay(11)).toBeNull();
    expect(lastReviewerDay(6)).toBe("2030-02-14T12:00");
    // R-silent never comments; the 4-scorers on 3 and 12 do.
    expect(comments.some((c) => c.email === P.silent)).toBe(false);
    for (const [pid, e] of [[3, P.ben], [3, P.eli], [12, P.eli], [12, P.hal]] as const) {
      expect(comments.some((c) => c.pid === pid && c.email === e), `${e} on ${pid}`).toBe(true);
    }
    const ping = comments.find((c) => c.mentions.includes(P.pinged))!;
    expect([ping.pid, ping.email, local(ping.createdAt)]).toEqual([4, P.acBusy, "2030-02-15T09:00"]);
    const resp = comments.find((c) => c.response)!;
    expect([resp.pid, resp.email, local(resp.createdAt)]).toEqual([11, P.author11, "2030-02-09T12:00"]);
    // Reviews land 2030-01-20 .. 01-29 at 10:00.
    for (const r of nonAc.filter((x) => x.status === "complete")) {
      expect(local(r.submittedAt!)).toMatch(/^2030-01-(2\d)T10:00$/);
    }
    expect(state.decisions).toEqual(new Map([[1, "Accepted"]]));
  });

  it("has the score changes, the empty reciprocal review, and the thin review", () => {
    const silent3 = state.reviews.get(`3:${P.silent}`)!;
    expect(silent3.versions.map((v) => v.scores.OveMer)).toEqual([1, 2]);
    expect(local(silent3.modifiedAt!)).toBe("2030-02-18T12:00");
    expect(state.reviews.get(`12:${P.silent}`)!.versions.map((v) => v.scores.OveMer)).toEqual([1, 2]);
    expect(state.reviews.get(`2:${P.recip}`)!.status).toBe("empty");
    expect(state.reviews.get(`10:${P.hal}`)!.words).toBe(35);
    expect(nonAc.filter((r) => r.words !== undefined && r.words < 200).length).toBe(1);
  });

  it("tags R-silent junior and the laggard reciprocal; nobody else", () => {
    const tagged = golden.people.filter((p) => (p.tags ?? []).length > 0).map((p) => [p.email, p.tags]);
    expect(tagged).toEqual([[P.silent, ["junior"]], [P.recip, ["reciprocal"]]]);
  });
});

describe("multistage scenario", () => {
  it("stage 2 holds a score change, new/edited/deleted comments, and an unassignment", () => {
    const s1 = replay(multistage, ctx, 1);
    const s2 = replay(multistage, ctx, 2);
    expect(local(resolveWhen(STAGE1_NOW, ctx))).toBe("2030-02-15T12:00");
    expect(local(resolveWhen(STAGE2_NOW, ctx))).toBe("2030-02-19T12:00");
    expect(s1.reviews.get("1:ms-ana@example.org")!.scores!.OveMer).toBe(2);
    expect(s2.reviews.get("1:ms-ana@example.org")!.scores!.OveMer).toBe(3);
    expect(s2.reviews.get("2:ms-dee@example.org")!.removed).toBe(true);
    expect(s2.comments.get("ms-c2")!.edits).toBe(1);
    expect(s2.comments.get("ms-c2")!.text).not.toBe(s1.comments.get("ms-c2")!.text);
    expect(s2.comments.get("ms-c5")!.deleted).toBe(true);
    expect([...s2.comments.keys()].filter((k) => !s1.comments.has(k)).sort()).toEqual(["ms-c6", "ms-c7"]);
  });
});

describe("generated scenarios", () => {
  it("shadow: ~150 papers, valid, deterministic", () => {
    expect(shadow.papers.length).toBe(150);
    const st = replay(shadow, ctx);
    expect(st.reviews.size).toBe(600);
    expect(st.comments.size).toBeGreaterThan(200);
  });
  it("scale: 2,400 papers, 40 ACs, 9,600 review rows (2 senior + 1 junior/reciprocal + metareview)", () => {
    expect(scale.papers.length).toBe(2400);
    const roles = scale.assignments.map((a) => a.role);
    expect(roles.length).toBe(9600);
    expect(roles.filter((r) => r === "metareview").length).toBe(2400);
    expect(new Set(scale.assignments.filter((a) => a.role === "metareview").map((a) => a.email)).size).toBe(40);
    expect(() => replay(scale, ctx)).not.toThrow();
  });
});
