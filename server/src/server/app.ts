// The local JSON API + the built web app (PLAN M5), on Fastify.
//
// - Binds 127.0.0.1 only (serve.ts); requests whose Host isn't a loopback
//   name are refused, which blocks DNS-rebinding pages from reading the API.
// - The HotCRP token never leaves the process: no route returns config
//   beyond the base URL, and sync errors are redacted (a unit test injects
//   every route and checks bodies and headers for the token).
// - CSP allows only this origin: no CDNs, no external fonts or scripts.
// - /api/* answers JSON; anything else is the web app (SPA fallback to
//   index.html, so client-side routes deep-link).
//
// Routes register from ROUTES below; each reads deps.analysis (the cached
// rules evaluation, AC/reviewer metrics and burndown). M6 added /api/acs,
// /api/reviewers, /api/people/:email and /api/overview. M8 added the v1
// actions (routes/actions.ts): /api/actions, nudge drafts, tag preview/commit.
// M13 added the process report and its downloads (routes/report.ts).
// The in-app paper filter (paper-filter.ts): paper-centric routes take
// ?search=<HotCRP search> and read deps.analysis over the matching papers
// only (filteredView); GET /api/paper-search resolves a search for the
// filter box, GET /api/search-completions its autocomplete.

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import type { Clock } from "../clock.js";
import { RULE_NAMES, type Config, type RuleName } from "../config.js";
import { redact } from "../redact.js";
import type { PersonView } from "../rules/model.js";
import type { Store } from "../store/store.js";
import type { Person } from "./api-types.js";
import { AnalysisSource } from "./analysis.js";
import type { TagFlow } from "../actions/tagging.js";
import { registerActions } from "./routes/actions.js";
import { registerAssignment } from "./routes/assignment.js";
import type { SolverHotcrp } from "../modules/solver/load.js";
import { registerAcs } from "./routes/acs.js";
import { registerLeads } from "./routes/leads.js";
import { registerMeta, registerSync } from "./routes/meta.js";
import { registerModules } from "./routes/modules.js";
import { registerOverview } from "./routes/overview.js";
import { registerPapers } from "./routes/papers.js";
import { registerPeople } from "./routes/people.js";
import { registerReviewers } from "./routes/reviewers.js";
import { registerTriage } from "./routes/triage.js";
import { registerEarlyReject, registerTierProgress } from "./routes/progress.js";
import { registerReport } from "./routes/report.js";
import type { QuickRejectProvider } from "../modules/report/quick-reject.js";
import type { SyncRunner } from "./sync-runner.js";
import { PaperFilter, type PaperSearcher } from "./paper-filter.js";
import { registerPaperSearch } from "./routes/paper-search.js";
import { registerSearchCompletions } from "./routes/search-completions.js";
import { SearchCompletions, type SearchCompleter } from "./search-completions.js";
import { registerRules } from "./routes/rules.js";
import { registerFlagHistory } from "./routes/flag-history.js";
import type { ActorResolver } from "../rule-settings/actor.js";

export interface RouteDeps {
  cfg: Config;
  store: Store;
  clock: Clock;
  analysis: AnalysisSource;
  /** Absent: POST /api/sync answers 503 (tests, read-only use). */
  sync: SyncRunner | undefined;
  ruleNames: readonly RuleName[];
  /** The confirmed tagging flow (PLAN M8). Absent: the tag routes answer 503. */
  tagFlow?: TagFlow | undefined;
  /** Quick-reject counts for the process report (M11); absent = unavailable. */
  quickReject?: QuickRejectProvider | undefined;
  /** HotCRP reads the assignment solver needs (M10b); absent = POST /api/assignment/solve answers 503. */
  solverHotcrp?: SolverHotcrp | undefined;
  /** Resolves ?search= to papers (HotCRP /search, cached); without a searcher it answers 503. */
  paperFilter: PaperFilter;
  /** The filter box's autocomplete data (store + HotCRP /searchcompletion, cached). */
  searchCompletions: SearchCompletions;
  /** Who is making a rule change or tag write (whoami, cached); absent = "local". */
  actor?: ActorResolver | undefined;
}

export type RegisterRoutes = (app: FastifyInstance, deps: RouteDeps) => void;

/** Every API route group. */
export const ROUTES: readonly RegisterRoutes[] = [
  registerMeta,
  registerSync,
  registerTriage,
  registerPapers,
  registerAcs,
  // Discussion leads (chair feedback): /api/leads, /api/leads/:email.
  registerLeads,
  registerReviewers,
  registerPeople,
  registerOverview,
  // Phase-2 modules (PLAN M11): /api/reserve, /api/quickreject.
  registerModules,
  registerActions,
  registerTierProgress,
  registerEarlyReject,
  registerReport,
  // Assignment validator + solver (PLAN M10/M10b): /api/assignment, /api/assignment/solve.
  registerAssignment,
  // The in-app paper filter: GET /api/paper-search, GET /api/search-completions.
  registerPaperSearch,
  registerSearchCompletions,
  // Chair rule settings and flag history: /api/rules*, /api/flag-history, /api/papers/:pid/flag-history.
  registerRules,
  registerFlagHistory,
];

export interface RouteInfo {
  method: string;
  /** Fastify pattern, e.g. "/api/papers/:pid". */
  url: string;
}

/**
 * Every route ROUTES registers, without serving anything (for tests that must
 * cover every route, e.g. e2e/specs/security.spec.ts). Sorted by URL.
 */
export async function listRoutes(o: Pick<AppOptions, "cfg" | "store" | "clock">): Promise<RouteInfo[]> {
  const app = Fastify({ logger: false });
  const out: RouteInfo[] = [];
  app.addHook("onRoute", (r) => {
    for (const method of [r.method].flat()) if (method !== "HEAD") out.push({ method, url: r.url });
  });
  const paperFilter = new PaperFilter(undefined);
  const deps: RouteDeps = {
    cfg: o.cfg,
    store: o.store,
    clock: o.clock,
    analysis: new AnalysisSource(o.store, o.cfg, o.clock),
    sync: undefined,
    ruleNames: RULE_NAMES,
    paperFilter,
    searchCompletions: new SearchCompletions(o.store, o.cfg, paperFilter, undefined),
  };
  for (const register of ROUTES) register(app, deps);
  await app.ready();
  await app.close();
  return out.sort((a, b) => a.url.localeCompare(b.url) || a.method.localeCompare(b.method));
}

export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

/** The person record for an email (name falls back to the email). */
export function personOf(people: ReadonlyMap<string, PersonView>, email: string): Person {
  const p = people.get(email);
  return { email, name: p?.name ?? email, tier: p?.tier ?? "senior" };
}

/** web/dist next to this checkout (src/server -> ../../../web/dist; also from a built dist/). */
export function defaultWebDir(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const rel of ["../../../web/dist", "../../../../web/dist"]) {
    const dir = resolve(here, rel);
    if (existsSync(join(dir, "index.html"))) return dir;
  }
  return null;
}

export interface AppOptions {
  cfg: Config;
  store: Store;
  clock: Clock;
  sync?: SyncRunner;
  /** The confirmed tagging flow (PLAN M8); absent = tagging unavailable. */
  tagFlow?: TagFlow;
  /** Quick-reject counts for the process report (M11); absent = unavailable. */
  quickReject?: QuickRejectProvider;
  /** HotCRP reads for the assignment solver (M10b); absent = the solver is unavailable. */
  solverHotcrp?: SolverHotcrp;
  /** HotCRP /search for the in-app ?search= filter; absent = filtering answers 503. */
  paperSearcher?: PaperSearcher;
  /** HotCRP /searchcompletion + /alltags for the filter box; absent = completions from the store only. */
  searchCompleter?: SearchCompleter;
  /** Who is making a rule change or tag write (whoami); absent = "local". */
  actor?: ActorResolver;
  /** Built web app; null = API only. Default: defaultWebDir(). */
  webDir?: string | null;
  /** Fastify request logging (off by default: logs could carry paths, never bodies). */
  logger?: boolean;
}

export interface App {
  app: FastifyInstance;
  analysis: AnalysisSource;
}

export async function buildApp(o: AppOptions): Promise<App> {
  const app = Fastify({ logger: o.logger ?? false });
  const analysis = new AnalysisSource(o.store, o.cfg, o.clock);
  const token = o.cfg.hotcrp.token;

  app.addHook("onRequest", async (req, reply) => {
    if (!LOOPBACK_HOST.test(req.headers.host ?? "")) {
      return reply.code(421).send({ error: "this server only answers on 127.0.0.1" });
    }
  });
  // Server-Timing on /api/*: total handler time, plus the snapshot + rules
  // rebuild when this request paid for one (PLAN M7; durations only).
  const started = new WeakMap<object, { at: number; builds: number }>();
  app.addHook("onRequest", async (req) => {
    started.set(req, { at: performance.now(), builds: analysis.stats.builds });
  });
  app.addHook("onSend", async (req, reply, payload) => {
    if (req.url.startsWith("/api/")) {
      const s = started.get(req);
      const t = [`app;dur=${s ? (performance.now() - s.at).toFixed(1) : "0"}`];
      if (s && analysis.stats.builds !== s.builds) {
        t.push(`snapshot;dur=${analysis.stats.snapshotMs.toFixed(1)}`, `rules;dur=${analysis.stats.rulesMs.toFixed(1)}`);
      }
      reply.header("server-timing", t.join(", "));
    }
    reply.header("content-security-policy", CSP);
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    reply.header("cross-origin-opener-policy", "same-origin");
    reply.header("cross-origin-resource-policy", "same-origin");
    if (req.url.startsWith("/api/")) reply.header("cache-control", "no-store");
    return payload;
  });
  app.setErrorHandler((err: { statusCode?: number; message?: string }, _req, reply) => {
    const code = err.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
    // Never echo internals that could carry the token (redact anyway).
    const message = code < 500 ? redact(err.message ?? "bad request", [token]) : "internal error; see the server console";
    if (code >= 500) process.stderr.write(`pcs serve: ${redact(String(err.message ?? err), [token])}\n`);
    return reply.code(code).send({ error: message });
  });

  const paperFilter = new PaperFilter(o.paperSearcher, [token]);
  const deps: RouteDeps = {
    cfg: o.cfg,
    store: o.store,
    clock: o.clock,
    analysis,
    sync: o.sync,
    ruleNames: RULE_NAMES,
    tagFlow: o.tagFlow,
    quickReject: o.quickReject,
    solverHotcrp: o.solverHotcrp,
    paperFilter,
    searchCompletions: new SearchCompletions(o.store, o.cfg, paperFilter, o.searchCompleter),
    actor: o.actor,
  };
  for (const register of ROUTES) register(app, deps);

  const webDir = o.webDir === undefined ? defaultWebDir() : o.webDir;
  if (webDir) {
    await app.register(fastifyStatic, { root: webDir, index: ["index.html"], wildcard: false, serveDotFiles: false });
  }
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api/") || req.url === "/api" || req.method !== "GET" || !webDir) {
      return reply.code(404).send({ error: `no route ${req.method} ${req.url.split("?")[0]}` });
    }
    return reply.type("text/html; charset=utf-8").sendFile("index.html");
  });

  return { app, analysis };
}
