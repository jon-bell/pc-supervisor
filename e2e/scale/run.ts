// `npm run test:scale` (PLAN M7): the scale budgets, end to end, against the
// local harness only.
//
//   1. refuse unless PCS_HOTCRP_URL is the local harness (AGENTS.md rule 2);
//   2. `seed reset` + `seed scale` (timed; --skip-seed reuses a harness that
//      already holds exactly the scale scenario);
//   3. a timed full sync into a fresh encrypted temp DB, then a timed
//      re-sync with nothing changed, counting requests, bytes and the chair
//      token's rate-limit headroom;
//   4. DB size (after a WAL checkpoint);
//   5. `pcs serve` on that DB: cold and warm timings of every analyze()-backed
//      endpoint (the server's Server-Timing header says how long the
//      snapshot + rules took);
//   5b. the process report and the pseudonymous export over the scale store
//      (PLAN M13: "renders from shadow and scale"): every section present,
//      sane numbers, no "@" or scenario name/email/title in any export cell,
//      and GET /api/report within its budget;
//   6. Playwright perf checks (e2e/scale/perf.spec.ts): render, filter, and a
//      scripted scroll of the virtualized triage list (--skip-browser skips).
//
// Every budget in budgets.ts is asserted; the summary is always printed and
// also appended to $GITHUB_STEP_SUMMARY when that is set. Output is counts,
// timings and sizes only: no titles, names, or text. Never sets CI or
// ARGOS_TOKEN, and the perf config has no Argos reporter.

import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { seedContextFromEnv, seededState, seedScenario } from "@pcs/seed/driver";
import { scenario as scale } from "@pcs/seed/scenarios/scale/scenario";
import { findSensitive, sensitiveStrings } from "@pcs/seed/sensitive";
import { EXPORT_FILE_NAMES, exportFiles, processReport } from "@pcs/server/modules/report/index";
import { resolveWhen } from "@pcs/seed/time";
import { fixedClock } from "@pcs/server/clock";
import { loadConfig, loadPhaseConfig } from "@pcs/server/config";
import { clientFromConfig, type HotcrpClientEvent } from "@pcs/server/hotcrp/client";
import { assertHarnessUrl } from "@pcs/server/hotcrp/harness-guard";
import { openStore } from "@pcs/server/store/store";
import { clientSource } from "@pcs/server/sync/source";
import { runSync, type SyncResult } from "@pcs/server/sync/sync";
import { formatInZone } from "@pcs/server/tz";
import { BUDGET, PERF_RESULT_FILE, SCALE_PORT, type PerfResult } from "./budgets.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const log = (s: string) => process.stderr.write(`test:scale: ${s}\n`);
const args = new Set(process.argv.slice(2));
for (const a of args) {
  if (!["--skip-seed", "--skip-browser"].includes(a)) {
    log(`unknown argument ${a}; usage: npm run test:scale [-- --skip-seed] [--skip-browser]`);
    process.exit(2);
  }
}

interface Row {
  what: string;
  value: string;
  budget?: string;
  ok?: boolean;
}
const rows: Row[] = [];
const failures: string[] = [];

function record(what: string, value: string, check?: { budget: string; ok: boolean }) {
  rows.push({ what, value, ...check });
  if (check && !check.ok) failures.push(`${what}: ${value} (budget ${check.budget})`);
}
const sec = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const msf = (ms: number) => `${Math.round(ms)} ms`;
const mib = (b: number) => `${(b / 1024 / 1024).toFixed(1)} MiB`;
const under = (ms: number, budget: number, fmt = msf) => ({ budget: `< ${fmt(budget)}`, ok: ms < budget });

/** Requests, bytes and rate-limit headroom for one sync, via an instrumented fetch. */
class Meter {
  requests = 0;
  retries = 0;
  bytes = 0;
  /**
   * HotCRP's rate-limit charge: 1 per request, plus 0.01 per KiB for
   * downloads only (src/pages/p_api.php charges bytes for Downloader
   * responses, e.g. searchaction CSVs; JSON results cost just the request).
   */
  charge = 0;
  retryReasons = new Map<string, number>();
  minRemaining = Infinity;
  byEndpoint = new Map<string, { n: number; bytes: number }>();

  fetch: typeof globalThis.fetch = async (input, init) => {
    const res = await globalThis.fetch(input, init);
    const buf = await res.arrayBuffer();
    this.bytes += buf.byteLength;
    const download = res.headers.has("content-disposition");
    this.charge += 1 + (download ? Math.floor((buf.byteLength * 0.01) / 1024 + 0.001) : 0);
    const path = new URL(String(input instanceof Request ? input.url : input)).pathname.replace(/^.*\/api\//, "");
    const e = this.byEndpoint.get(path) ?? { n: 0, bytes: 0 };
    e.n++;
    e.bytes += buf.byteLength;
    this.byEndpoint.set(path, e);
    return new Response(buf, { status: res.status, statusText: res.statusText, headers: res.headers });
  };

  onEvent = (e: HotcrpClientEvent) => {
    if (e.type === "request") this.requests++;
    if (e.type === "retry") {
      this.retries++;
      const why = `${e.endpoint}: ${e.reason ?? "?"}`;
      this.retryReasons.set(why, (this.retryReasons.get(why) ?? 0) + 1);
    }
    if (e.type === "response" && e.rateLimitRemaining !== undefined) this.minRemaining = Math.min(this.minRemaining, e.rateLimitRemaining);
  };

  describe(): string {
    const ep = [...this.byEndpoint].map(([p, e]) => `${p} ${e.n}×/${mib(e.bytes)}`).join(", ");
    const rl = Number.isFinite(this.minRemaining) ? `, min x-ratelimit-remaining ${this.minRemaining}` : "";
    const why = [...this.retryReasons].map(([r, n]) => `${n}× ${r}`).join("; ");
    return `${this.requests} requests (${this.retries} retries${why ? `: ${why}` : ""}), ${mib(this.bytes)}, rate-limit charge ≈${this.charge}${rl} [${ep}]`;
  }
}

function dbBytes(path: string): { main: number; wal: number } {
  const size = (p: string) => (existsSync(p) ? statSync(p).size : 0);
  return { main: size(path), wal: size(`${path}-wal`) };
}

async function waitFor(url: string, child: ChildProcess, timeoutMs: number): Promise<void> {
  const until = performance.now() + timeoutMs;
  while (performance.now() < until) {
    if (child.exitCode !== null) throw new Error(`pcs serve exited with code ${child.exitCode}`);
    try {
      const r = await fetch(url);
      if (r.status < 500) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`pcs serve did not answer ${url} within ${timeoutMs} ms`);
}

async function timedGet(url: string): Promise<{ ms: number; status: number; bytes: number; serverTiming: string }> {
  const t0 = performance.now();
  const r = await fetch(url);
  const body = await r.arrayBuffer();
  return { ms: performance.now() - t0, status: r.status, bytes: body.byteLength, serverTiming: r.headers.get("server-timing") ?? "" };
}

function summary(): string {
  const lines = [
    "## Scale (PLAN M7)",
    "",
    `Harness: ${scale.description}.`,
    "",
    "| Measure | Value | Budget | |",
    "|---|---|---|---|",
    ...rows.map((r) => `| ${r.what} | ${r.value} | ${r.budget ?? ""} | ${r.ok === undefined ? "" : r.ok ? "pass" : "**FAIL**"} |`),
    "",
    failures.length === 0 ? "All budgets pass." : `**${failures.length} budget(s) failed.**`,
  ];
  return `${lines.join("\n")}\n`;
}

function report(): void {
  const text = summary();
  process.stdout.write(`\n${text}\n`);
  const out = process.env.GITHUB_STEP_SUMMARY;
  if (out) appendFileSync(out, text);
}

async function main(): Promise<number> {
  assertHarnessUrl();
  if (process.env.ARGOS_TOKEN) throw new Error("ARGOS_TOKEN is set; test:scale never uploads screenshots, unset it");
  const phases = loadPhaseConfig();
  const now = resolveWhen(scale.stages.at(-1)!.now!, phases);
  const dir = mkdtempSync(join(tmpdir(), "pcs-scale-"));
  const child: { server?: ChildProcess } = {};
  const cleanup = () => {
    child.server?.kill("SIGTERM");
    rmSync(dir, { recursive: true, force: true });
  };
  process.on("exit", cleanup);

  const dbPath = join(dir, "scale.db");
  Object.assign(process.env, {
    PCS_DB_PATH: dbPath,
    PCS_DB_KEY: "scale-only-not-secret",
    PCS_NOW: formatInZone(now, phases.tz).slice(0, 16),
    PCS_PORT: String(SCALE_PORT),
    PCS_TIER_TAGS: process.env.PCS_TIER_TAGS ?? "junior=junior,reciprocal=reciprocal",
    PCS_PSEUDONYM_KEY: "scale-only-pseudonym-key-not-secret",
  });

  // ---- seed ---------------------------------------------------------------
  if (args.has("--skip-seed")) {
    const m = await seededState(seedContextFromEnv(process.env));
    if (m?.scenario !== "scale") throw new Error(`--skip-seed: the harness holds ${m ? m.scenario : "nothing"}, not scale`);
    record("Seed `scale`", "skipped (--skip-seed)");
  } else {
    const t0 = performance.now();
    await seedScenario(scale, { reset: true, log });
    record("Seed `scale`", sec(performance.now() - t0));
  }

  // ---- syncs --------------------------------------------------------------
  const cfg = loadConfig();
  const store = openStore(cfg);
  const clock = fixedClock(cfg.now!);
  const sync = async (label: string): Promise<{ r: SyncResult; meter: Meter; ms: number }> => {
    const meter = new Meter();
    const source = clientSource(clientFromConfig(cfg.hotcrp, { fetch: meter.fetch, onEvent: meter.onEvent }));
    const t0 = performance.now();
    const r = await runSync(store.db, source, {
      clock,
      chunkSize: cfg.sync.chunk,
      concurrency: cfg.sync.concurrency,
      tierTags: cfg.tierTags,
      acRole: cfg.acRole,
      log: (l) => log(`${label}: ${l}`),
    });
    const ms = performance.now() - t0;
    log(`${label}: ${r.ok ? "ok" : "FAILED"} in ${sec(ms)}; ${meter.describe()}`);
    if (!r.ok) throw new Error(`${label} failed: ${r.errors.join("; ")}`);
    return { r, meter, ms };
  };

  const full = await sync("full sync");
  record("Full sync", sec(full.ms), under(full.ms, BUDGET.fullSyncMs, sec));
  record(
    "Full sync: rows",
    `${full.r.counts.papers_new ?? 0} papers, ${full.r.counts.reviews_new ?? 0} reviews, ${full.r.counts.comments_new ?? 0} comments`,
  );
  record("Full sync: HotCRP traffic", full.meter.describe());

  const again = await sync("re-sync");
  record("Re-sync, no changes", sec(again.ms), under(again.ms, BUDGET.resyncMs, sec));
  record("Re-sync: HotCRP traffic", again.meter.describe());
  const changed = Object.entries(again.r.counts).filter(([k]) => !/_fetched$|^tag_queries$/.test(k));
  record("Re-sync: rows changed", changed.length === 0 ? "none" : changed.map(([k, v]) => `${k}=${v}`).join(" "), {
    budget: "none",
    ok: changed.length === 0,
  });

  // ---- process report + pseudonymous export (PLAN M13) ---------------------
  {
    const t0 = performance.now();
    const r = processReport(store, cfg, clock);
    const reportMs = performance.now() - t0;
    const problems: string[] = [];
    const check = (ok: boolean, what: string) => {
      if (!ok) problems.push(what);
    };
    check(r.totals.papers === scale.papers.length, `report: ${r.totals.papers} papers, expected ${scale.papers.length}`);
    check(r.totals.reviewerReviews > 5000, `report: only ${r.totals.reviewerReviews} reviewer reviews`);
    for (const [name, rows] of [
      ["depth", r.depth.rows],
      ["timeliness", r.timeliness.rows],
      ["merits", r.merits.rows],
      ["ratings", r.ratings.rows],
      ["agreement", r.agreement.rows],
    ] as const) {
      check(rows.length === r.tiers.length && rows.length >= 3, `report: ${name} has ${rows.length} tier rows`);
      check(rows.every((x) => !x.suppressed), `report: ${name} has a suppressed tier at scale`);
    }
    check(r.depth.rows.reduce((a, d) => a + (d.reviews ?? 0), 0) === r.totals.submitted, "report: depth reviews != submitted");
    check(r.merits.rows.every((m) => m.bins!.reduce((a, b) => a + b.count, 0) === m.reviews), "report: merit bins don't sum");
    check(!r.reserve.suppressed && (r.reserve.assigned ?? 0) > 0, "report: reserve section empty");
    check(r.quickReject.available, "report: quick reject unavailable");
    check(!JSON.stringify(r).includes("@"), "report: JSON contains '@'");
    record("Process report (processReport, in-process)", `${msf(reportMs)}; ${r.tiers.join("/")}; ${r.totals.submitted} submitted reviews`, under(reportMs, BUDGET.reportMs));

    const t1 = performance.now();
    const files = exportFiles(store, cfg, clock);
    const exportMs = performance.now() - t1;
    const sens = sensitiveStrings(scale);
    let cellsScanned = 0;
    for (const name of EXPORT_FILE_NAMES) {
      const text = files[name];
      check(!text.includes("@"), `export: ${name} contains '@'`);
      const hit = findSensitive(text, sens);
      check(hit === null, `export: ${name} contains a scenario name/email/title`);
      if (name.endsWith(".csv")) cellsScanned += text.split("\n").reduce((a, l) => a + (l ? l.split(",").length : 0), 0);
    }
    const reviewRows = files["reviews.csv"].trimEnd().split("\n").length - 1;
    check(reviewRows === r.totals.reviewerReviews, `export: ${reviewRows} review rows, expected ${r.totals.reviewerReviews}`);
    record("Pseudonymous export", `${msf(exportMs)}; ${reviewRows} review rows, ${cellsScanned} cells scanned: no '@', no scenario name/email/title`, under(exportMs, BUDGET.reportMs));
    record("Report + export checks", problems.length === 0 ? "all sections present, numbers sane" : problems.join("; "), { budget: "no problems", ok: problems.length === 0 });
  }

  store.db.pragma("wal_checkpoint(TRUNCATE)");
  store.close();
  const size = dbBytes(dbPath);
  record("DB size (encrypted SQLite)", `${mib(size.main)}${size.wal > 0 ? ` + ${mib(size.wal)} WAL` : ""}`);

  // ---- server -------------------------------------------------------------
  const base = `http://127.0.0.1:${SCALE_PORT}`;
  const server = (child.server = spawn(process.execPath, ["--import", "tsx", join(ROOT, "server/src/cli.ts"), "serve"], {
    cwd: ROOT,
    env: process.env,
    stdio: ["ignore", "ignore", "inherit"],
  }));
  // /api/sync/status doesn't build the analysis, so the first triage call is cold.
  await waitFor(`${base}/api/sync/status`, server, 60_000);

  const cold = await timedGet(`${base}/api/triage`);
  if (cold.status !== 200) throw new Error(`/api/triage answered ${cold.status}`);
  record("API cold: /api/triage (first after start)", `${msf(cold.ms)}, ${mib(cold.bytes)}; ${cold.serverTiming}`, under(cold.ms, BUDGET.apiColdMs));

  const tri = (await (await fetch(`${base}/api/triage`)).json()) as { papers: { pid: number; acs: { email: string }[] }[] };
  const pid = tri.papers[Math.floor(tri.papers.length / 2)]!.pid;
  const ac = tri.papers[0]!.acs[0]?.email;
  // Every analyze()-backed endpoint this build has; M6's register later (404s are skipped).
  const endpoints = [
    "/api/meta",
    "/api/triage",
    `/api/triage?rule=DECISIONS_DUE`,
    ...(ac ? [`/api/triage?ac=${encodeURIComponent(ac)}`, `/api/acs/${encodeURIComponent(ac)}`, `/api/people/${encodeURIComponent(ac)}`] : []),
    `/api/papers/${pid}`,
    "/api/acs",
    "/api/reviewers",
    "/api/overview",
  ];
  let worst = { path: "", ms: 0 };
  const measured: string[] = [];
  for (const path of endpoints) {
    const samples: number[] = [];
    let status = 0;
    for (let i = 0; i < 5; i++) {
      const r = await timedGet(`${base}${path}`);
      status = r.status;
      samples.push(r.ms);
    }
    if (status === 404) continue;
    if (status !== 200) throw new Error(`${path} answered ${status}`);
    const med = samples.sort((a, b) => a - b)[2]!;
    measured.push(`${ac ? path.replace(encodeURIComponent(ac), "<ac>") : path} ${msf(med)}`);
    if (med > worst.ms) worst = { path, ms: med };
  }
  record("API warm: median of 5, per endpoint", measured.join(", "));
  record("API warm: slowest endpoint", msf(worst.ms), under(worst.ms, BUDGET.apiWarmMs));
  {
    const samples: number[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await timedGet(`${base}/api/report`);
      if (r.status !== 200) throw new Error(`/api/report answered ${r.status}`);
      samples.push(r.ms);
    }
    const med = samples.sort((a, b) => a - b)[1]!;
    record("API: /api/report (median of 3; recomputed per request)", msf(med), under(med, BUDGET.reportMs));
  }

  // ---- browser ------------------------------------------------------------
  if (args.has("--skip-browser")) {
    record("Browser perf", "skipped (--skip-browser)");
  } else {
    const resultFile = join(dir, PERF_RESULT_FILE);
    const code = await new Promise<number>((done) => {
      const pw = spawn("npx", ["playwright", "test", "-c", "playwright.scale.config.ts"], {
        cwd: join(ROOT, "e2e"),
        env: { ...process.env, SCALE_PERF_OUT: resultFile },
        stdio: "inherit",
      });
      pw.on("exit", (c) => done(c ?? 1));
    });
    if (!existsSync(resultFile)) throw new Error(`Playwright perf spec exited ${code} without writing results`);
    const p = JSON.parse(readFileSync(resultFile, "utf8")) as PerfResult;
    record("Triage render (navigation → rows painted)", `${msf(p.renderMs)} (${p.renderRows} rows, ${mib(p.triageBytes)} JSON; ${msf(p.renderAfterDataMs)} after data)`, under(p.renderMs, BUDGET.renderMs));
    for (const f of p.filters) record(`Triage filter: ${f.name}`, `${msf(f.ms)} (${f.rows} rows)`, under(f.ms, BUDGET.filterMs));
    const s = p.scroll;
    record("Scroll: frame interval p95", `${s.p95FrameMs.toFixed(1)} ms (p50 ${s.p50FrameMs.toFixed(1)}, max ${s.maxFrameMs.toFixed(1)}; ${s.frames} frames over ${s.px} px; passes' p95 ${s.passesP95Ms.map((x) => x.toFixed(1)).join("/")} ms)`, under(s.p95FrameMs, BUDGET.scrollP95FrameMs, (n) => `${n} ms`));
    record("Scroll: longest long task", `${msf(s.maxLongTaskMs)} (${s.longTasks} long tasks)`, under(s.maxLongTaskMs, BUDGET.scrollMaxLongTaskMs));
    if (code !== 0) failures.push(`Playwright perf spec exited ${code}`);
  }
  return failures.length === 0 ? 0 : 1;
}

main().then(
  (code) => {
    report();
    if (failures.length > 0) log(`FAILED:\n  ${failures.join("\n  ")}`);
    process.exit(code);
  },
  (e: unknown) => {
    report();
    log(e instanceof Error ? (e.stack ?? e.message) : String(e));
    process.exit(1);
  },
);
