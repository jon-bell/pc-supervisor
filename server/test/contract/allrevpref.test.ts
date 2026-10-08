// Contract test for GET /searchaction?action=get/allrevpref (spec §10.5, the
// solver's third affinity source): HotCRP's "PC review preferences" CSV with
// a chair token. Self-seeding with MiniSeed: run-unique PC users and a fresh
// pid with an author conflict, a declared conflict, and preferences set with
// batch/assign.php (`pref` action, with and without expertise).

import { beforeAll, describe, expect, it } from "vitest";
import type { HotcrpClient } from "../../src/hotcrp/client.js";
import { harnessClient } from "../support/harness.js";
import { MiniSeed } from "../support/mini-seed.js";

let client: HotcrpClient;
let seed: MiniSeed;
let pid: number;

beforeAll(async () => {
  client = harnessClient();
  seed = await MiniSeed.create();
  const R = seed.run;
  seed.php("batch/saveusers.php", [
    "-e",
    JSON.stringify([
      { email: seed.email("prefauthor"), firstName: "Pia", lastName: `Author${R}`, roles: "pc" },
      { email: seed.email("prefconf"), firstName: "Cal", lastName: `Conf${R}`, roles: "pc" },
      { email: seed.email("prefhigh"), firstName: "Hal", lastName: `High${R}`, roles: "pc" },
      { email: seed.email("preflow"), firstName: "Lou", lastName: `Low${R}`, roles: "pc" },
      { email: seed.email("prefnone"), firstName: "Nia", lastName: `None${R}`, roles: "pc" },
    ]),
  ]);
  pid = await seed.nextPid();
  const dir = `/tmp/allrevpref-${R}`;
  seed.dc(["exec", "-T", "hotcrp", "sh", "-c", `mkdir -p ${dir} && cp test/sample50pg.pdf ${dir}/paper.pdf`]);
  const paper = {
    pid,
    title: `Preferences contract ${R}`,
    abstract: "Synthetic abstract.",
    authors: [{ email: seed.email("prefauthor"), first: "Pia", last: `Author${R}` }],
    status: "submitted",
    submission: { content_file: "paper.pdf", mimetype: "application/pdf" },
  };
  seed.dc(["exec", "-T", "hotcrp", "sh", "-c", `cat > ${dir}/papers.json`], JSON.stringify([paper]));
  seed.php("batch/savepapers.php", [`${dir}/papers.json`]);
  seed.php("batch/assign.php", [], `paper,action,user,conflict\n${pid},conflict,${seed.email("prefconf")},advisor\n`);
  seed.php(
    "batch/assign.php",
    [],
    `paper,action,user,preference,expertise\n${pid},pref,${seed.email("prefhigh")},15,X\n${pid},pref,${seed.email("preflow")},-7,\n`,
  );
}, 120_000);

describe("GET /searchaction?action=get/allrevpref", () => {
  it("lists preferences with expertise and conflicts, one row per pair that has any, nothing for the rest", async () => {
    const rows = await client.allRevPrefs({ q: String(pid), t: "all" });
    const by = new Map(rows.map((r) => [r.email, r]));
    expect(rows.every((r) => r.pid === pid)).toBe(true);
    expect(by.get(seed.email("prefhigh"))).toEqual({ pid, email: seed.email("prefhigh"), conflict: false, preference: 15, expertise: "X", topicScore: 0 });
    expect(by.get(seed.email("preflow"))).toEqual({ pid, email: seed.email("preflow"), conflict: false, preference: -7, expertise: null, topicScore: 0 });
    // Author and declared conflicts are rows with conflict=true.
    expect(by.get(seed.email("prefauthor"))).toMatchObject({ conflict: true, preference: 0 });
    expect(by.get(seed.email("prefconf"))).toMatchObject({ conflict: true });
    expect(by.has(seed.email("prefnone"))).toBe(false);
  });

  it("an empty paper set gives an empty list (header only)", async () => {
    expect(await client.allRevPrefs({ q: "NONE" })).toEqual([]);
  });
});
