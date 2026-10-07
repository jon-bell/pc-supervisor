// PLAN M10 acceptance on the local harness: seed the `assignment` scenario
// (after a reset), verify it through the API, sync it into a fresh store,
// import the fixture CSVs, run the validator on the HotCRP assignment and on
// the TPMS proposal, and check that every planted problem is flagged and
// nothing else. Then dry-run both generated fix-up CSVs with
// POST /assign?dry_run=1 (harness only) and check HotCRP accepts them.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixedClock } from "@pcs/server/clock";
import { loadConfig, type Config } from "@pcs/server/config";
import { clientFromConfig } from "@pcs/server/hotcrp/client";
import { assertHarnessUrl } from "@pcs/server/hotcrp/harness-guard";
import { importCsv } from "@pcs/server/imports/store";
import { validateAssignments, type AssignmentReport } from "@pcs/server/modules/assignment/index";
import { openStore, type Store } from "@pcs/server/store/store";
import { paperAuthors, paperOptions } from "@pcs/server/store/submissions";
import { clientSource } from "@pcs/server/sync/source";
import { runSync } from "@pcs/server/sync/sync";
import { seedContextFromEnv, seedScenario } from "../../src/driver.js";
import { RESERVE_DESIGNEE_FIELD, RESERVE_EXEMPTION_FIELD } from "../../src/format.js";
import { resolveWhen } from "../../src/time.js";
import { verifyScenario } from "../../src/verify.js";
import { EXPECTED_HOTCRP, EXPECTED_TPMS, EXPECTED_TPMS_FIXUP } from "../../scenarios/assignment/expected.js";
import { A, ASSIGNMENT_ENV, FIXTURES, SHARED_AFFILIATION, scenario } from "../../scenarios/assignment/scenario.js";

const sc = seedContextFromEnv();
let dir: string;
let store: Store;
let cfg: Config;
const clock = fixedClock(resolveWhen(scenario.stages[0]!.now!, sc.ctx));

const summary = (r: AssignmentReport) => r.findings.map((f) => `${f.code} ${f.pid ?? "-"} ${f.emails.join(" ")}`).sort();

beforeAll(async () => {
  await seedScenario(scenario, { reset: true });
  dir = mkdtempSync(join(tmpdir(), "pcs-m10-int-"));
  cfg = loadConfig({ ...process.env, ...ASSIGNMENT_ENV, PCS_DB_PATH: join(dir, "pcs.db"), PCS_DB_KEY: "m10-integration-key" });
  store = openStore(cfg);
  const r = await runSync(store.db, clientSource(clientFromConfig(cfg.hotcrp)), {
    clock,
    chunkSize: cfg.sync.chunk,
    concurrency: cfg.sync.concurrency,
    tierTags: cfg.tierTags,
    acRole: cfg.acRole,
  });
  expect(r.ok, r.errors.join("; ")).toBe(true);
  for (const kind of ["invites", "do-not-invite", "tpms-assignments"] as const) {
    const res = importCsv(store.db, kind, readFileSync(FIXTURES[kind]), { tz: cfg.tz, clock });
    expect(res.ok).toBe(true);
  }
}, 180_000);

afterAll(() => {
  store?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("assignment scenario: seeding and sync", () => {
  it("the harness holds exactly the scenario (authors, options, rounds included)", async () => {
    expect((await verifyScenario(scenario, sc.ctx)).problems).toEqual([]);
  });

  it("sync stores authors with affiliations, option values, rounds, tiers, and PC affiliations", () => {
    const authors = paperAuthors(store.db, { pids: [1, 4] });
    expect(authors.map((a) => [a.pid, a.email])).toEqual([
      [1, A.s2],
      [1, A.a1],
      [4, A.a4],
    ]);
    expect(authors.find((a) => a.email === A.a4)!.affiliation).toBe(SHARED_AFFILIATION);
    expect(paperOptions(store.db, { name: RESERVE_DESIGNEE_FIELD.name }).map((o) => [o.pid, o.value])).toEqual(
      [1, 2, 3, 4, 6, 7, 8].map((pid) => [pid, scenario.papers.find((p) => p.pid === pid)!.authors[0]!.email]),
    );
    expect(paperOptions(store.db, { name: RESERVE_EXEMPTION_FIELD.name }).map((o) => [o.pid, o.value])).toEqual([[5, "no-eligible-author"]]);
    const people = new Map(store.people().map((p) => [p.email, p]));
    expect([A.j1, A.r1, A.s1].map((e) => people.get(e)!.tier)).toEqual(["junior", "reserve-active", "senior"]);
    expect(people.get(A.s1)!.affiliation).toBe(SHARED_AFFILIATION);
    const rounds = store.db.prepare("select pid, email, round from review where round is not null").all();
    expect(rounds).toEqual([{ pid: 1, email: A.ac1, round: "quickreject" }]);
  });
});

describe("assignment scenario: validator", () => {
  it("flags every planted problem in the HotCRP assignment, and nothing else", () => {
    const r = validateAssignments(store, cfg, { source: "hotcrp", clock });
    expect(summary(r)).toEqual([...EXPECTED_HOTCRP].sort());
    expect(r.notes).toEqual([]);
    for (const f of r.findings) expect(f.reason).toMatch(/\d/);
  });

  it("flags every planted problem in the TPMS proposal, and emits the expected fix-up", () => {
    const r = validateAssignments(store, cfg, { source: "tpms", clock });
    expect(summary(r)).toEqual([...EXPECTED_TPMS].sort());
    expect(r.fixup.csv).toBe(`${EXPECTED_TPMS_FIXUP.join("\n")}\n`);
    expect(r.fixup.keptStarted).toEqual([]);
  });
});

describe("assignment scenario: HotCRP accepts the fix-up CSVs (dry run only)", () => {
  for (const source of ["hotcrp", "tpms"] as const) {
    it(`POST /assign?dry_run=1 with the ${source} fix-up: valid, no errors, nothing changed`, async () => {
      assertHarnessUrl();
      const client = clientFromConfig(cfg.hotcrp);
      const before = await client.pcAssignments({ t: "all" });
      const report = validateAssignments(store, cfg, { source, clock });
      const res = await client.assign(report.fixup.csv, { dryRun: true });
      expect(res.message_list?.filter((m) => m.status >= 2) ?? []).toEqual([]);
      expect(res).toMatchObject({ ok: true, dry_run: true, valid: true });
      // HotCRP would apply exactly the changing lines (not the unchanged ones).
      expect(res.assignment_count).toBeGreaterThan(0);
      expect(await client.pcAssignments({ t: "all" })).toEqual(before);
    });
  }
});
