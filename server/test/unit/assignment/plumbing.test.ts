// M10 plumbing: config, the /assign dry-run client method, the submissions
// sync (authors, options, submission fields), and the store -> validator
// loader end to end on an in-memory store. Synthetic data only.

import { describe, expect, it } from "vitest";
import { describeReport } from "../../../src/cli/assignment-command.js";
import { fixedClock } from "../../../src/clock.js";
import { DEFAULT_ASSIGNMENT_POLICY, loadConfig, type ConfigError } from "../../../src/config.js";
import { HotcrpClient } from "../../../src/hotcrp/client.js";
import { HotcrpError } from "../../../src/hotcrp/errors.js";
import type { Paper, SettingsSfResponse } from "../../../src/hotcrp/schemas.js";
import { importCsv } from "../../../src/imports/store.js";
import { NoTpmsImportError, validateAssignments } from "../../../src/modules/assignment/index.js";
import { memoryStore } from "../../../src/store/store.js";
import { paperAuthors, paperOptions, submissionFields } from "../../../src/store/submissions.js";
import { runSync, type SyncOptions } from "../../../src/sync/sync.js";
import { BASE_ENV } from "../env.js";
import { FakeHotcrp } from "../fake-source.js";

const T1 = new Date("2030-01-10T12:00:00Z");
const T2 = new Date("2030-01-11T12:00:00Z");

describe("config: assignment policy", () => {
  const load = (over: Record<string, string> = {}) => loadConfig({ ...BASE_ENV, ...over }, { home: "/h" });

  it("has the documented defaults", () => {
    expect(load().assignment).toEqual(DEFAULT_ASSIGNMENT_POLICY);
    expect(DEFAULT_ASSIGNMENT_POLICY).toMatchObject({
      minSenior: 2,
      thirdSlot: "exactly1",
      cycleMaxK: 3,
      affiliationConflicts: true,
      dblpConflicts: false,
      load: { senior: { min: 4, max: 12 }, junior: { min: 2, max: 8 }, "reserve-active": { min: 1, max: 3 }, "reserve-pool": { min: 0, max: 0 } },
    });
  });

  it("parses overrides and rejects bad values and min > max", () => {
    const c = load({ PCS_POLICY_THIRD_SLOT: "AtLeast1", PCS_LOAD_JUNIOR_MAX: "5", PCS_CYCLE_MAX_K: "4" });
    expect(c.assignment).toMatchObject({ thirdSlot: "atleast1", cycleMaxK: 4, load: { junior: { min: 2, max: 5 } } });
    let problems: string[] = [];
    try {
      load({ PCS_POLICY_THIRD_SLOT: "two", PCS_LOAD_SENIOR_MIN: "9", PCS_LOAD_SENIOR_MAX: "3", PCS_CYCLE_MAX_K: "9" });
    } catch (e) {
      problems = (e as ConfigError).problems.map((p) => `${p.name}: ${p.message}`);
    }
    expect(problems).toEqual([
      'PCS_POLICY_THIRD_SLOT: expected exactly1 or atleast1, got "two"',
      "PCS_CYCLE_MAX_K: expected an integer from 2 to 6, got \"9\"",
      "PCS_LOAD_SENIOR_MAX: must not be less than PCS_LOAD_SENIOR_MIN (9)",
    ]);
  });
});

describe("HotcrpClient.assign (dry run only)", () => {
  const TOKEN = "hct_UnitTestSecretToken0123456789abcdef";
  const make = (reply: unknown, seen: { url?: URL; body?: string; headers?: Headers }[]) =>
    new HotcrpClient({
      baseUrl: "http://127.0.0.1:8080",
      token: TOKEN,
      fetch: (async (input: string | URL, init?: RequestInit) => {
        seen.push({ url: new URL(String(input)), body: String(init?.body), headers: new Headers(init?.headers) });
        return new Response(JSON.stringify(reply), { status: 200 });
      }) as typeof fetch,
    });

  it("refuses anything but a dry run, without a request", async () => {
    const seen: unknown[] = [];
    await expect(make({}, seen as never).assign("paper,action,user\n", { dryRun: false })).rejects.toMatchObject({ kind: "writes_disabled" });
    expect(seen).toEqual([]);
  });

  it("POSTs the CSV rows as JSON with dry_run=1 and forceShow=0, and returns an invalid result instead of throwing", async () => {
    const seen: { url?: URL; body?: string; headers?: Headers }[] = [];
    const reply = { ok: false, dry_run: true, valid: false, message_list: [{ status: 2, message: "<0>conflicted" }] };
    const r = await make(reply, seen).assign("paper,action,user\n1,primary,a@example.org\n", { dryRun: true });
    expect(r).toMatchObject({ valid: false, dry_run: true });
    expect(seen[0]!.url!.pathname).toBe("/api/assign");
    expect(Object.fromEntries(seen[0]!.url!.searchParams)).toMatchObject({ dry_run: "1", forceShow: "0", format: "json" });
    expect(JSON.parse(seen[0]!.body!)).toEqual([{ paper: "1", action: "primary", user: "a@example.org" }]);
    expect(seen[0]!.headers!.get("content-type")).toBe("application/json");
  });

  it("an invalid dry run comes back as HTTP 403 with a result body: still a result; other 403s still throw", async () => {
    const mk = (body: unknown) =>
      new HotcrpClient({
        baseUrl: "http://127.0.0.1:8080",
        token: TOKEN,
        fetch: (async () => new Response(JSON.stringify(body), { status: 403 })) as unknown as typeof fetch,
      });
    const r = await mk({ ok: false, dry_run: true, valid: false, message_list: [{ status: 2, message: "<0>conflicted" }] }).assign("paper,action,user\n", { dryRun: true });
    expect(r.valid).toBe(false);
    await expect(mk({ ok: false, message_list: [{ status: 2, message: "<0>Forbidden" }] }).assign("paper,action,user\n", { dryRun: true })).rejects.toMatchObject({
      kind: "http",
      status: 403,
    });
  });

  it("treats a response without dry_run: true as a protocol error", async () => {
    await expect(make({ ok: true, valid: true }, []).assign("paper,action,user\n", { dryRun: true })).rejects.toBeInstanceOf(HotcrpError);
  });
});

/** FakeHotcrp plus the two optional M10 endpoints. */
class FakeWithSubmissions extends FakeHotcrp {
  details: Paper[] = [];
  sf: SettingsSfResponse = { ok: true, settings: { sf: [] } };
  async paperDetails(q: string): Promise<Paper[]> {
    this.calls.push("papers");
    const m = /^(\d+)(?:-(\d+))?$/.exec(q)!;
    const [lo, hi] = [Number(m[1]), Number(m[2] ?? m[1])];
    return structuredClone(this.details.filter((p) => p.pid >= lo && p.pid <= hi));
  }
  async submissionFields(): Promise<SettingsSfResponse> {
    this.calls.push("sf");
    return structuredClone(this.sf);
  }
}

const sync = (store: ReturnType<typeof memoryStore>, src: FakeHotcrp, at: Date, extra: Partial<SyncOptions> = {}) =>
  runSync(store.db, src, {
    clock: fixedClock(at),
    chunkSize: 2,
    concurrency: 2,
    tierTags: { junior: "junior", "reserve-active": "reserveactive" },
    acRole: { kind: "meta" },
    ...extra,
  });

function world(): FakeWithSubmissions {
  const f = new FakeWithSubmissions();
  f.people = [
    { name: "Ada Chair", email: "ada@example.org", chair: true },
    { name: "Ben Area", email: "ben@example.org" },
    { name: "Sam Senior", email: "sam@example.org" },
    { name: "Sue Senior", email: "sue@example.org" },
    { name: "Jo Junior", email: "jo@example.org", tags: ["junior"] },
    { name: "Ria Reserve", email: "ria@example.org", tags: ["reserveactive"] },
  ];
  f.papersList = [
    { pid: 1, title: "One" },
    { pid: 2, title: "Two" },
  ];
  f.assignmentRows = [
    { paper: 1, action: "metareview", email: "ben@example.org" },
    { paper: 1, action: "primaryreview", email: "sam@example.org" },
    { paper: 1, action: "secondaryreview", email: "sue@example.org" },
    { paper: 1, action: "pcreview", email: "ria@example.org" },
    { paper: 2, action: "primaryreview", email: "sam@example.org" },
    { paper: 2, action: "pcreview", email: "jo@example.org" },
  ];
  let rid = 1;
  for (const a of f.assignmentRows) {
    f.review({ pid: a.paper, rid: rid++, reviewer_email: a.email!, status: "empty", rtype: a.action === "metareview" ? 5 : 2, ...(a.paper === 2 ? { round: "quickreject" } : {}) });
  }
  f.sf = {
    ok: true,
    settings: {
      sf: [
        { id: "title", name: "Title" },
        { id: 1, name: "Reserve designee", type: "text" },
        { id: 2, name: "Reserve exemption", type: "dropdown", values: [{ id: 1, name: "other" }] },
        { id: 3, name: "Supplement", type: "attachments" },
      ],
    },
  };
  f.details = [
    {
      object: "paper",
      pid: 1,
      authors: [
        { email: "Sue@Example.org", given_name: "Sue", family_name: "Senior", affiliation: "U One" },
        { given_name: "No", family_name: "Email", affiliation: "U Two" },
      ],
      "Reserve designee": "sue@example.org",
      abstract: "not stored",
    } as Paper,
    { object: "paper", pid: 2, authors: [{ email: "kim@example.org", affiliation: "U Three" }], "Reserve exemption": "other" } as Paper,
  ];
  return f;
}

describe("sync: authors, submission options, fields (migration 4)", () => {
  it("stores authors with affiliations, scalar options by name, and data-valued fields only", async () => {
    const store = memoryStore();
    const f = world();
    const r = await sync(store, f, T1);
    expect(r.ok, r.errors.join(";")).toBe(true);
    expect(r.counts).toMatchObject({ authors_new: 3, options_new: 2, submission_fields_new: 2, paper_details_fetched: 2 });
    expect(paperAuthors(store.db)).toEqual([
      { pid: 1, ord: 0, email: "sue@example.org", name: "Sue Senior", affiliation: "U One" },
      { pid: 1, ord: 1, email: null, name: "No Email", affiliation: "U Two" },
      { pid: 2, ord: 0, email: "kim@example.org", name: null, affiliation: "U Three" },
    ]);
    expect(paperOptions(store.db).map((o) => [o.pid, o.name, o.value])).toEqual([
      [1, "Reserve designee", "sue@example.org"],
      [2, "Reserve exemption", "other"],
    ]);
    expect(submissionFields(store.db)).toEqual([
      { name: "Reserve designee", sfId: 1, type: "text", values: null },
      { name: "Reserve exemption", sfId: 2, type: "dropdown", values: ["other"] },
    ]);
    // Abstracts never reach the store.
    const dump = JSON.stringify(store.db.prepare("select * from paper_option").all()) + JSON.stringify(store.db.prepare("select * from paper_author").all());
    expect(dump).not.toContain("not stored");
    // Review rounds were already synced per review.
    expect((store.db.prepare("select distinct round from review where pid = 2").all() as { round: string }[]).map((x) => x.round)).toEqual(["quickreject"]);

    // Idempotent; then changes are tracked (nothing deleted).
    expect((await sync(store, f, T2)).counts).not.toHaveProperty("authors_new");
    f.details[0]!.authors = [{ email: "sue@example.org", given_name: "Sue", family_name: "Senior", affiliation: "U Four" }];
    delete (f.details[0] as Record<string, unknown>)["Reserve designee"];
    const r3 = await sync(store, f, T2);
    expect(r3.counts).toMatchObject({ authors_changed: 1, authors_removed: 1, options_removed: 1 });
    expect(paperAuthors(store.db, { pids: [1] })).toEqual([{ pid: 1, ord: 0, email: "sue@example.org", name: "Sue Senior", affiliation: "U Four" }]);
    expect((store.db.prepare("select count(*) as n from paper_author").get() as { n: number }).n).toBe(3);
  });

  it("keeps authors when /papers hides them (no forceShow) and warns", async () => {
    const store = memoryStore();
    const f = world();
    await sync(store, f, T1);
    for (const p of f.details) delete p.authors;
    const r = await sync(store, f, T2);
    expect(r.ok).toBe(true);
    expect(r.errors[0]).toMatch(/authors not visible on 2 paper\(s\)/);
    expect(paperAuthors(store.db)).toHaveLength(3);
  });

  it("a source without the optional endpoints still syncs (older fakes)", async () => {
    const store = memoryStore();
    const f = new FakeHotcrp();
    f.people = [{ name: "A", email: "a@example.org" }];
    expect((await sync(store, f, T1)).ok).toBe(true);
  });
});

describe("validateAssignments over the store", () => {
  it("reads the synced assignment, tiers, ACs, authors, and the latest imports", async () => {
    const store = memoryStore();
    const f = world();
    await sync(store, f, T1);
    const cfg = {
      acRole: { kind: "meta" } as const,
      assignment: { ...DEFAULT_ASSIGNMENT_POLICY, load: { ...DEFAULT_ASSIGNMENT_POLICY.load, senior: { min: 1, max: 1 }, junior: { min: 0, max: 5 } } },
    };
    const clock = fixedClock(T2);
    const r = validateAssignments(store, cfg, { source: "hotcrp", clock });
    // sue is an author of #1 and reviews it; ria is a reserve with no invites import; sam reviews 2 (max 1).
    expect(r.findings.map((x) => `${x.code} ${x.pid ?? "-"} ${x.emails[0]}`)).toEqual([
      "SENIOR_MISSING 2 jo@example.org",
      "LOAD_OVER - sam@example.org",
      "AUTHOR_IS_REVIEWER 1 sue@example.org",
      "RESERVE_NOT_APPROVED 1 ria@example.org",
    ]);
    // ben (AC) and ada (chair) are exempt from load bands.
    expect(r.findings.some((x) => x.emails.includes("ben@example.org"))).toBe(false);

    const tz = { tz: "UTC", clock: fixedClock(T1) };
    importCsv(store.db, "invites", "pid,candidate_email,ac_decision,response\n1,ria@example.org,approve,accept\n", tz);
    importCsv(store.db, "tpms-assignments", "pid,email,score\n2,sue@example.org,0.9\n2,sam@example.org,0.8\n2,jo@example.org,0.5\n", tz);
    const r2 = validateAssignments(store, cfg, { source: "hotcrp", clock });
    expect(r2.findings.some((x) => x.code === "RESERVE_NOT_APPROVED")).toBe(false);
    expect(r2.imports.invitesRunId).toBe(1);

    const t = validateAssignments(store, cfg, { source: "tpms", clock });
    expect(t.imports.tpmsRunId).toBe(2);
    expect(t.fixup.csv).toBe("paper,action,user\n2,primary,sue@example.org\n2,primary,sam@example.org\n2,pcreview,jo@example.org\n");
    const text = describeReport(t).join("\n");
    expect(text).toContain("Validated TPMS proposal (import #2): 2 papers, 3 assignment rows");
    expect(text).toContain("No findings.");
  });

  it("source tpms without an import is a clear error", () => {
    const store = memoryStore();
    expect(() => validateAssignments(store, { acRole: { kind: "meta" } }, { source: "tpms", clock: fixedClock(T1) })).toThrow(NoTpmsImportError);
  });
});
