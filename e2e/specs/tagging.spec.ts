// PLAN M8 golden: #chair-attention tagging against the harness. This is the
// only spec that writes to HotCRP, so it runs in its own Playwright project
// after every other spec (playwright.config.ts) and removes the tag again at
// the end; the next run re-seeds golden (`seed reset`) regardless.
//
//   1. the dry run changes nothing in HotCRP (checked through the API);
//   2. the confirmed run sets the tags (checked through the API);
//   3. the re-sync shows them in the UI and in the local DB (via /api/papers);
//   4. a used or forged preview token is refused by the server.
import { argosScreenshot } from "@argos-ci/playwright";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import type { ActionsInfo, TagPreviewResponse } from "@pcs/server/server/action-types";
import type { PaperDetail, SyncStatus } from "@pcs/server/server/api-types";
import { harnessClient, pidsWithTag } from "../support/hotcrp.js";

const hotcrp = harnessClient();
let TAG: string;

test.describe.configure({ mode: "serial" });

const lastSyncId = async (request: APIRequestContext) => ((await (await request.get("/api/sync/status")).json()) as SyncStatus).last?.id ?? 0;

/** Wait until a sync newer than `after` has finished. */
async function syncedAfter(request: APIRequestContext, after: number) {
  await expect
    .poll(
      async () => {
        const s = (await (await request.get("/api/sync/status")).json()) as SyncStatus;
        return !s.running && (s.last?.id ?? 0) > after && s.last?.finishedAt !== null;
      },
      { timeout: 60_000 },
    )
    .toBe(true);
}

const dbTags = async (request: APIRequestContext, pid: number) => ((await (await request.get(`/api/papers/${pid}`)).json()) as PaperDetail).tags;
const chipPids = (page: Page) =>
  page.locator('[data-testid="triage-row"]:has([data-testid="attention-tag"])').evaluateAll((els) => els.map((e) => Number(e.getAttribute("data-pid"))).sort((a, b) => a - b));

test.beforeAll(async ({ request }) => {
  TAG = ((await (await request.get("/api/actions")).json()) as ActionsInfo).attentionTag;
  expect(TAG).toBe("chair-attention");
  expect(await pidsWithTag(hotcrp, TAG)).toEqual([]);
});

test.afterAll(async ({ request }) => {
  // Clean up through the app's own dry-run + confirm flow, then re-sync.
  const left = await pidsWithTag(hotcrp, TAG);
  if (left.length === 0) return;
  const p = (await (await request.post("/api/tags/preview", { data: { remove: left } })).json()) as TagPreviewResponse;
  const before = await lastSyncId(request);
  const r = await request.post("/api/tags/commit", { data: { token: p.token, gain: [], lose: left, confirm: TAG } });
  expect(r.status()).toBe(200);
  await syncedAfter(request, before);
  expect(await pidsWithTag(hotcrp, TAG)).toEqual([]);
});

test("tag the split papers: dry run changes nothing, confirmation sets the tags, a re-sync shows them", async ({ page, request }) => {
  await page.goto("/?rule=SPLIT");
  await expect.poll(async () => (await page.getByTestId("triage-row").count())).toBe(3);
  await expect(page.getByTestId("attention-tag")).toHaveCount(0);

  await page.getByTestId("tag-add-all").click();
  const dialog = page.getByTestId("tag-dialog");
  await expect(dialog.getByTestId("tag-gain").locator("li")).toHaveCount(3);
  expect(await dialog.getByTestId("tag-gain").locator("li").evaluateAll((els) => els.map((e) => Number(e.getAttribute("data-pid"))))).toEqual([3, 4, 12]);
  await expect(dialog.getByTestId("tag-lose")).toHaveCount(0);
  // 1. The dry run changed nothing in HotCRP.
  expect(await pidsWithTag(hotcrp, TAG)).toEqual([]);

  // Explicit confirmation: the button stays disabled until the tag name is typed exactly.
  const commit = dialog.getByTestId("tag-commit");
  await expect(commit).toBeDisabled();
  await dialog.getByTestId("tag-confirm-input").fill("chair");
  await expect(commit).toBeDisabled();
  await dialog.getByTestId("tag-confirm-input").fill(`#${TAG}`);
  await expect(commit).toBeDisabled();
  await dialog.getByTestId("tag-confirm-input").fill(TAG);
  await expect(commit).toBeEnabled();
  await argosScreenshot(page, "tag-dry-run");
  expect(await pidsWithTag(hotcrp, TAG)).toEqual([]);

  const before = await lastSyncId(request);
  await commit.click();
  await expect(dialog.getByTestId("tag-done")).toContainText(`HotCRP added #${TAG} to 3 papers`);
  // 2. The confirmed run set exactly those tags.
  expect(await pidsWithTag(hotcrp, TAG)).toEqual([3, 4, 12]);

  // 3. The re-sync it started shows them in the DB and the UI.
  await syncedAfter(request, before);
  for (const pid of [3, 4, 12]) expect(await dbTags(request, pid)).toContain(TAG);
  expect(await dbTags(request, 5)).not.toContain(TAG);
  await dialog.getByTestId("tag-cancel").click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => chipPids(page), { timeout: 30_000 }).toEqual([3, 4, 12]);
  await page.goto("/papers/4");
  await expect(page.getByTestId("drawer-tags")).toHaveText(`#${TAG}`);
});

test("removing the tag from one paper in the drawer goes through the same dry run and confirmation", async ({ page, request }) => {
  await page.goto("/papers/12");
  const drawer = page.getByTestId("paper-drawer");
  await expect(drawer.getByTestId("drawer-tags")).toHaveText(`#${TAG}`);
  await drawer.getByTestId("drawer-tag").click();
  const dialog = page.getByTestId("tag-dialog");
  await expect(dialog.getByTestId("tag-lose").locator("li")).toHaveCount(1);
  await expect(dialog.getByTestId("tag-gain")).toHaveCount(0);
  expect(await dialog.getByTestId("tag-lose").locator("li").evaluateAll((els) => els.map((e) => Number(e.getAttribute("data-pid"))))).toEqual([12]);
  expect(await pidsWithTag(hotcrp, TAG)).toEqual([3, 4, 12]);
  await dialog.getByTestId("tag-confirm-input").fill(TAG);
  const before = await lastSyncId(request);
  await dialog.getByTestId("tag-commit").click();
  await expect(dialog.getByTestId("tag-done")).toContainText("removed it from 1 paper");
  expect(await pidsWithTag(hotcrp, TAG)).toEqual([3, 4]);
  await syncedAfter(request, before);
  expect(await dbTags(request, 12)).not.toContain(TAG);
  await dialog.getByTestId("tag-cancel").click();
  await expect(drawer.getByTestId("drawer-tags")).toHaveText("none", { timeout: 30_000 });
});

test("the server refuses reused, forged, mismatched and unconfirmed commits; nothing is written", async ({ request }) => {
  const p = (await (await request.post("/api/tags/preview", { data: { add: [5] } })).json()) as TagPreviewResponse;
  expect(p.gain.map((x) => x.pid)).toEqual([5]);
  expect(p.token).toBeTruthy();
  expect((await request.post("/api/tags/commit", { data: { token: p.token, gain: [5, 6], lose: [], confirm: TAG } })).status()).toBe(409);
  // That attempt consumed the token.
  expect((await request.post("/api/tags/commit", { data: { token: p.token, gain: [5], lose: [], confirm: TAG } })).status()).toBe(409);
  const p2 = (await (await request.post("/api/tags/preview", { data: { add: [5] } })).json()) as TagPreviewResponse;
  expect((await request.post("/api/tags/commit", { data: { token: p2.token, gain: [5], lose: [], confirm: "yes" } })).status()).toBe(400);
  expect((await request.post("/api/tags/commit", { data: { token: "forged-token", gain: [5], lose: [], confirm: TAG } })).status()).toBe(409);
  expect((await request.post("/api/tags/preview", { data: { add: [5] }, headers: { origin: "https://evil.example" } })).status()).toBe(403);
  expect(await pidsWithTag(hotcrp, TAG)).toEqual([3, 4]);
});
