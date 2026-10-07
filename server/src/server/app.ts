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
// /api/reviewers, /api/people/:email and /api/overview.

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
import { registerAcs } from "./routes/acs.js";
import { registerMeta, registerSync } from "./routes/meta.js";
import { registerOverview } from "./routes/overview.js";
import { registerPapers } from "./routes/papers.js";
import { registerPeople } from "./routes/people.js";
import { registerReviewers } from "./routes/reviewers.js";
import { registerTriage } from "./routes/triage.js";
import type { SyncRunner } from "./sync-runner.js";

export interface RouteDeps {
  cfg: Config;
  store: Store;
  clock: Clock;
  analysis: AnalysisSource;
  /** Absent: POST /api/sync answers 503 (tests, read-only use). */
  sync: SyncRunner | undefined;
  ruleNames: readonly RuleName[];
}

export type RegisterRoutes = (app: FastifyInstance, deps: RouteDeps) => void;

/** Every API route group. */
export const ROUTES: readonly RegisterRoutes[] = [
  registerMeta,
  registerSync,
  registerTriage,
  registerPapers,
  registerAcs,
  registerReviewers,
  registerPeople,
  registerOverview,
];

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
  app.addHook("onSend", async (req, reply, payload) => {
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

  const deps: RouteDeps = { cfg: o.cfg, store: o.store, clock: o.clock, analysis, sync: o.sync, ruleNames: RULE_NAMES };
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
