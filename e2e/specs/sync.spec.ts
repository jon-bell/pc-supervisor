// "Sync now" against the harness. The clock is pinned and golden is
// unchanged, so the re-sync changes no data; the list must look the same.
import { expect, test } from "@playwright/test";
import type { SyncStatus } from "@pcs/server/server/api-types";

test("sync now runs one sync and the list stays the same", async ({ page, request }) => {
  const before = (await (await request.get("/api/sync/status")).json()) as SyncStatus;
  await page.goto("/");
  const pids = () => page.getByTestId("triage-row").evaluateAll((els) => els.map((e) => e.getAttribute("data-pid")));
  await expect(page.getByTestId("triage-row")).toHaveCount(12);
  const order = await pids();
  await page.getByTestId("sync-now").click();
  await expect.poll(async () => ((await (await request.get("/api/sync/status")).json()) as SyncStatus).last?.id, { timeout: 60_000 }).toBeGreaterThan(before.last!.id);
  await expect(page.getByTestId("sync-status")).toHaveAttribute("data-running", "false", { timeout: 30_000 });
  const after = (await (await request.get("/api/sync/status")).json()) as SyncStatus;
  expect(after.last).toMatchObject({ ok: true, nowUsed: before.last!.nowUsed });
  // Idempotent: nothing but the fetch counters.
  expect(Object.keys(after.last!.counts).filter((k) => !/_fetched$|^tag_queries$/.test(k))).toEqual([]);
  expect(await pids()).toEqual(order);
});
