// PLAN M10b acceptance on the local harness: seed the `assignment` scenario
// (after a reset), sync it into a fresh store, import its invites,
// do-not-invite, and synthetic tpms-scores fixtures, and run the solver with
// HotCRP's live PC conflicts and preferences. Then check the done criterion:
// every paper meets its composition or is reported with a reason, no band is
// exceeded, no conflicted / do-not-invite / unapproved-reserve edge appears,
// the planted reciprocal 2- and 3-cycles are broken, M10's validator finds
// nothing unexplained, and the bulk-assign CSV passes POST /assign?dry_run=1
// (harness only; nothing is applied).

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixedClock } from "@pcs/server/clock";
import { loadConfig, type Config } from "@pcs/server/config";
import { clientFromConfig, type HotcrpClient } from "@pcs/server/hotcrp/client";
import { assertHarnessUrl } from "@pcs/server/hotcrp/harness-guard";
import { importCsv } from "@pcs/server/imports/store";
import { findCycles } from "@pcs/server/modules/assignment/index";
import { normalizeAffiliation } from "@pcs/server/modules/assignment/validate";
import { solveAssignments, type SolveReport } from "@pcs/server/modules/solver/index";
import { openStore, type Store } from "@pcs/server/store/store";
import { clientSource } from "@pcs/server/sync/source";
import { runSync } from "@pcs/server/sync/sync";
import { seedScenario } from "../../src/driver.js";
import { resolveWhen } from "../../src/time.js";
import { seedContextFromEnv } from "../../src/driver.js";
import { A, ASSIGNMENT_ENV, FIXTURES, PANELS, scenario } from "../../scenarios/assignment/scenario.js";

const sc = seedContextFromEnv();
let dir: string;
let store: Store;
let cfg: Config;
let client: HotcrpClient;
let report: SolveReport;
const clock = fixedClock(resolveWhen(scenario.stages[0]!.now!, sc.ctx));

beforeAll(async () => {
  await seedScenario(scenario, { reset: true });
  dir = mkdtempSync(join(tmpdir(), "pcs-m10b-int-"));
  cfg = loadConfig({ ...process.env, ...ASSIGNMENT_ENV, PCS_DB_PATH: join(dir, "pcs.db"), PCS_DB_KEY: "m10b-integration-key" });
  store = openStore(cfg);
  client = clientFromConfig(cfg.hotcrp);
  const r = await runSync(store.db, clientSource(client), {
    clock,
    chunkSize: cfg.sync.chunk,
    concurrency: cfg.sync.concurrency,
    tierTags: cfg.tierTags,
    acRole: cfg.acRole,
  });
  expect(r.ok, r.errors.join("; ")).toBe(true);
  for (const kind of ["invites", "do-not-invite", "tpms-scores"] as const) {
    const res = importCsv(store.db, kind, readFileSync(FIXTURES[kind]), { tz: cfg.tz, clock });
    expect(res.ok).toBe(true);
  }
  report = await solveAssignments(store, cfg, { clock, client });
}, 180_000);

afterAll(() => {
  store?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("assignment scenario: solver (PLAN M10b done criterion)", () => {
  it("solves softly, with the imported scores and HotCRP's conflicts", () => {
    expect(report.feasible).toBe(true);
    expect(report.mode).toBe("soft");
    expect(report.sources.tpmsRunId).not.toBeNull();
    expect(report.sources.conflicts).toBeGreaterThan(0); // the PC authors' own papers
    expect(report.counts.papers).toBe(8);
  });

  it("every paper meets its composition or is reported with a reason", () => {
    const unmet = new Set(report.unmet.map((u) => `${u.pid}\t${u.slot}`));
    for (let pid = 1; pid <= 8; pid++) {
      const rows = report.assignments.filter((a) => a.pid === pid);
      const s = rows.filter((a) => a.slot === "senior").length;
      if (s < cfg.assignment!.minSenior) expect(unmet.has(`${pid}\tsenior`)).toBe(true);
      if (rows.length - s < 1) expect(unmet.has(`${pid}\tthird`)).toBe(true);
      expect(rows.length - s).toBeLessThanOrEqual(1);
    }
    for (const u of report.unmet) expect(u.reason).toMatch(/\d/);
  });

  it("no band is exceeded", () => {
    for (const t of report.load) expect(t.over, t.tier).toBe(0);
    const load = new Map<string, number>();
    for (const a of report.assignments) load.set(a.email, (load.get(a.email) ?? 0) + 1);
    // sofia.lund reviews 4 papers in HotCRP; PCS_LOAD_SENIOR_MAX=3 here.
    expect(load.get(A.s1) ?? 0).toBeLessThanOrEqual(3);
  });

  it("no conflicted, do-not-invite, or unapproved-reserve edge appears", () => {
    const pairs = new Set(report.assignments.map((a) => `${a.pid}\t${a.email}`));
    // Authors never review their own paper (HotCRP author conflicts).
    for (const p of scenario.papers) for (const au of p.authors) expect(pairs.has(`${p.pid}\t${au.email}`)).toBe(false);
    // Same affiliation: sofia.lund and the author of #4.
    expect(pairs.has(`4\t${A.s1}`)).toBe(false);
    // greta.holm is approved and activated on #6 but on do-not-invite: never assigned, reported as a pin issue.
    expect(report.assignments.some((a) => a.email === A.r3)).toBe(false);
    expect(report.pinIssues.map((p) => [p.pid, p.email])).toContainEqual([6, A.r3]);
    // nora.quist is only "pending" on #3; felix.adeyemi is approved for #4 only (rejected on #2).
    expect(report.assignments.some((a) => a.email === A.r1)).toBe(false);
    expect(report.assignments.filter((a) => a.email === A.r2).map((a) => [a.pid, a.pinned])).toEqual([[4, "reserve"]]);
    // No two reviewers of a paper share an institution.
    const people = new Map(store.people().map((p) => [p.email, p]));
    for (let pid = 1; pid <= 8; pid++) {
      const affs = report.assignments.filter((a) => a.pid === pid).map((a) => normalizeAffiliation(people.get(a.email)!.affiliation));
      expect(new Set(affs).size).toBe(affs.length);
    }
  });

  it("the planted reciprocal 2- and 3-cycles are broken by the repair pass", () => {
    // Without repairs, the current panels (scored 0.90) would be kept.
    expect(report.repairs.filter((r) => r.kind === "cycle").length).toBeGreaterThanOrEqual(2);
    expect(report.unresolved).toEqual([]);
    const authors = new Map(scenario.papers.map((p) => [p.pid, p.authors.map((a) => a.email)]));
    const edges = report.assignments.flatMap((a) => authors.get(a.pid)!.filter((au) => au !== a.email).map((au) => ({ from: au, to: a.email, pid: a.pid })));
    expect(findCycles(edges, 6, 100).cycles).toEqual([]);
    // The planted 2-cycle (s2 authors #1 reviewed by s3; s3 authors #2 reviewed by s2) is gone.
    expect(PANELS[1]).toContain("s3");
    const pairs = new Set(report.assignments.map((a) => `${a.pid}\t${a.email}`));
    expect(pairs.has(`1\t${A.s3}`) && pairs.has(`2\t${A.s2}`)).toBe(false);
  });

  it("M10's validator finds nothing unexplained in the solved assignment", () => {
    expect(report.crossCheck.findings.filter((f) => f.explainedBy === null)).toEqual([]);
    expect(report.crossCheck.findings.some((f) => f.code === "RECIPROCAL_CYCLE")).toBe(false);
  });

  it("the bulk-assign CSV passes POST /assign?dry_run=1 and changes nothing", async () => {
    assertHarnessUrl();
    expect(report.csv.split("\n")[0]).toBe("paper,action,email,round");
    const before = await client.pcAssignments({ t: "all" });
    const res = await client.assign(report.csv, { dryRun: true });
    expect(res.message_list?.filter((m) => m.status >= 2) ?? []).toEqual([]);
    expect(res).toMatchObject({ ok: true, dry_run: true, valid: true });
    expect(res.assignment_count).toBeGreaterThan(0);
    expect(await client.pcAssignments({ t: "all" })).toEqual(before);
  });
});
