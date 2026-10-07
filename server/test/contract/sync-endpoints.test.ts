// Contract tests for the API surface M3's sync adds on top of M1's:
// - get/lead and get/shepherd (emails; /search only has names)
// - /reviews?rq=re:#<tag> (how a chair token learns PC user tags; /pc has none)
// - an unknown user tag in rq is a warning, which the client turns into an error
// - /reviews `ratings`
// - /reviewhistory?expand=1 (full versions, each with modified_at)
// Self-seeding (MiniSeed): run-unique users, tag, and a fresh pid.

import { beforeAll, describe, expect, it } from "vitest";
import type { HotcrpClient } from "../../src/hotcrp/client.js";
import { harnessClient } from "../support/harness.js";
import { MiniSeed } from "../support/mini-seed.js";

let client: HotcrpClient;
let seed: MiniSeed;
let pid: number;
let tag: string;
let rid1: number;

beforeAll(async () => {
  client = harnessClient();
  seed = new MiniSeed();
  tag = `ct${seed.run}`;
  seed.openReviewing();
  seed.saveUsers([
    { key: "lead", first: "Lea", last: `Lead${seed.run}` },
    { key: "shep", first: "Sam", last: `Shep${seed.run}` },
    { key: "t1", first: "Tia", last: `Tagged${seed.run}`, tags: [tag] },
    { key: "u1", first: "Uma", last: `Untagged${seed.run}` },
  ]);
  pid = await seed.nextPid();
  seed.savePapers([{ pid, title: `Contract paper ${seed.run}` }]);
  seed.assign([
    [pid, "primary", "t1"],
    [pid, "primary", "u1"],
    [pid, "lead", "lead"],
    [pid, "shepherd", "shep"],
  ]);
  seed.backdateRequests([pid]);
  rid1 = await seed.submitReview(pid, "t1", { OveMer: 1, RevExp: 2, PapSum: "v1", ComAut: "v1" });
  await seed.submitReview(pid, "t1", { OveMer: 2, RevExp: 2, PapSum: "v2", ComAut: "v2" });
  // A PC reviewer sees (and can rate) others' reviews once theirs is in.
  await seed.submitReview(pid, "u1", { OveMer: 3, RevExp: 3, PapSum: "u", ComAut: "u" });
  await seed.rate(pid, rid1, "u1", "vague");
}, 120_000);

describe("get/lead, get/shepherd", () => {
  it("give {pid, email} per paper with a lead/shepherd", async () => {
    const leads = await client.paperRoles("lead", { q: String(pid), t: "all" });
    expect(leads).toEqual([{ pid, email: seed.email("lead") }]);
    const sheps = await client.paperRoles("shepherd", { q: String(pid), t: "all" });
    expect(sheps).toEqual([{ pid, email: seed.email("shep") }]);
  });

  it("are empty (header only) when nobody holds the role", async () => {
    const none = await client.paperRoles("lead", { q: "NONE" });
    expect(none).toEqual([]);
  });
});

describe("user tags via /reviews?rq=re:#tag", () => {
  it("/pc lists the tag name but not who holds it", async () => {
    const pc = await client.pc();
    expect(pc.tags).toContain(tag);
    const me = pc.pc.find((m) => m.email === seed.email("t1"))!;
    expect(Object.keys(me)).not.toContain("tags");
  });

  it("rq=re:#tag returns only reviews by holders of the tag", async () => {
    const rs = await client.reviews({ q: String(pid), t: "all", rq: `re:#${tag}` });
    expect(rs.map((r) => r.reviewer_email)).toEqual([seed.email("t1")]);
  });

  it("an unknown tag is a HotCRP warning, so the client throws", async () => {
    await expect(client.reviews({ q: String(pid), rq: `re:#nosuchtag${seed.run}` })).rejects.toMatchObject({ kind: "api" });
  });
});

describe("/reviews ratings", () => {
  it("carry `ratings` when the review has been rated", async () => {
    const rs = await client.reviews({ q: String(pid), t: "all" });
    const r = rs.find((x) => x.rid === rid1)!;
    expect(r.ratings).toBe("vague");
    expect(rs.find((x) => x.rid !== rid1)!.ratings).toBeUndefined();
  });
});

describe("/reviewhistory?expand=1", () => {
  it("returns full review objects, each older one with its own modified_at", async () => {
    const h = await client.reviewHistory(pid, rid1, { expand: true });
    expect(h.versions.every((v) => v.object === "review")).toBe(true);
    const [cur, prev, first] = h.versions as Record<string, unknown>[];
    expect(cur).toMatchObject({ OveMer: 2, status: "complete" });
    expect(prev).toMatchObject({ OveMer: 1, status: "complete", PapSum: "v1\n" });
    expect(typeof prev!.modified_at).toBe("number");
    expect(first).toMatchObject({ status: "empty" });
    // vtags are opaque: just distinct.
    expect(new Set(h.versions.map((v) => v.version)).size).toBe(3);
  });

  it("without expand, older versions are review_delta objects without modified_at", async () => {
    const h = await client.reviewHistory(pid, rid1);
    const deltas = h.versions.slice(1);
    expect(deltas.every((v) => v.object === "review_delta")).toBe(true);
    for (const d of deltas) expect(d).not.toHaveProperty("modified_at");
  });
});
