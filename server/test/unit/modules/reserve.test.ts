// Reserve compliance (spec §10.4 A, PLAN M11): normalization, each check, the
// assembled report, mail drafts, and the DBLP lookup behind its interface.
// The DBLP tests use a fake fetch; no test touches the network (the unit
// setup stubs the global fetch to throw). Synthetic data only.

import { describe, expect, it } from "vitest";
import { DEFAULT_RESERVE_POLICY, type ReservePolicy } from "../../../src/config.js";
import {
  checkConsistency,
  checkCoverage,
  checkDesignee,
  checkExemption,
  checkReserve,
  checkTpms,
  countVenues,
  DblpPublSearchSchema,
  dblpLookup,
  HintCache,
  hintFrom,
  normalizeEmail,
  normalizeName,
  parseDesignee,
  staticLookup,
  type InputPaper,
  type ReserveInput,
} from "../../../src/modules/reserve/index.js";

const e = (s: string) => `${s}@example.org`;
const P = DEFAULT_RESERVE_POLICY;
const paper = (pid: number, authors: [string | null, string][], o: Partial<InputPaper> = {}): InputPaper => ({
  pid,
  title: `Paper ${pid}`,
  authors: authors.map(([email, name]) => ({ email, name })),
  designee: undefined,
  exemption: undefined,
  seniority: undefined,
  ...o,
});
const input = (papers: InputPaper[], o: Partial<ReserveInput> = {}): ReserveInput => ({
  papers,
  fields: { designee: "text", exemption: "dropdown", seniority: "text" },
  pc: new Set(),
  names: new Map(),
  tpms: undefined,
  ...o,
});

describe("normalization", () => {
  it("emails: trims, lowercases, unwraps Name <x> and mailto:, rejects non-emails", () => {
    expect(normalizeEmail("  Kim.Park@Example.ORG ")).toBe(e("kim.park"));
    expect(normalizeEmail("Kim Park <kim.park@example.org>")).toBe(e("kim.park"));
    expect(normalizeEmail("mailto:KP@example.org")).toBe(e("kp"));
    expect(normalizeEmail("kim park")).toBeNull();
    expect(normalizeEmail("a@b")).toBeNull();
    expect(normalizeEmail("a@x.org, b@y.org")).toBeNull();
  });

  it("names: accents, case, punctuation, spacing, 'Last, First', and DBLP's homonym suffix are ignored", () => {
    expect(normalizeName("Nils Åberg")).toBe("nils aberg");
    expect(normalizeName("Åberg, Nils")).toBe("nils aberg");
    expect(normalizeName("  KIM-PARK  ")).toBe("kim park");
    expect(normalizeName("Kim Park 0002")).toBe("kim park");
    expect(normalizeName(null)).toBe("");
  });

  it("designee values: empty, email (with an optional name), name, or invalid", () => {
    expect(parseDesignee(undefined)).toEqual({ kind: "empty" });
    expect(parseDesignee("   ")).toEqual({ kind: "empty" });
    expect(parseDesignee("K.Park@Example.org")).toEqual({ kind: "email", email: e("k.park"), name: null });
    expect(parseDesignee('"Kim Park" <kim.park@example.org>')).toEqual({ kind: "email", email: e("kim.park"), name: "Kim Park" });
    expect(parseDesignee("Sana Iqbal")).toEqual({ kind: "name", name: "Sana Iqbal" });
    expect(parseDesignee("sana@")).toMatchObject({ kind: "invalid" });
    expect(parseDesignee(3)).toMatchObject({ kind: "invalid", why: "a number, not text" });
    expect(parseDesignee("1234")).toMatchObject({ kind: "invalid" });
  });
});

describe("checkDesignee", () => {
  const names = new Map<string, string>();
  it("resolves an email designee who is an author", () => {
    const r = checkDesignee(paper(1, [[e("kim"), "Kim Park"]], { designee: "KIM@example.org" }), { names }, P);
    expect(r).toEqual({ designation: { pid: 1, email: e("kim"), name: "Kim Park", identifiedBy: "email" }, findings: [] });
  });
  it("resolves a name to exactly one author with an email", () => {
    const r = checkDesignee(paper(1, [[e("sana"), "Sana Iqbal"], [e("tomo"), "Tomo Arai"]], { designee: "sana  IQBAL" }), { names }, P);
    expect(r.designation).toMatchObject({ email: e("sana"), identifiedBy: "name" });
  });
  it("flags a name that matches no author, an invalid value, and a non-author email", () => {
    const unresolved = checkDesignee(paper(1, [[e("sana"), "Sana Iqbal"]], { designee: "Someone Else" }), { names }, P);
    expect(unresolved.findings.map((f) => [f.code, f.reason])).toEqual([
      ["DESIGNEE_UNRESOLVED", `#1: "Reserve designee" (PCS_RESERVE_DESIGNEE_FIELD) holds a name, not an email, and it matches 0 of the paper's 1 author with an email (need exactly 1)`],
    ]);
    expect(checkDesignee(paper(1, [], { designee: ["x"] }), { names }, P).findings[0]!.code).toBe("DESIGNEE_UNRESOLVED");
    const outsider = checkDesignee(paper(2, [[e("a"), "A A"], [e("b"), "B B"]], { designee: e("zed") }), { names }, P);
    expect(outsider.findings.map((f) => [f.code, f.emails, f.reason])).toEqual([
      ["DESIGNEE_NOT_AUTHOR", [e("zed")], `#2: designee ${e("zed")} is not among the paper's 2 authors; the designee must be an author`],
    ]);
    // The designation still counts for coverage and consistency.
    expect(outsider.designation).toMatchObject({ email: e("zed") });
  });
  it("an empty value is no designation and no finding (the exemption check decides)", () => {
    expect(checkDesignee(paper(1, []), { names }, P)).toEqual({ designation: null, findings: [] });
  });
});

describe("checkExemption", () => {
  const pc = new Set([e("pc1"), e("pc2")]);
  it("no designee and no claim: DESIGNEE_MISSING", () => {
    expect(checkExemption(paper(2, [[e("a"), "A"], [e("b"), "B"]]), pc, P).map((f) => [f.code, f.reason])).toEqual([
      ["DESIGNEE_MISSING", `#2: no reserve designee ("Reserve designee") and no exemption ("Reserve exemption") among 2 authors`],
    ]);
  });
  it("an allowed reason (case-insensitive) passes; others are EXEMPTION_NOT_ALLOWED", () => {
    expect(checkExemption(paper(1, [], { exemption: "No-Eligible-Author" }), pc, P)).toEqual([]);
    expect(checkExemption(paper(5, [], { exemption: "on-sabbatical" }), pc, P).map((f) => [f.code, f.reason])).toEqual([
      ["EXEMPTION_NOT_ALLOWED", `#5: exemption "on-sabbatical" is not one of the 3 reasons in PCS_RESERVE_EXEMPTIONS (no-eligible-author, all-authors-on-pc, other)`],
    ]);
    const custom: ReservePolicy = { ...P, exemptions: ["on-sabbatical"] };
    expect(checkExemption(paper(5, [], { exemption: "on-sabbatical" }), pc, custom)).toEqual([]);
  });
  it("all-authors-on-pc is checked against the PC (authors without an email count as off the PC)", () => {
    const ok = paper(6, [[e("pc1"), "P One"], [e("pc2"), "P Two"]], { exemption: "all-authors-on-pc" });
    expect(checkExemption(ok, pc, P)).toEqual([]);
    const bad = paper(6, [[e("pc1"), "P One"], [e("nadia"), "Nadia Fern"], [null, "No Mail"]], { exemption: "all-authors-on-pc" });
    expect(checkExemption(bad, pc, P).map((f) => [f.code, f.reason])).toEqual([
      ["EXEMPTION_CONTRADICTED", `#6: exemption "all-authors-on-pc" (PCS_RESERVE_EXEMPTION_ALL_PC) but 2 of 3 authors are not on the PC`],
    ]);
    expect(checkExemption(bad, pc, { ...P, exemptionAllPc: "" })).toEqual([]);
  });
});

describe("per-person checks", () => {
  const d = (pid: number, email: string, name: string | null) => ({ pid, email, name, identifiedBy: "email" as const });
  it("DESIGNEE_INCONSISTENT: one normalized name under several emails", () => {
    const f = checkConsistency([d(3, e("kim.park"), "Kim Park"), d(4, e("k.park"), "kim  park"), d(5, e("kim.park"), "Kim Park"), d(6, e("x"), null)]);
    expect(f.map((x) => [x.code, x.pids, x.emails, x.reason])).toEqual([
      ["DESIGNEE_INCONSISTENT", [3, 4, 5], [e("k.park"), e("kim.park")], `"Kim Park" is designated under 2 different emails across 3 papers: ${e("k.park")} on #4; ${e("kim.park")} on #3, #5`],
    ]);
    expect(checkConsistency([d(1, e("a"), "A"), d(2, e("a"), "A")])).toEqual([]);
  });
  it("OVER_COVERED: more papers than PCS_RESERVE_MAX_COVER (exactly the max is fine)", () => {
    const ds = [7, 8, 9, 10].map((pid) => d(pid, e("victor"), "Victor Okafor"));
    expect(checkCoverage(ds.slice(0, 3), P)).toEqual([]);
    expect(checkCoverage(ds, P).map((x) => [x.pids, x.reason])).toEqual([
      [[7, 8, 9, 10], `${e("victor")} is the designee of 4 papers, more than PCS_RESERVE_MAX_COVER=3 (coverage does not scale the obligation)`],
    ]);
  });
  it("TPMS: not imported = no check; missing or unregistered, and too few papers", () => {
    const ds = [d(1, e("a"), "A"), d(2, e("b"), "B"), d(3, e("c"), "C"), d(4, e("ok"), "OK")];
    expect(checkTpms(ds, undefined, P)).toEqual([]);
    const tpms = {
      runId: 7,
      rows: [
        { email: e("b"), registered: false, papers_uploaded: null, last_updated: null },
        { email: e("c"), registered: true, papers_uploaded: 0, last_updated: null },
        { email: e("ok"), registered: true, papers_uploaded: null, last_updated: null },
      ],
    };
    expect(checkTpms(ds, tpms, P).map((x) => [x.code, x.emails[0], x.reason])).toEqual([
      ["TPMS_NOT_REGISTERED", e("a"), `${e("a")} (designee of 1 paper) is not in the tpms-registrations import #7`],
      ["TPMS_NOT_REGISTERED", e("b"), `${e("b")} (designee of 1 paper) is listed as not registered in the tpms-registrations import #7`],
      ["TPMS_FEW_PAPERS", e("c"), `${e("c")} is registered with TPMS but uploaded 0 papers, fewer than PCS_RESERVE_TPMS_MIN_PAPERS=1 (import #7)`],
    ]);
  });
});

describe("checkReserve", () => {
  const papers = [
    paper(1, [[e("clara"), "Clara Bishop"]], { designee: e("clara"), seniority: "  10 years " }),
    paper(2, [[e("elif"), "Elif Kaya"]]),
    paper(3, [[e("owen"), "Owen Pratt"]], { exemption: "no-eligible-author" }),
  ];

  it("states, counts, findings, and mail drafts", () => {
    const r = checkReserve(input(papers), P);
    expect(r.papers.map((p) => [p.pid, p.state, p.designee, p.exemption, p.codes])).toEqual([
      [1, "designee", e("clara"), null, []],
      [2, "noncompliant", null, null, ["DESIGNEE_MISSING"]],
      [3, "exempt", null, "no-eligible-author", []],
    ]);
    expect(r.papers[0]!.seniorityNote).toBe("10 years");
    expect(r.counts).toEqual({ papers: 3, designee: 1, exempt: 1, noncompliant: 1, designees: 1, warnings: 0 });
    expect(r.mailDrafts).toEqual([{ code: "DESIGNEE_MISSING", label: "Name a reserve designee or claim an exemption", recipients: "Contact authors", search: "2", papers: 1 }]);
    expect(r.designees).toEqual([{ email: e("clara"), name: "Clara Bishop", pids: [1], cover: 1, aliases: [], tpms: null, codes: [], hint: null }]);
    expect(r.notes).toEqual(["No tpms-registrations import yet, so TPMS registration was not checked (pcs import tpms-registrations <file>)"]);
    expect(r.dblp).toEqual({ enabled: false, source: null, looked: 0, pending: 0, failed: 0 });
  });

  it("without either option in HotCRP, nothing is checked and a note says so", () => {
    const r = checkReserve(input(papers, { fields: { designee: undefined, exemption: undefined, seniority: undefined } }), P);
    expect(r.findings).toEqual([]);
    expect(r.papers.every((p) => p.state === "unchecked")).toBe(true);
    expect(r.notes.join("\n")).toMatch(/no submission option "Reserve designee".*\n.*no submission option "Reserve exemption".*\nNeither option exists/);
  });

  it("notes a designee option that isn't a text field", () => {
    expect(checkReserve(input(papers, { fields: { designee: "dropdown", exemption: "dropdown", seniority: undefined } }), P).notes[0]).toMatch(/is a dropdown option/);
  });

  it("hints attach to designees and exempted papers' authors, never as findings", () => {
    const hints = (name: string) => (name === "Owen Pratt" || name === "Clara Bishop" ? hintFrom(name, "mock", { venues: { ICSE: 6 }, matchedPapers: 9 }, 5) : undefined);
    const r = checkReserve(input(papers), { ...P, dblp: { ...P.dblp, enabled: true } }, hints);
    expect(r.findings.map((f) => f.code)).toEqual(["DESIGNEE_MISSING"]);
    expect(r.papers[2]!.hints.map((h) => [h.name, h.possiblySenior])).toEqual([["Owen Pratt", true]]);
    expect(r.designees[0]!.hint!.text).toBe(
      'mock: 6 papers at the configured venues (ICSE 6) for the name "Clara Bishop"; possibly senior (PCS_DBLP_SENIOR_MIN=5) (a hint for a human, not a verdict: the name may match a different person)',
    );
    expect(r.notes.at(-1)).toMatch(/hints.*not a verdict/);
  });
});

describe("DBLP lookup (fake fetch only)", () => {
  const body = {
    result: {
      hits: {
        "@total": "4",
        hit: [
          { info: { authors: { author: [{ text: "Kim Park 0002" }, { text: "Lior Ben" }] }, venue: "ICSE", year: "2024" } },
          { info: { authors: { author: { text: "Kim Park" } }, venue: ["ESEC/SIGSOFT FSE", "Other"] } },
          { info: { authors: { author: [{ text: "Kimberly Parker" }] }, venue: "ICSE" } },
          { info: { authors: { author: "Kim Park" }, venue: "arXiv" } },
        ],
      },
    },
  };

  it("counts only hits whose author list has the name, at the configured venues", () => {
    expect(countVenues(DblpPublSearchSchema.parse(body), "Kim Park", ["icse", "ESEC/SIGSOFT FSE"])).toEqual({
      venues: { icse: 1, "ESEC/SIGSOFT FSE": 1 },
      matchedPapers: 3,
    });
    expect(countVenues(DblpPublSearchSchema.parse({ result: { hits: { "@total": "0" } } }), "Kim Park", ["ICSE"])).toBeUndefined();
  });

  it("sends only the name, to PCS_DBLP_URL, and parses with Zod", async () => {
    const urls: string[] = [];
    const lookup = dblpLookup({
      url: "https://dblp.example.org",
      venues: ["ICSE"],
      fetch: async (url) => {
        urls.push(url);
        return { ok: true, status: 200, json: async () => body };
      },
    });
    expect(await lookup.lookup("Kim Park")).toEqual({ venues: { ICSE: 1 }, matchedPapers: 3 });
    expect(urls).toEqual(["https://dblp.example.org/search/publ/api?q=Kim%20Park&format=json&h=1000"]);
    expect(lookup.label).toBe("DBLP (https://dblp.example.org)");
  });

  it("rejects on HTTP errors and unexpected shapes", async () => {
    const mk = (ok: boolean, status: number, json: unknown) =>
      dblpLookup({ url: "https://dblp.example.org", venues: ["ICSE"], fetch: async () => ({ ok, status, json: async () => json }) });
    await expect(mk(false, 429, {}).lookup("A B")).rejects.toThrow("DBLP answered HTTP 429");
    await expect(mk(true, 200, { nope: 1 }).lookup("A B")).rejects.toThrow(/expected shape/);
  });

  it("the default fetch is the global one, which the unit setup blocks", async () => {
    await expect(dblpLookup({ url: "https://dblp.example.org", venues: [] }).lookup("A B")).rejects.toThrow();
  });
});

describe("HintCache", () => {
  it("looks each normalized name up once, rate-limited, and records misses and failures", async () => {
    const calls: string[] = [];
    const sleeps: number[] = [];
    const lookup = {
      label: "fake",
      lookup: async (n: string) => {
        calls.push(n);
        if (n === "Bad Name") throw new Error("boom");
        return n === "Kim Park" ? { venues: { ICSE: 2 }, matchedPapers: 2 } : undefined;
      },
    };
    const c = new HintCache(lookup, { rps: 4, sleep: async (ms) => void sleeps.push(ms) });
    await c.loadAll(["Kim Park", "kim  park", "Nobody Here", "Bad Name", ""]);
    expect(calls).toEqual(["Kim Park", "Nobody Here", "Bad Name"]);
    expect(sleeps).toEqual([250, 250]);
    expect(c.peek("KIM PARK")).toEqual({ state: "found", counts: { venues: { ICSE: 2 }, matchedPapers: 2 } });
    expect(c.peek("Nobody Here")).toEqual({ state: "none" });
    expect(c.peek("Bad Name")).toEqual({ state: "failed" });
    expect(c.peek("Unknown")).toBeUndefined();
    await c.loadAll(["Kim Park"]);
    expect(calls).toHaveLength(3);
  });

  it("request() returns at once and fills in the background", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const c = new HintCache({ label: "slow", lookup: async () => (await gate, { venues: {}, matchedPapers: 1 }) }, { rps: 1000, sleep: async () => {} });
    c.request(["A A", "B B"]);
    expect(c.peek("A A")).toBeUndefined();
    expect(c.pending).toBe(1);
    release();
    await c.loadAll([]);
    expect(c.peek("B B")).toMatchObject({ state: "found" });
  });

  it("staticLookup matches by normalized name", async () => {
    const s = staticLookup("t", { "Nils Åberg": { venues: { ASE: 1 }, matchedPapers: 1 } });
    expect(await s.lookup("nils aberg")).toEqual({ venues: { ASE: 1 }, matchedPapers: 1 });
    expect(await s.lookup("x")).toBeUndefined();
  });
});
