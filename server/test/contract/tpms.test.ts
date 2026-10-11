// Contract test for GET /searchaction?action=get/pcconf (spec §10.3, the
// conflicts file of `pcs export tpms`): HotCRP's "PC conflicts" CSV with a
// chair token. Self-seeding with MiniSeed: run-unique PC users, a fresh pid
// authored by one PC member, and a declared (non-author) conflict for another.

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
      { email: seed.email("tpmsauthor"), firstName: "Tia", lastName: `Author${R}`, roles: "pc" },
      { email: seed.email("tpmsadvisor"), firstName: "Ada", lastName: `Advisor${R}`, roles: "pc" },
      { email: seed.email("tpmsfree"), firstName: "Fay", lastName: `Free${R}`, roles: "pc" },
    ]),
  ]);
  pid = await seed.nextPid();
  const dir = `/tmp/tpms-${R}`;
  seed.dc(["exec", "-T", "hotcrp", "sh", "-c", `mkdir -p ${dir} && cp test/sample50pg.pdf ${dir}/paper.pdf`]);
  const paper = {
    pid,
    title: `TPMS conflicts contract ${R}`,
    abstract: "Synthetic abstract.",
    authors: [{ email: seed.email("tpmsauthor"), first: "Tia", last: `Author${R}` }],
    status: "submitted",
    submission: { content_file: "paper.pdf", mimetype: "application/pdf" },
  };
  seed.dc(["exec", "-T", "hotcrp", "sh", "-c", `cat > ${dir}/papers.json`], JSON.stringify([paper]));
  seed.php("batch/savepapers.php", [`${dir}/papers.json`]);
  seed.php("batch/assign.php", [], `paper,action,user,conflict\n${pid},conflict,${seed.email("tpmsadvisor")},advisor\n`);
}, 120_000);

describe("GET /searchaction?action=get/pcconf", () => {
  it("lists author and declared conflicts of PC members, one row per pair, with HotCRP's labels", async () => {
    const rows = await client.pcConflicts({ q: String(pid), t: "s" });
    expect(rows.map((r) => [r.pid, r.email, r.conflictType]).sort()).toEqual(
      [
        // Unless the venue collects conflict descriptions, every declared conflict reads "Conflict".
        [pid, seed.email("tpmsadvisor"), "Conflict"],
        [pid, seed.email("tpmsauthor"), "Author"],
      ].sort(),
    );
    const a = rows.find((r) => r.email === seed.email("tpmsauthor"))!;
    expect(a).toMatchObject({ title: `TPMS conflicts contract ${seed.run}`, givenName: "Tia", familyName: `Author${seed.run}` });
    expect(rows.some((r) => r.email === seed.email("tpmsfree"))).toBe(false);
  });

  it("an empty paper set gives an empty list (header only)", async () => {
    expect(await client.pcConflicts({ q: "NONE" })).toEqual([]);
  });
});
