// PLAN M13: the pseudonymous export (no email, name, title, or text anywhere;
// HMAC pseudonyms stable per key and different across keys), the cell
// validator, the zip, the do-not-invite carry-forward, GET /api/report and the
// download routes, and the CLI renderer. Over the fake HotCRP smallWorld synced
// into memory (as server-progress.test.ts). Synthetic data only.
import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { describeReport } from "../../src/cli/report-command.js";
import { fixedClock } from "../../src/clock.js";
import { ConfigError, loadConfig, type Config } from "../../src/config.js";
import { importCsv, rowsAsOf } from "../../src/imports/store.js";
import { formatter } from "../../src/modules/early-reject/index.js";
import {
  doNotInviteCsv,
  EXPORT_FILE_NAMES,
  exportFiles,
  exportZip,
  normalizeEmail,
  processReport,
  pseudonym,
  PseudonymKeyMissingError,
  toCsv,
  unzip,
  type ExportFiles,
  type ProcessReport,
} from "../../src/modules/report/index.js";
import { buildExport, ExportCellError, OTHER_TIER, type Column } from "../../src/modules/report/export.js";
import { pseudonymizer } from "../../src/modules/report/pseudonym.js";
import type { ReviewFact } from "../../src/modules/report/compute.js";
import { buildApp, type App } from "../../src/server/app.js";
import { memoryStore, type Store } from "../../src/store/store.js";
import { runSync } from "../../src/sync/sync.js";
import { RULES_ENV } from "../fixtures/builder.js";
import { smallWorld } from "./fake-source.js";

const TOKEN = RULES_ENV.PCS_HOTCRP_TOKEN!;
const KEY = "unit-test-pseudonym-key-0123456789";
const KEY2 = "another-unit-test-key-9876543210";
/** Every name, email, title and text in smallWorld: none may appear in the report or the export. */
const SENSITIVE = [
  "Ada Chair",
  "Ben Area",
  "Cy Junior",
  "Dee Recip",
  "Eve Senior",
  "Ada",
  "Ben",
  "Cy",
  "Dee",
  "Eve",
  "ada@example.org",
  "ben@example.org",
  "cy@example.org",
  "dee@example.org",
  "eve@example.org",
  "example.org",
  "Paper One",
  "Paper Two",
  "Paper Three",
  "Short summary here",
  "Needs more evaluation",
  "A solid paper",
  "baselines are weak",
  "thoughts?",
  "can you say more",
];
const EMAILS = SENSITIVE.filter((s) => s.endsWith("@example.org"));
const DNI = "email,reason,source\nmallory.stone@example.org,\"no-show, twice\",ConfX 2029\npeggy.lark@example.org,,\n";

let store: Store;
const env = (over: Record<string, string> = {}): Config =>
  loadConfig({ ...RULES_ENV, PCS_NOW: "2030-03-10T12:00", PCS_TIER_TAGS: "junior=junior,reciprocal=reciprocal", ...over });
const clock = fixedClock(new Date("2030-03-10T17:00:00Z"));

beforeAll(async () => {
  store = memoryStore();
  const cfg = env();
  const r = await runSync(store.db, smallWorld(), { clock: fixedClock(new Date("2030-02-14T12:00:00Z")), chunkSize: 200, concurrency: 2, tierTags: cfg.tierTags, acRole: cfg.acRole });
  expect(r.ok).toBe(true);
  const imp = importCsv(store.db, "do-not-invite", DNI, { tz: cfg.tz, clock: fixedClock(new Date("2030-02-15T12:00:00Z")), fileName: "dni.csv" });
  expect(imp.ok).toBe(true);
});
afterAll(() => store.close());

/** Every cell of every exported file (README included, line by line). */
function cells(files: ExportFiles): string[] {
  return EXPORT_FILE_NAMES.flatMap((n) => (n.endsWith(".csv") ? files[n].trimEnd().split("\n").flatMap((l) => l.split(",")) : files[n].split("\n")));
}

/** Full names, emails, titles, and text as substrings; bare first names as whole words. */
function assertClean(text: string, what: string) {
  for (const s of SENSITIVE) {
    const hit = /^[A-Z][a-z]+$/.test(s) ? new RegExp(`\\b${s}\\b`).test(text) : text.includes(s);
    expect(hit, `${what} contains "${s}"`).toBe(false);
  }
}

describe("pseudonyms", () => {
  it("HMAC-SHA256 of the normalized email, hex", () => {
    expect(normalizeEmail("  Eve@Example.ORG ")).toBe("eve@example.org");
    expect(pseudonym(KEY, " EVE@example.org")).toBe(createHmac("sha256", KEY).update("eve@example.org").digest("hex"));
    expect(pseudonym(KEY, "eve@example.org")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("stable for a key, different across keys", () => {
    expect(pseudonym(KEY, "eve@example.org")).toBe(pseudonym(KEY, "eve@example.org"));
    expect(pseudonym(KEY, "eve@example.org")).not.toBe(pseudonym(KEY2, "eve@example.org"));
    expect(pseudonym(KEY, "eve@example.org")).not.toBe(pseudonym(KEY, "dee@example.org"));
  });

  it("refuses to run without a key, with a clear error", () => {
    expect(() => pseudonymizer(undefined)).toThrow(PseudonymKeyMissingError);
    expect(() => exportFiles(store, env(), clock)).toThrow(/PCS_PSEUDONYM_KEY is not set/);
    expect(new PseudonymKeyMissingError().message).toMatch(/openssl rand -hex 32/);
  });

  it("the key is validated (length, whitespace) without showing it", () => {
    try {
      env({ PCS_PSEUDONYM_KEY: "short-key" });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as Error).message).toMatch(/PCS_PSEUDONYM_KEY.*at least 16 characters/);
      expect((e as Error).message).not.toContain("short-key");
    }
  });
});

describe("the export", () => {
  it("contains no '@' and no name, email, title, or text in any cell; only HMAC pseudonyms", () => {
    const f = exportFiles(store, env({ PCS_PSEUDONYM_KEY: KEY, PCS_REPORT_MIN_CELL: "1" }), clock);
    for (const c of cells(f)) {
      expect(c.includes("@"), `cell ${JSON.stringify(c.slice(0, 8))}… has "@"`).toBe(false);
      assertClean(c, "an export cell");
    }
    for (const n of EXPORT_FILE_NAMES) assertClean(f[n], n);
    const reviews = f["reviews.csv"].trimEnd().split("\n").map((l) => l.split(","));
    expect(reviews[0]!.slice(0, 3)).toEqual(["reviewer", "paper", "tier"]);
    // Reviewer reviews only: eve (3), cy (1), dee (1); ben's metareviews are left out.
    expect(reviews.length - 1).toBe(5);
    const ids = new Set(reviews.slice(1).map((r) => r[0]));
    expect(ids).toEqual(new Set(["eve@example.org", "cy@example.org", "dee@example.org"].map((e) => pseudonym(KEY, e))));
    for (const e of EMAILS) expect(f["reviews.csv"]).not.toContain(e);
    const reviewers = f["reviewers.csv"].trimEnd().split("\n");
    expect(reviewers).toHaveLength(4);
    expect(reviewers.find((l) => l.startsWith(pseudonym(KEY, "eve@example.org")))).toMatch(/^[0-9a-f]{64},senior,3,3,0,0,/);
  });

  it("is stable for a given key and differs across keys", () => {
    const a = exportFiles(store, env({ PCS_PSEUDONYM_KEY: KEY }), clock);
    const b = exportFiles(store, env({ PCS_PSEUDONYM_KEY: KEY }), clock);
    const c = exportFiles(store, env({ PCS_PSEUDONYM_KEY: KEY2 }), clock);
    expect(a).toEqual(b);
    const ids = (f: ExportFiles) => new Set(f["reviewers.csv"].trimEnd().split("\n").slice(1).map((l) => l.split(",")[0]));
    const [ia, ic] = [ids(a), ids(c)];
    expect(ia.size).toBe(3);
    for (const x of ia) expect(ic.has(x)).toBe(false);
    expect(a["manifest.csv"].split("\n")[1]!.split(",")[2]).not.toBe(c["manifest.csv"].split("\n")[1]!.split(",")[2]);
  });

  it("writes tiers with fewer than PCS_REPORT_MIN_CELL reviewers as \"other\"", () => {
    const f = exportFiles(store, env({ PCS_PSEUDONYM_KEY: KEY }), clock);
    const tiers = new Set(f["reviews.csv"].trimEnd().split("\n").slice(1).map((l) => l.split(",")[2]));
    expect(tiers).toEqual(new Set([OTHER_TIER]));
  });

  it("refuses free text structurally: the writer only takes pseudonyms, numbers, booleans, and enum tokens", () => {
    const cols: Column[] = [
      { name: "reviewer", type: { kind: "pseudonym" }, doc: "" },
      { name: "tier", type: { kind: "enum", values: ["senior"] }, doc: "" },
      { name: "n", type: { kind: "int" }, doc: "" },
    ];
    const ok = "a".repeat(64);
    expect(toCsv("t.csv", cols, [[ok, "senior", 3]])).toBe(`reviewer,tier,n\n${ok},senior,3\n`);
    for (const bad of [
      ["eve@example.org", "senior", 3],
      [ok, "Eve Senior", 3],
      [ok, "senior", "3"],
      [ok, "senior", 1.5],
    ]) {
      expect(() => toCsv("t.csv", cols, [bad])).toThrow(ExportCellError);
      try {
        toCsv("t.csv", cols, [bad]);
      } catch (e) {
        // The error never echoes the value.
        expect((e as Error).message).not.toMatch(/eve|Eve/);
      }
    }
  });

  it("a tier name that isn't a plain token never reaches a file", () => {
    const ps = pseudonymizer(KEY);
    const fact = (email: string, tier: string): ReviewFact => ({
      pid: 1, rid: 1, email, tier, rtype: 2, submitted: true, merit: 3, expertise: 3, words: 200, ratings: {},
      submittedAt: 0, assignedAfterDue: false, daysVsDue: -1, late: false, paperMean: null, absDev: null, side: null, onSide: null,
    });
    const facts = ["a", "b"].map((x) => fact(`${x}@example.org`, "Eve Senior's tier"));
    const f = buildExport({ facts, comments: new Map(), earlyRejectPids: new Set(), minCell: 1, generatedOn: "2030-03-10" }, ps);
    expect(f["reviews.csv"]).not.toContain("Eve");
    expect(f["reviews.csv"]).toContain(",other,");
  });

  it("zips the four files", () => {
    const f = exportFiles(store, env({ PCS_PSEUDONYM_KEY: KEY }), clock);
    const z = unzip(exportZip(f, clock.now()));
    expect([...z.keys()]).toEqual([...EXPORT_FILE_NAMES]);
    for (const n of EXPORT_FILE_NAMES) expect(z.get(n)!.toString("utf8")).toBe(f[n]);
  });
});

describe("do-not-invite carry-forward", () => {
  it("is the latest import as CSV with emails (the chair's own list), and re-imports unchanged", () => {
    const d = doNotInviteCsv(store, clock.now());
    expect(d.rows).toBe(2);
    expect(d.csv).toBe(DNI);
    const other = memoryStore();
    const r = importCsv(other.db, "do-not-invite", d.csv, { tz: "America/New_York", clock, fileName: "carry.csv" });
    expect(r.ok).toBe(true);
    expect(rowsAsOf(other.db, "do-not-invite", clock.now()).rows).toEqual(rowsAsOf(store.db, "do-not-invite", clock.now()).rows);
    other.close();
  });
});

describe("the report", () => {
  let api: App;
  let keyed: App;
  beforeAll(async () => {
    api = await buildApp({ cfg: env(), store, clock, webDir: null });
    keyed = await buildApp({ cfg: env({ PCS_PSEUDONYM_KEY: KEY }), store, clock, webDir: null });
  });
  afterAll(async () => {
    await api.app.close();
    await keyed.app.close();
  });

  it("GET /api/report: aggregates only, every section present, small tiers suppressed, no names/emails/titles/text/token/key", async () => {
    const res = await keyed.app.inject({ method: "GET", url: "/api/report" });
    expect(res.statusCode).toBe(200);
    for (const s of [TOKEN, KEY]) expect(res.body).not.toContain(s);
    expect(res.body).not.toContain("@");
    assertClean(res.body, "/api/report");
    const r = res.json() as ProcessReport;
    expect(r).toMatchObject({ final: true, phase: "after-decisions", minCell: 5, tiers: ["senior", "junior", "reciprocal"] });
    expect(r.totals).toMatchObject({ papers: 3, decided: 1, accepted: 1, rejected: 0, reviewerReviews: 5, submitted: 4 });
    for (const sec of [r.depth.rows, r.timeliness.rows, r.merits.rows, r.ratings.rows, r.agreement.rows]) {
      expect(sec.map((x) => x.tier)).toEqual(r.tiers);
      expect(sec.every((x) => x.suppressed && x.people === null)).toBe(true);
    }
    expect(r.reserve.suppressed).toBe(true);
    expect(r.earlyReject.status).toBe("unconfigured");
    expect(r.quickReject.available).toBe(true);
    expect(r.doNotInvite.run).toMatchObject({ rows: 2 });
    expect(r.export).toMatchObject({ keyConfigured: true, files: [...EXPORT_FILE_NAMES] });
    expect(r.export.keyId).toMatch(/^[0-9a-f]{12}$/);
  });

  it("with PCS_REPORT_MIN_CELL=1 the numbers show (eve's merits 4, 3, 5)", () => {
    const r = processReport(store, env({ PCS_REPORT_MIN_CELL: "1" }), clock);
    const senior = r.merits.rows.find((x) => x.tier === "senior")!;
    expect(senior).toMatchObject({ people: 1, reviews: 3, mean: 4 });
    expect(r.depth.rows.find((x) => x.tier === "junior")).toMatchObject({ people: 1, reviews: 1 });
    expect(r.ratings.rows.find((x) => x.tier === "senior")!.counts).toEqual({ short: 1 });
  });

  it("before decisions the report is provisional", () => {
    const r = processReport(store, env({ PCS_NOW: "2030-02-20T12:00" }), fixedClock(new Date("2030-02-20T17:00:00Z")));
    expect(r.final).toBe(false);
    expect(r.notes[0]).toMatch(/^Provisional/);
  });

  it("export routes: 409 with the clear error without the key; zip and single files with it, as downloads", async () => {
    const no = await api.app.inject({ method: "GET", url: "/api/report/export.zip" });
    expect(no.statusCode).toBe(409);
    expect(no.json().error).toMatch(/PCS_PSEUDONYM_KEY is not set/);
    const z = await keyed.app.inject({ method: "GET", url: "/api/report/export.zip" });
    expect(z.statusCode).toBe(200);
    expect(z.headers["content-type"]).toBe("application/zip");
    expect(z.headers["content-disposition"]).toBe('attachment; filename="pcs-export-2030-03-10.zip"');
    const files = unzip(z.rawPayload);
    for (const [n, b] of files) {
      expect(b.toString("utf8"), n).not.toContain("@");
      assertClean(b.toString("utf8"), n);
    }
    const one = await keyed.app.inject({ method: "GET", url: "/api/report/export/reviews.csv" });
    expect(one.statusCode).toBe(200);
    expect(one.body).toBe(files.get("reviews.csv")!.toString("utf8"));
    expect((await keyed.app.inject({ method: "GET", url: "/api/report/export/..%2Fetc" })).statusCode).toBe(404);
    for (const r of [no, z, one]) {
      expect(r.body).not.toContain(TOKEN);
      expect(r.body).not.toContain(KEY);
    }
  });

  it("the do-not-invite download keeps emails (the chair's own list)", async () => {
    const r = await api.app.inject({ method: "GET", url: "/api/report/do-not-invite.csv" });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-disposition"]).toMatch(/^attachment; filename="do-not-invite-2030-03-10\.csv"$/);
    expect(r.body).toBe(DNI);
  });

  it("the CLI renderer prints reasons with numbers, no names, emails, or titles", () => {
    const cfg = env({ PCS_REPORT_MIN_CELL: "1" });
    const text = describeReport(processReport(store, cfg, clock), formatter(cfg.tz)).join("\n");
    expect(text).toMatch(/\[depth \(words; floor 150\)\]/);
    expect(text).toMatch(/senior: 3 merits: /);
    expect(text).not.toContain("@");
    assertClean(text, "pcs report");
  });
});
