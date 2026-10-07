// Contract tests for the API surface PLAN M10 adds:
// - GET /papers: authors with email + affiliation (only with forceShow for a
//   blind submission), submission-option values keyed by option name
// - GET /settings?filter=sf: option definitions (numeric ids)
// - review rounds on /reviews and get/pcassignments
// - /pc affiliations
// - POST /assign?dry_run=1 (JSON rows): valid and invalid results, no change
// Self-seeding with MiniSeed: run-unique users and a fresh pid.

import { beforeAll, describe, expect, it } from "vitest";
import { loadHotcrpConfig } from "../../src/config.js";
import { clientFromConfig, type HotcrpClient } from "../../src/hotcrp/client.js";
import { assertHarnessUrl } from "../../src/hotcrp/harness-guard.js";
import { submissionOptionValue } from "../../src/hotcrp/schemas.js";
import { harnessClient } from "../support/harness.js";
import { MiniSeed } from "../support/mini-seed.js";

const DESIGNEE = "Reserve designee";
const EXEMPTION = "Reserve exemption";
const ROUND = "quickreject";

let client: HotcrpClient;
let seed: MiniSeed;
let pid: number;

beforeAll(async () => {
  client = harnessClient();
  seed = await MiniSeed.create();
  seed.php("batch/settings.php", [
    "save",
    "-e",
    JSON.stringify({
      review_open: true,
      review: [
        { id: 1, name: "", soft: "2099-01-01", done: "2099-01-02" },
        { name: ROUND, soft: "2099-01-01", done: "2099-01-02" },
      ],
      sf: [
        { name: DESIGNEE, type: "text", visibility: "admin" },
        { name: EXEMPTION, type: "dropdown", values: [{ name: "no-eligible-author" }, { name: "all-authors-on-pc" }, { name: "other" }], visibility: "admin" },
      ],
    }),
  ]);
  const R = seed.run;
  seed.php("batch/saveusers.php", [
    "-e",
    JSON.stringify([
      { email: seed.email("pcauthor"), firstName: "Pia", lastName: `Author${R}`, affiliation: `Inst ${R}`, roles: "pc" },
      { email: seed.email("rev"), firstName: "Rex", lastName: `Reviewer${R}`, affiliation: `Other ${R}`, roles: "pc" },
    ]),
  ]);
  pid = await seed.nextPid();
  const dir = `/tmp/m10-${R}`;
  seed.dc(["exec", "-T", "hotcrp", "sh", "-c", `mkdir -p ${dir} && cp test/sample50pg.pdf ${dir}/paper.pdf`]);
  const paper = {
    pid,
    title: `Submissions contract ${R}`,
    abstract: "Synthetic abstract.",
    authors: [
      { email: seed.email("pcauthor"), first: "Pia", last: `Author${R}`, affiliation: `Inst ${R}` },
      { email: seed.email("ext"), first: "Ed", last: `External${R}`, affiliation: `Ext Lab ${R}` },
    ],
    status: "submitted",
    submission: { content_file: "paper.pdf", mimetype: "application/pdf" },
    [DESIGNEE]: seed.email("pcauthor"),
    [EXEMPTION]: "other",
  };
  seed.dc(["exec", "-T", "hotcrp", "sh", "-c", `cat > ${dir}/papers.json`], JSON.stringify([paper]));
  seed.php("batch/savepapers.php", [`${dir}/papers.json`]);
  seed.php("batch/assign.php", [], `paper,action,user,round\n${pid},primary,${seed.email("rev")},${ROUND}\n`);
}, 120_000);

describe("GET /papers", () => {
  it("gives authors with email and affiliation, and option values by option name (forceShow)", async () => {
    const [p] = await client.papers({ q: String(pid), t: "all" });
    expect(p!.authors).toEqual([
      expect.objectContaining({ email: seed.email("pcauthor"), affiliation: `Inst ${seed.run}` }),
      expect.objectContaining({ email: seed.email("ext"), affiliation: `Ext Lab ${seed.run}` }),
    ]);
    expect(submissionOptionValue(p!, DESIGNEE)).toBe(seed.email("pcauthor"));
    expect(submissionOptionValue(p!, EXEMPTION)).toBe("other");
  });

  it("hides authors of a blind submission without forceShow, even from a chair", async () => {
    const blind = clientFromConfig({ ...loadHotcrpConfig(process.env), forceShow: false });
    const [p] = await blind.papers({ q: String(pid), t: "all" });
    expect(p!.authors).toBeUndefined();
  });

  it("chunked papersForPids returns the same objects", async () => {
    const ps = await client.papersForPids([pid]);
    expect(ps.map((p) => p.pid)).toEqual([pid]);
  });
});

describe("GET /settings?filter=sf", () => {
  it("lists configured options with numeric ids, types, and choices", async () => {
    const sf = (await client.submissionFields()).settings.sf;
    const d = sf.find((f) => f.name === DESIGNEE)!;
    const x = sf.find((f) => f.name === EXEMPTION)!;
    expect(typeof d.id).toBe("number");
    expect(d.type).toBe("text");
    // Saving choices by name adds missing ones and keeps the rest (a reused harness may have more).
    expect(x.values?.map((v) => v.name)).toEqual(expect.arrayContaining(["no-eligible-author", "all-authors-on-pc", "other"]));
    expect(sf.find((f) => f.id === "title")).toBeDefined();
  });
});

describe("review rounds and affiliations", () => {
  it("/reviews and get/pcassignments carry the round name", async () => {
    const [r] = await client.reviews({ q: String(pid), t: "all" });
    expect(r).toMatchObject({ reviewer_email: seed.email("rev"), round: ROUND, status: "empty" });
    const rows = await client.pcAssignments({ q: String(pid), t: "all" });
    expect(rows.find((x) => x.email === seed.email("rev"))).toMatchObject({ action: "primaryreview", round: ROUND });
  });

  it("/pc carries each member's affiliation", async () => {
    const pc = await client.pc();
    expect(pc.pc.find((m) => m.email === seed.email("rev"))?.affiliation).toBe(`Other ${seed.run}`);
  });
});

describe("POST /assign?dry_run=1", () => {
  it("accepts a valid CSV and reports what it would do, without doing it", async () => {
    assertHarnessUrl();
    const before = await client.pcAssignments({ q: String(pid), t: "all" });
    const csv = `paper,action,user\n${pid},clearreview,${seed.email("rev")}\n${pid},secondary,admin@example.org\n`;
    const r = await client.assign(csv, { dryRun: true });
    expect(r).toMatchObject({ ok: true, dry_run: true, valid: true, assignment_count: 2 });
    expect(r.assignments?.map((a) => a.action).sort()).toEqual(["clearreview", "secondaryreview"]);
    expect(await client.pcAssignments({ q: String(pid), t: "all" })).toEqual(before);
  });

  it("reports an author conflict as valid: false (conflicts enforced), not an exception", async () => {
    const r = await client.assign(`paper,action,user\n${pid},primary,${seed.email("pcauthor")}\n`, { dryRun: true });
    expect(r.valid).toBe(false);
    expect(r.message_list?.some((m) => m.status >= 2 && /conflict/i.test(m.message ?? ""))).toBe(true);
  });

  it("refuses a real write in this milestone", async () => {
    await expect(client.assign("paper,action,user\n", { dryRun: false })).rejects.toMatchObject({ kind: "writes_disabled" });
  });
});
