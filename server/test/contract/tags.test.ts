// Contract test for the one write path (PLAN M8): tag changes through
// POST /assign, dry run first. Harness only (harnessClient re-checks the
// guard). Uses its own tag so it can't disturb other tests' data, and clears
// it again at the end.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HotcrpClient } from "../../src/hotcrp/client.js";
import { HotcrpError } from "../../src/hotcrp/errors.js";
import { harnessClient } from "../support/harness.js";

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
  const res = await client.search({ t: "all" });
  expect(res.ids.length).toBeGreaterThan(0);
  pid = res.ids[0]!;
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
