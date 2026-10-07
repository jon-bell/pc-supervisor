// PLAN M7 browser perf, over the synced `scale` scenario (2,400 papers).
// Started by scale/run.ts, which asserts the budgets and prints the summary;
// this spec measures and writes SCALE_PERF_OUT, and also fails on its own
// when a budget is missed (so `playwright test -c playwright.scale.config.ts`
// is useful by itself against a running scale server).
//
// What is measured, all with in-page clocks (performance.now()):
//   - render: navigation start -> first triage rows in the DOM and the next
//     animation frame (median of 3 fresh loads; the server's analysis is warm);
//   - filter: the <select>'s change event -> the count shows the expected
//     number and the next animation frame;
//   - scroll: a scripted scroll of the virtualized list from top to bottom,
//     400 px per animation frame, three times. Smooth = in the median pass,
//     the 95th-percentile frame interval and the longest "longtask" entry
//     stay within budget.
import { writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { BUDGET, type PerfResult } from "./budgets.js";

const SCROLL_STEP_PX = 400;

declare global {
  interface Window {
    __pcsLongTasks: number[];
    __pcsRendered?: number;
  }
}

// Long tasks (> 50 ms) and the first painted triage rows, observed from the
// first byte of every document.
const INIT = () => {
  window.__pcsLongTasks = [];
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__pcsLongTasks.push(e.duration);
    }).observe({ type: "longtask", buffered: true });
  } catch {
    /* longtask unsupported: the frame-interval check still applies */
  }
  const mo = new MutationObserver(() => {
    if (document.querySelector('[data-testid="triage-row"]')) {
      mo.disconnect();
      requestAnimationFrame(() => {
        window.__pcsRendered = performance.now();
      });
    }
  });
  document.addEventListener("DOMContentLoaded", () => mo.observe(document.body, { childList: true, subtree: true }));
};

const median = (xs: number[]) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const pct = (xs: number[], p: number) => {
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
};

async function loadTriage(page: Page) {
  await page.goto("/");
  await page.waitForFunction(() => window.__pcsRendered !== undefined, null, { timeout: 30_000 });
  return page.evaluate(() => {
    const res = performance.getEntriesByType("resource").find((e) => /\/api\/triage(\?|$)/.test(e.name)) as PerformanceResourceTiming | undefined;
    return {
      renderMs: window.__pcsRendered!,
      afterDataMs: res ? window.__pcsRendered! - res.responseEnd : NaN,
      bytes: res?.encodedBodySize ?? 0,
      rows: document.querySelectorAll('[data-testid="triage-row"]').length,
    };
  });
}

/** Time from the select's change event to the count reading `want` and the next frame. */
async function timeFilter(page: Page, testId: string, value: string, want: string): Promise<number> {
  await page.evaluate(
    ([testId, want]) => {
      const sel = document.querySelector(`[data-testid="${testId}"]`)!;
      const count = document.querySelector('[data-testid="triage-count"]')!;
      const w = window as unknown as { __t0?: number; __t1?: number };
      w.__t0 = w.__t1 = undefined;
      sel.addEventListener("change", () => (w.__t0 = performance.now()), { capture: true, once: true });
      const mo = new MutationObserver(() => {
        if (count.textContent === want) {
          mo.disconnect();
          requestAnimationFrame(() => (w.__t1 = performance.now()));
        }
      });
      mo.observe(count, { childList: true, subtree: true, characterData: true });
    },
    [testId, want] as const,
  );
  await page.getByTestId(testId).selectOption(value);
  await page.waitForFunction(() => (window as unknown as { __t1?: number }).__t1 !== undefined, null, { timeout: 30_000 });
  return page.evaluate(() => {
    const w = window as unknown as { __t0: number; __t1: number };
    return w.__t1 - w.__t0;
  });
}

/** The "(n)" count in an option's label, and its value: the first option that isn't "all". */
async function optionWithCount(page: Page, testId: string, pick: (opts: { value: string; n: number }[]) => { value: string; n: number }) {
  const opts = await page.getByTestId(testId).locator("option").evaluateAll((els) =>
    els
      .map((e) => ({ value: (e as HTMLOptionElement).value, n: Number(/\((\d+)\)\s*$/.exec(e.textContent ?? "")?.[1] ?? NaN) }))
      .filter((o) => o.value !== "" && Number.isFinite(o.n)),
  );
  expect(opts.length, `${testId} has options`).toBeGreaterThan(0);
  return pick(opts);
}

test("triage at scale: render, filter, scroll", async ({ page }) => {
  await page.addInitScript(INIT);

  // ---- render ----
  const loads = [];
  for (let i = 0; i < 3; i++) loads.push(await loadTriage(page));
  const total = Number(/of (\d+) papers/.exec((await page.getByTestId("triage-count").textContent()) ?? "")?.[1]);
  expect(total).toBe(2400);
  const renderMs = median(loads.map((l) => l.renderMs));

  // ---- filters (each from the unfiltered list) ----
  const filters: PerfResult["filters"] = [];
  const largest = (o: { value: string; n: number }[]) => o.reduce((a, b) => (b.n > a.n ? b : a));
  for (const [name, testId, pick] of [
    ["one AC", "filter-ac", (o: { value: string; n: number }[]) => o[0]!],
    ["most common rule", "filter-rule", largest],
    ["tier", "filter-tier", (o: { value: string; n: number }[]) => o.find((x) => x.value !== "senior") ?? o[0]!],
  ] as const) {
    const opt = await optionWithCount(page, testId, pick);
    const ms = await timeFilter(page, testId, opt.value, `${opt.n} of ${total} papers`);
    filters.push({ name, ms, rows: opt.n });
    const back = await timeFilter(page, testId, "", `${total} of ${total} papers`);
    filters.push({ name: `${name} cleared`, ms: back, rows: total });
  }

  // ---- scroll ----
  // Three passes, top to bottom; the median pass (by p95 frame) is the result,
  // so one pass disturbed by another process on a shared runner doesn't fail
  // the run, while a real regression (every pass janky) still does.
  const scrollPass = () => page.evaluate(async (step) => {
    const body = document.querySelector('[data-testid="triage-table"] .dt-body') as HTMLElement;
    body.scrollTop = 0;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const before = window.__pcsLongTasks.length;
    const stamps: number[] = [];
    await new Promise<void>((done) => {
      const tick = (t: number) => {
        stamps.push(t);
        const max = body.scrollHeight - body.clientHeight;
        if (body.scrollTop >= max) return done();
        body.scrollTop = Math.min(max, body.scrollTop + step);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    // Let a trailing long task land in the observer.
    await new Promise((r) => setTimeout(r, 200));
    const frames = stamps.slice(1).map((t, i) => t - stamps[i]!);
    return { frames, longTasks: window.__pcsLongTasks.slice(before), px: body.scrollTop };
  }, SCROLL_STEP_PX);
  const passes = [];
  for (let i = 0; i < 3; i++) passes.push(await scrollPass());
  passes.sort((a, b) => pct(a.frames, 95) - pct(b.frames, 95));
  const scroll = passes[1]!;

  const result: PerfResult = {
    renderMs,
    renderRows: loads.at(-1)!.rows,
    renderAfterDataMs: median(loads.map((l) => l.afterDataMs)),
    triageBytes: loads.at(-1)!.bytes,
    filters,
    scroll: {
      frames: scroll.frames.length,
      p50FrameMs: pct(scroll.frames, 50),
      p95FrameMs: pct(scroll.frames, 95),
      maxFrameMs: Math.max(...scroll.frames),
      longTasks: scroll.longTasks.length,
      maxLongTaskMs: Math.max(0, ...scroll.longTasks),
      px: Math.round(scroll.px),
      passesP95Ms: passes.map((p) => pct(p.frames, 95)),
    },
  };
  const out = process.env.SCALE_PERF_OUT;
  if (out) writeFileSync(out, JSON.stringify(result, null, 2));
  test.info().annotations.push({ type: "perf", description: JSON.stringify(result) });

  // The virtualizer keeps the DOM small even at the bottom of 2,400 rows.
  expect(await page.getByTestId("triage-row").count()).toBeLessThan(100);
  expect(result.scroll.frames).toBeGreaterThan(50);
  expect.soft(result.renderMs, "render").toBeLessThan(BUDGET.renderMs);
  for (const f of filters) expect.soft(f.ms, `filter ${f.name}`).toBeLessThan(BUDGET.filterMs);
  expect.soft(result.scroll.p95FrameMs, "scroll p95 frame").toBeLessThan(BUDGET.scrollP95FrameMs);
  expect.soft(result.scroll.maxLongTaskMs, "scroll long task").toBeLessThan(BUDGET.scrollMaxLongTaskMs);
});
