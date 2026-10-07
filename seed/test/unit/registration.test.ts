// The `registration` scenario's oracle (PLAN M11), without a harness: the
// scenario replays, its env is valid, and the reserve and quick-reject
// modules, fed the scenario's own data plus the fixture imports and the
// mocked DBLP table, report exactly expected.ts.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fixedClock } from "@pcs/server/clock";
import { loadConfig, loadPhaseConfig } from "@pcs/server/config";
import { importCsv, rowsAsOf } from "@pcs/server/imports/store";
import { trackQuickReject, type QrInput } from "@pcs/server/modules/quickreject/index";
import { checkReserve, hintFrom, type ReserveInput } from "@pcs/server/modules/reserve/index";
import { memoryStore } from "@pcs/server/store/store";
import { scenarioSettings } from "../../src/driver.js";
import { QUICKREJECT_ROUND, type DecisionEvent } from "../../src/format.js";
import { replay } from "../../src/model.js";
import { resolveWhen } from "../../src/time.js";
import {
  EXPECTED_BY_NAME,
  EXPECTED_HINTS,
  EXPECTED_QR_ITEMS,
  EXPECTED_QR_MAIL,
  EXPECTED_QR_OVERDUE,
  EXPECTED_RESERVE_FINDINGS,
  EXPECTED_RESERVE_MAIL,
  EXPECTED_RESERVE_STATES,
  summarizeQr,
  summarizeReserve,
} from "../../scenarios/registration/expected.js";
import { DBLP_MOCK, FIXTURES, OBSERVE_AT, QR_REVIEWS, registrationEnv, scenario } from "../../scenarios/registration/scenario.js";

const CI_ENV = {
  PCS_TZ: "America/New_York",
  PCS_PHASE_REVIEW_DUE: "2030-02-01T23:59",
  PCS_PHASE_DISCUSSION_OPEN: "2030-02-12T00:00",
  PCS_PHASE_DISCUSSION_CLOSE: "2030-03-01T23:59",
  PCS_PHASE_DECISIONS_DUE: "2030-03-03T23:59",
};
const ctx = loadPhaseConfig(CI_ENV);
const cfg = loadConfig({ ...CI_ENV, ...registrationEnv(ctx), NODE_ENV: "test", PCS_HOTCRP_URL: "http://127.0.0.1:1", PCS_HOTCRP_TOKEN: "hct_x" });
const now = resolveWhen(OBSERVE_AT, ctx);

describe("registration scenario format", () => {
  it("replays, with quick-reject reviews in the quickreject round", () => {
    const st = replay(scenario, ctx);
    const qr = [...st.reviews.values()].filter((r) => r.role !== "metareview");
    expect(qr).toHaveLength(QR_REVIEWS.length);
    expect(scenario.assignments.filter((a) => a.round === QUICKREJECT_ROUND)).toHaveLength(QR_REVIEWS.length);
  });

  it("its env puts the quick-reject due date before now, in the assignment phase", () => {
    expect(registrationEnv(ctx)).toEqual({ PCS_PHASE_QUICKREJECT_DUE: "2029-12-28T23:59", PCS_PHASE_ASSIGNMENT_DONE: "2030-01-11T23:59" });
    expect(cfg.phases.quickRejectDue!.getTime()).toBeLessThan(now.getTime());
  });

  it("settings define the three reserve options, the exemption dropdown with its extra choice", () => {
    const s = scenarioSettings(scenario) as { sf: { name: string; values?: { name: string }[] }[] };
    expect(s.sf.map((f) => f.name)).toEqual(["Reserve designee", "Reserve exemption", "Reserve seniority"]);
    expect(s.sf[1]!.values!.map((v) => v.name)).toContain("on-sabbatical");
  });
});

describe("registration scenario oracle (no harness)", () => {
  const store = memoryStore();
  const clock = fixedClock(now);
  for (const kind of ["tpms-registrations", "refcheck"] as const) {
    expect(importCsv(store.db, kind, readFileSync(FIXTURES[kind]), { tz: ctx.tz, clock }).ok).toBe(true);
  }
  const tpms = rowsAsOf(store.db, "tpms-registrations", now);
  const refcheck = rowsAsOf(store.db, "refcheck", now);

  const reserveInput: ReserveInput = {
    papers: scenario.papers.map((p) => ({
      pid: p.pid,
      title: p.title,
      authors: p.authors.map((a) => ({ email: a.email.toLowerCase(), name: `${a.first} ${a.last}` })),
      designee: p.options?.["Reserve designee"],
      exemption: p.options?.["Reserve exemption"],
      seniority: p.options?.["Reserve seniority"],
    })),
    fields: { designee: "text", exemption: "dropdown", seniority: "text" },
    pc: new Set(scenario.people.filter((p) => p.roles.includes("pc")).map((p) => p.email)),
    names: new Map(scenario.people.map((p) => [p.email, `${p.first} ${p.last}`])),
    tpms: { runId: tpms.run!.id, rows: tpms.rows },
  };

  it("reserve compliance flags exactly the planted problems", () => {
    const r = checkReserve(reserveInput, cfg.reserve!);
    expect(summarizeReserve(r)).toEqual([...EXPECTED_RESERVE_FINDINGS].sort());
    for (const p of r.papers) expect([p.pid, p.state]).toEqual([p.pid, EXPECTED_RESERVE_STATES[p.pid] ?? "designee"]);
    const byName = r.papers.find((p) => p.pid === EXPECTED_BY_NAME.pid)!;
    expect([byName.designee, byName.identifiedBy]).toEqual([EXPECTED_BY_NAME.email, "name"]);
    expect(Object.fromEntries(r.mailDrafts.map((d) => [d.code, d.search]))).toEqual(EXPECTED_RESERVE_MAIL);
  });

  it("DBLP hints (mocked table) attach as hints, never as findings", () => {
    const table = DBLP_MOCK as Record<string, { venues: Record<string, number>; matchedPapers: number }>;
    const hints = (name: string) => (table[name] ? hintFrom(name, "mock", table[name], cfg.reserve!.dblp.seniorMin) : undefined);
    const r = checkReserve(reserveInput, { ...cfg.reserve!, dblp: { ...cfg.reserve!.dblp, enabled: true } }, hints);
    expect(summarizeReserve(r)).toEqual([...EXPECTED_RESERVE_FINDINGS].sort());
    const p11 = r.papers.find((p) => p.pid === 11)!;
    expect(p11.hints.map((h) => ({ name: h.name, atVenues: h.atVenues, possiblySenior: h.possiblySenior }))).toEqual(EXPECTED_HINTS.paper11);
    expect(
      r.designees.filter((d) => d.hint).map((d) => ({ email: d.email, atVenues: d.hint!.atVenues, possiblySenior: d.hint!.possiblySenior })),
    ).toEqual(EXPECTED_HINTS.designees);
    for (const h of [...p11.hints, ...r.designees.flatMap((d) => (d.hint ? [d.hint] : []))]) expect(h.text).toMatch(/not a verdict/);
  });

  it("the quick-reject queue holds exactly the planted items", () => {
    const decisions = new Map(
      scenario.stages.flatMap((s) => s.events).filter((e): e is DecisionEvent => e.type === "decision").map((e) => [e.pid, e.decision]),
    );
    const acs = new Map(scenario.assignments.filter((a) => a.role === "metareview").map((a) => [a.pid, [a.email]]));
    const input: QrInput = {
      papers: scenario.papers.map((p) => ({ pid: p.pid, title: p.title, decision: decisions.get(p.pid) ?? null, tags: p.tags ?? [], acs: acs.get(p.pid) ?? [] })),
      reviews: QR_REVIEWS.map((q, i) => ({ rid: 100 + i, pid: q.pid, email: q.email, status: q.merit === null ? "empty" : "complete", value: q.merit })),
      refcheck: { runId: refcheck.run!.id, rows: refcheck.rows },
      due: cfg.phases.quickRejectDue!.getTime(),
      now: now.getTime(),
    };
    const s = summarizeQr(trackQuickReject(input, cfg.quickReject!));
    expect(s.items).toEqual(EXPECTED_QR_ITEMS);
    expect(s.overdue).toEqual(EXPECTED_QR_OVERDUE);
    expect(s.mail).toEqual(EXPECTED_QR_MAIL);
  });
});
