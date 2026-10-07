// Contract test for the one write path (PLAN M8): tag changes through
// POST /assign, dry run first. Harness only (harnessClient re-checks the
// guard). Uses its own tag on its own fresh paper (MiniSeed), so it can't
// disturb other tests' data and needs none, and clears the tag at the end.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HotcrpClient } from "../../src/hotcrp/client.js";
import { HotcrpError } from "../../src/hotcrp/errors.js";
import { harnessClient } from "../support/harness.js";
import { MiniSeed } from "../support/mini-seed.js";

const TAG = "pcs-contract-m8";

let client: HotcrpClient;
let pid: number;

/** Pids holding TAG, via /search (the same field the sync reads). */
async function tagged(): Promise<number[]> {
  const res = await client.search({ t: "all", fields: ["tags"] });
  return (res.papers ?? [])
    .filter((p) => String((p as Record<string, unknown>).tags ?? "").split(/\s+/).some((t) => t.replace(/^#/, "").replace(/#.*$/, "") === TAG))
    .map((p) => p.pid);
}

beforeAll(async () => {
  client = harnessClient();
  const seed = await MiniSeed.create();
  pid = await seed.nextPid();
  seed.savePapers([{ pid, title: `Tag contract paper ${seed.run}` }]);
  await client.assignTags([{ pid, op: "remove" }], TAG, { dryRun: false, allowWrites: true });
});

afterAll(async () => {
  await client?.assignTags([{ pid, op: "remove" }], TAG, { dryRun: false, allowWrites: true });
});

describe("POST /assign tag rows", () => {
  it("a dry run reports the diff and changes nothing", async () => {
    const diff = await client.assignTags([{ pid, op: "add" }], TAG, { dryRun: true });
    expect(diff).toEqual({ gain: [pid], lose: [] });
    expect(await tagged()).toEqual([]);
  });

  it("the confirmed run sets the tag; a repeat dry run is then empty; cleartag reports the loss", async () => {
    expect(await client.assignTags([{ pid, op: "add" }], TAG, { dryRun: false, allowWrites: true })).toEqual({ gain: [pid], lose: [] });
    expect(await tagged()).toEqual([pid]);
    expect(await client.assignTags([{ pid, op: "add" }], TAG, { dryRun: true })).toEqual({ gain: [], lose: [] });
    expect(await client.assignTags([{ pid, op: "remove" }], TAG, { dryRun: true })).toEqual({ gain: [], lose: [pid] });
    expect(await tagged()).toEqual([pid]);
  });

  it("an unknown paper is an error, not a silent no-op", async () => {
    await expect(client.assignTags([{ pid: 999_999, op: "add" }], TAG, { dryRun: true })).rejects.toBeInstanceOf(HotcrpError);
  });
});
