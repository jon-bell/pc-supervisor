// Typed, read-only HotCRP API client (spec §1, §4).
//
// - Bearer auth; the token lives in a private field and is redacted from
//   every error and event.
// - JSON requests send pretty=0.
// - Long queries go as POST-as-GET (`?:method:=GET`, form body). Bulk reads
//   (reviews, comments) always do.
// - At most `concurrency` requests in flight (PCS_SYNC_CONCURRENCY).
// - Reads retry on 429/5xx/network errors/timeouts with exponential backoff
//   and full jitter, honoring Retry-After. Writes never retry.
// - Every response is validated with its schema from schemas.ts.
// - The only host it ever calls is `baseUrl` (AGENTS.md rule 4).
//
// Default HotCRP rate limits are 250 requests/minute and 5000/hour per user
// (src/contactcounter.php); responses carry x-ratelimit-* headers.

import { inspect } from "node:util";
import type { z } from "zod";
import { systemClock, type Clock } from "../clock.js";
import type { HotcrpConfig } from "../config.js";
import { redact } from "../redact.js";
import { pidChunks } from "./chunk.js";
import { Limiter } from "./concurrency.js";
import { CsvError, parseCsvRecords } from "./csv.js";
import { describeMessages, HotcrpError } from "./errors.js";
import {
  CommentsSchema,
  EnvelopeSchema,
  PcAssignmentsSchema,
  PcConflictsSchema,
  PcSchema,
  paperRoleRowsSchema,
  ReviewHistorySchema,
  ReviewRatingSchema,
  ReviewsSchema,
  RqcSchema,
  SearchSchema,
  SettingsRfSchema,
  WhoamiSchema,
  AssignResultSchema,
  PapersSchema,
  SettingsSfSchema,
  type AssignResult,
  type Paper,
  type Comment,
  type HotcrpMessage,
  type PaperRoleRow,
  type PcAssignmentRow,
  type PcConflictRow,
  type Review,
} from "./schemas.js";
import { AssignTagsResultSchema, tagAssignmentBody, tagDiffOf, type TagChange, type TagDiff } from "./tag-assign.js";

/**
 * Paper-set scopes (`t=`). HotCRP silently treats an unknown scope as "none",
 * so only these are accepted. `s` = submitted (the /search default), `all`
 * includes drafts and withdrawn, `viewable` = the /reviews and /comments default.
 */
export type SearchScope = "s" | "all" | "viewable";

export type Params = Record<string, string | number | boolean | undefined>;

export interface HotcrpClientEvent {
  type: "request" | "response" | "retry";
  endpoint: string;
  attempt: number;
  status?: number;
  delayMs?: number;
  durationMs?: number;
  /** x-ratelimit-remaining, when HotCRP sent it. */
  rateLimitRemaining?: number;
  /** Already redacted. */
  reason?: string;
}

export interface HotcrpClientOptions {
  /** Conference base URL, no trailing slash, no /api (config.hotcrp.url). */
  baseUrl: string;
  token: string;
  /** false = respect the chair's conflicts (PCS_FORCE_SHOW). Default true. */
  forceShow?: boolean;
  /** Max requests in flight (PCS_SYNC_CONCURRENCY). Default 2. */
  concurrency?: number;
  /** Papers per chunk for bulk reads (PCS_SYNC_CHUNK). Default 200. */
  chunkSize?: number;
  /** Per-attempt timeout. Default 120 s. */
  timeoutMs?: number;
  /** Retries after the first attempt, for reads. Default 5. */
  maxRetries?: number;
  /** Backoff base and cap. Defaults 500 ms and 30 s. */
  retryBaseMs?: number;
  retryMaxMs?: number;
  /** A Retry-After longer than this fails fast instead of sleeping. Default 120 s. */
  maxRetryAfterMs?: number;
  /** GET URLs longer than this switch to POST-as-GET. Default 2000. */
  maxGetUrlLength?: number;
  /** Injection points for tests. */
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Wall clock, for HTTP-date Retry-After only. */
  wallClock?: Clock;
  onEvent?: (e: HotcrpClientEvent) => void;
}

interface CallSpec<S extends z.ZodType> {
  /** Path under /api, e.g. "reviews" or "12/reviewhistory". */
  path: string;
  params?: Params;
  method?: "GET" | "POST";
  /** Force POST-as-GET (otherwise automatic for long URLs). */
  postAsGet?: boolean;
  format?: "json" | "csv";
  schema: S;
  /** Throw if HotCRP returns warnings (e.g. an unknown search keyword). Default true. */
  rejectWarnings?: boolean;
  /**
   * Send this as an application/json POST body (params stay in the query).
   * HotCRP sniffs JSON bodies; it can't see the Content-Type header under
   * Apache mod_php (Qrequest reads HTTP_CONTENT_TYPE), so CSV/form bodies to
   * endpoints that branch on content type misbehave there.
   */
  jsonBody?: unknown;
  /**
   * Return `ok: false` responses (e.g. an invalid dry run, which HotCRP sends
   * as HTTP 403 with a `valid: false` result body) instead of throwing. Default false.
   */
  allowNotOk?: boolean;
}

const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class HotcrpClient {
  readonly baseUrl: string;
  readonly forceShow: boolean;
  readonly chunkSize: number;
  readonly #token: string;
  readonly #limiter: Limiter;
  readonly #o: Required<Omit<HotcrpClientOptions, "baseUrl" | "token" | "onEvent" | "forceShow" | "chunkSize" | "concurrency">> & {
    onEvent: HotcrpClientOptions["onEvent"];
  };

  constructor(opts: HotcrpClientOptions) {
    const base = new URL(opts.baseUrl); // throws on garbage
    this.baseUrl = `${base.origin}${base.pathname.replace(/\/+$/, "")}`;
    if (!opts.token) throw new Error("HotcrpClient: token is required");
    this.#token = opts.token;
    this.forceShow = opts.forceShow ?? true;
    this.chunkSize = opts.chunkSize ?? 200;
    this.#limiter = new Limiter(opts.concurrency ?? 2);
    this.#o = {
      timeoutMs: opts.timeoutMs ?? 120_000,
      maxRetries: opts.maxRetries ?? 5,
      retryBaseMs: opts.retryBaseMs ?? 500,
      retryMaxMs: opts.retryMaxMs ?? 30_000,
      maxRetryAfterMs: opts.maxRetryAfterMs ?? 120_000,
      maxGetUrlLength: opts.maxGetUrlLength ?? 2000,
      fetch: opts.fetch ?? globalThis.fetch,
      sleep: opts.sleep ?? defaultSleep,
      random: opts.random ?? Math.random,
      wallClock: opts.wallClock ?? systemClock,
      onEvent: opts.onEvent,
    };
  }

  /** Never reveal the token through util.inspect / console.log / JSON. */
  [inspect.custom](): string {
    return `HotcrpClient { baseUrl: ${JSON.stringify(this.baseUrl)} }`;
  }
  toJSON(): { baseUrl: string } {
    return { baseUrl: this.baseUrl };
  }

  // ------------------------------------------------------------------------
  // Read endpoints

  /** GET /whoami: the token's account and roles. */
  whoami() {
    return this.call({ path: "whoami", schema: WhoamiSchema });
  }

  /** GET /pc: the PC roster (no per-user tags; see schemas.ts). */
  pc() {
    return this.call({ path: "pc", schema: PcSchema });
  }

  /**
   * GET /search with display fields, e.g. fields: ["title", "status",
   * "decision", "tags", "lead", "shepherd", "manager", "reviewers", "revstat"].
   * Field values come back as plain text; empty fields are omitted.
   */
  async search(opts: { q?: string; t?: SearchScope; fields?: readonly string[] } = {}) {
    const t = opts.t ?? "s";
    const fields = opts.fields ?? [];
    const res = await this.call({
      path: "search",
      params: {
        q: opts.q ?? "all",
        t,
        ...(fields.length > 0 ? { f: fields.join(" "), format: "csv" } : {}),
        forceShow: this.forceShow ? 1 : 0,
      },
      schema: SearchSchema,
    });
    // Guard against HotCRP silently narrowing the scope.
    const echoed = new URLSearchParams(res.search_params).get("t");
    if (echoed !== t) {
      throw new HotcrpError("api", "GET /search", `asked for t=${t} but HotCRP searched t=${echoed ?? "(none)"}`);
    }
    return res;
  }

  /** GET /searchaction?action=get/pcassignments: review assignments as CSV rows. */
  pcAssignments(opts: { q?: string; t?: SearchScope } = {}): Promise<PcAssignmentRow[]> {
    return this.call({
      path: "searchaction",
      params: { action: "get/pcassignments", q: opts.q ?? "all", t: opts.t, forceShow: this.forceShow ? 1 : 0 },
      format: "csv",
      schema: PcAssignmentsSchema,
    });
  }

  /**
   * GET /searchaction?action=get/lead (or get/shepherd): one {pid, email} per
   * paper that has a discussion lead (shepherd). /search only gives names.
   */
  paperRoles(kind: "lead" | "shepherd", opts: { q?: string; t?: SearchScope } = {}): Promise<PaperRoleRow[]> {
    return this.call({
      path: "searchaction",
      params: { action: `get/${kind}`, q: opts.q ?? "all", t: opts.t, forceShow: this.forceShow ? 1 : 0 },
      format: "csv",
      schema: paperRoleRowsSchema(kind),
    });
  }

  /**
   * GET /searchaction?action=get/pcconf: every conflicted (paper, PC member)
   * pair, as HotCRP's "PC conflicts" CSV download (chair/manager token).
   * Includes author conflicts of PC members.
   */
  pcConflicts(opts: { q?: string; t?: SearchScope } = {}): Promise<PcConflictRow[]> {
    return this.call({
      path: "searchaction",
      params: { action: "get/pcconf", q: opts.q ?? "all", t: opts.t, forceShow: this.forceShow ? 1 : 0 },
      format: "csv",
      schema: PcConflictsSchema,
    });
  }

  /**
   * POST-as-GET /reviews for one query (use reviewsForPids for bulk).
   * `rq` keeps only reviews matching a review search, e.g. `re:#junior`
   * (reviews by PC members holding user tag `junior`). HotCRP warns, and the
   * client throws, if `rq` names a user tag nobody holds.
   */
  async reviews(opts: { q: string; t?: SearchScope; rq?: string }): Promise<Review[]> {
    const res = await this.call({
      path: "reviews",
      params: { q: opts.q, t: opts.t, rq: opts.rq, forceShow: this.forceShow ? 1 : 0 },
      postAsGet: true,
      schema: ReviewsSchema,
    });
    return res.reviews;
  }

  /** POST-as-GET /comments for one query (use commentsForPids for bulk). */
  async comments(opts: { q: string; t?: SearchScope }): Promise<Comment[]> {
    const res = await this.call({
      path: "comments",
      params: { q: opts.q, t: opts.t, forceShow: this.forceShow ? 1 : 0 },
      postAsGet: true,
      schema: CommentsSchema,
    });
    return res.comments;
  }

  /** All reviews for `pids`, fetched in pid-range chunks with bounded concurrency. */
  reviewsForPids(pids: Iterable<number>, opts: { t?: SearchScope; rq?: string } = {}): Promise<Review[]> {
    return this.chunked(pids, (q) => this.reviews({ q, ...opts }));
  }

  /** All comments for `pids`, fetched in pid-range chunks with bounded concurrency. */
  commentsForPids(pids: Iterable<number>, opts: { t?: SearchScope } = {}): Promise<Comment[]> {
    return this.chunked(pids, (q) => this.comments({ q, ...opts }));
  }

  /**
   * GET /{pid}/reviewhistory?r=: one review's versions (admin only; backfill).
   * With `expand: true`, older versions come back as full `review` objects
   * (with their own modified_at) instead of `review_delta` patches.
   */
  reviewHistory(pid: number, rid: number, opts: { expand?: boolean } = {}) {
    return this.call({
      path: `${checkId(pid)}/reviewhistory`,
      params: { r: checkId(rid), expand: opts.expand ? 1 : undefined },
      schema: ReviewHistorySchema,
    });
  }

  /** GET /{pid}/reviewrating?r=: ratings of one review. */
  reviewRating(pid: number, rid: number) {
    return this.call({ path: `${checkId(pid)}/reviewrating`, params: { r: checkId(rid) }, schema: ReviewRatingSchema });
  }

  /**
   * The review form keyed by field UID (the keys used in /reviews), with
   * score labels. Uses the get/jsonrqc list action on an empty paper set
   * (q=NONE), so no paper content is fetched.
   */
  reviewForm() {
    return this.call({
      path: "searchaction",
      params: { action: "get/jsonrqc", q: "NONE" },
      schema: RqcSchema,
    });
  }

  /** GET /settings?filter=rf: review fields by internal id, with value symbols. */
  reviewFormSettings() {
    return this.call({ path: "settings", params: { filter: "rf" }, schema: SettingsRfSchema });
  }

  /**
   * POST-as-GET /papers: full paper objects (authors with email and
   * affiliation, submission-option values keyed by option name). Use
   * papersForPids for bulk. The objects also hold abstracts; callers must not
   * store what they don't need.
   */
  async papers(opts: { q: string; t?: SearchScope }): Promise<Paper[]> {
    const res = await this.call({
      path: "papers",
      params: { q: opts.q, t: opts.t, forceShow: this.forceShow ? 1 : 0 },
      postAsGet: true,
      schema: PapersSchema,
    });
    return res.papers;
  }

  /** All paper objects for `pids`, in pid-range chunks with bounded concurrency. */
  papersForPids(pids: Iterable<number>, opts: { t?: SearchScope } = {}): Promise<Paper[]> {
    return this.chunked(pids, (q) => this.papers({ q, ...opts }));
  }

  /** GET /settings?filter=sf: submission fields; configured options have numeric ids. */
  submissionFields() {
    return this.call({ path: "settings", params: { filter: "sf" }, schema: SettingsSfSchema });
  }

  /**
   * POST /assign?dry_run=1: ask HotCRP whether an assignment CSV
   * (`paper,action,user[,...]`, header row first) would apply, without
   * applying it. Conflicts are enforced (forceShow=0). The CSV is parsed
   * locally and sent as a JSON array of row objects (same columns), the form
   * HotCRP accepts regardless of server setup (see CallSpec.jsonBody).
   * An invalid assignment is a result (`valid: false` + messages), not an
   * error. Dry runs only: `dryRun: false` always rejects (the one write path is
   * assignTags below, PLAN M8).
   */
  async assign(csv: string, opts: { dryRun: boolean }): Promise<AssignResult> {
    if (opts.dryRun !== true) {
      throw new HotcrpError("writes_disabled", "POST /assign", "assignment CSVs are dry-run only; the app's one write path is assignTags");
    }
    let rows: Record<string, string>[];
    try {
      rows = parseCsvRecords(csv);
    } catch (e) {
      if (e instanceof CsvError) throw new HotcrpError("protocol", "POST /assign", `bad assignment CSV: ${e.message}`);
      throw e;
    }
    const res = await this.call({
      path: "assign",
      method: "POST",
      params: { dry_run: 1, forceShow: 0, format: "json" },
      jsonBody: rows,
      schema: AssignResultSchema,
      rejectWarnings: false,
      allowNotOk: true,
    });
    if (res.dry_run !== true) {
      throw new HotcrpError("protocol", "POST /assign", "HotCRP did not confirm dry_run; treat the result as unknown");
    }
    return res;
  }

  // ------------------------------------------------------------------------
  // Writes (PLAN M8). The only write path: tag changes, dry-run first.

  /**
   * Add or remove one tag on papers via POST /assign (see tag-assign.ts for
   * why not /assigntags). `dryRun: true` changes nothing in HotCRP and
   * returns the diff it would make. A real run additionally requires
   * `allowWrites: true`, which only the confirmed tagging flow
   * (server/src/actions/tagging.ts) passes; anything else gets a
   * `writes_disabled` error before a request is made. Writes never retry.
   */
  async assignTags(
    changes: readonly TagChange[],
    tag: string,
    opts: { dryRun: true } | { dryRun: false; allowWrites: true },
  ): Promise<TagDiff> {
    const endpoint = "POST /assign";
    if (!opts.dryRun && (opts as { allowWrites?: unknown }).allowWrites !== true) {
      throw new HotcrpError("writes_disabled", endpoint, "writes need allowWrites (only the confirmed tagging flow passes it)");
    }
    const body = tagAssignmentBody(changes, tag);
    const res = await this.call({
      path: "assign",
      method: "POST",
      params: { dry_run: opts.dryRun ? 1 : undefined, format: "json", forceShow: this.forceShow ? 1 : 0 },
      jsonBody: body,
      schema: AssignTagsResultSchema,
    });
    if (!res.valid) throw new HotcrpError("api", endpoint, "HotCRP reported the assignment as invalid");
    if (opts.dryRun && res.dry_run !== true) throw new HotcrpError("protocol", endpoint, "asked for a dry run but HotCRP did not report one");
    return tagDiffOf(res, tag);
  }

  // ------------------------------------------------------------------------
  // Plumbing

  /** Run `fetchChunk` over pid-range chunks; results concatenated in pid order. */
  async chunked<T>(pids: Iterable<number>, fetchChunk: (q: string) => Promise<T[]>): Promise<T[]> {
    const chunks = pidChunks(pids, this.chunkSize);
    // The client-wide limiter bounds concurrency; Promise.all just queues.
    const parts = await Promise.all(chunks.map((c) => fetchChunk(c.q)));
    return parts.flat();
  }

  /** One validated API call (exposed for M0 probe / new endpoints; prefer the typed methods). */
  async call<S extends z.ZodType>(spec: CallSpec<S>): Promise<z.output<S>> {
    const method = spec.method ?? "GET";
    const endpoint = `${method} /${spec.path.replace(/^\d+\//, "{p}/")}`;
    const format = spec.format ?? "json";
    const params = new URLSearchParams();
    if (format === "json") params.set("pretty", "0");
    for (const [k, v] of Object.entries(spec.params ?? {})) {
      if (v !== undefined) params.set(k, typeof v === "boolean" ? (v ? "1" : "0") : String(v));
    }

    const url = new URL(`${this.baseUrl}/api/${spec.path}`);
    if (url.origin !== new URL(this.baseUrl).origin) throw new Error("HotcrpClient: refusing cross-origin path");
    let body: URLSearchParams | string | undefined;
    let httpMethod: string = method;
    const asGet = new URL(url);
    asGet.search = params.toString();
    if (spec.jsonBody !== undefined) {
      httpMethod = "POST";
      url.search = params.toString();
      body = JSON.stringify(spec.jsonBody);
    } else if (method === "POST" || spec.postAsGet || asGet.href.length > this.#o.maxGetUrlLength) {
      httpMethod = "POST";
      if (method === "GET") url.searchParams.set(":method:", "GET");
      body = params;
    } else {
      url.search = params.toString();
    }

    const text = await this.#limiter.run(() =>
      this.send(endpoint, url, httpMethod, body, format, method === "GET", spec.allowNotOk ?? false),
    );
    return this.parse(endpoint, text, format, spec.schema, spec.rejectWarnings ?? true, spec.allowNotOk ?? false);
  }

  private async send(
    endpoint: string,
    url: URL,
    method: string,
    body: URLSearchParams | string | undefined,
    format: "json" | "csv",
    retryable: boolean,
    allowNotOk = false,
  ): Promise<string> {
    const o = this.#o;
    for (let attempt = 0; ; attempt++) {
      o.onEvent?.({ type: "request", endpoint, attempt });
      const started = performance.now();
      let res: Response;
      try {
        res = await o.fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${this.#token}`,
            Accept: format === "json" ? "application/json" : "text/csv, application/json",
            ...(typeof body === "string" ? { "Content-Type": "application/json" } : {}),
          },
          body,
          redirect: "manual",
          signal: AbortSignal.timeout(o.timeoutMs),
        });
      } catch (e) {
        const timeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
        const reason = timeout ? `no response within ${o.timeoutMs} ms` : `request failed: ${this.clean(errorText(e))}`;
        if (retryable && attempt < o.maxRetries) {
          await this.backoff(endpoint, attempt, undefined, reason);
          continue;
        }
        throw new HotcrpError(timeout ? "timeout" : "network", endpoint, this.attempts(reason, attempt), {
          cause: new Error(this.clean(errorText(e))),
        });
      }

      const remaining = Number(res.headers.get("x-ratelimit-remaining") ?? NaN);
      o.onEvent?.({
        type: "response",
        endpoint,
        attempt,
        status: res.status,
        durationMs: Math.round(performance.now() - started),
        ...(Number.isFinite(remaining) ? { rateLimitRemaining: remaining } : {}),
      });

      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        let where = "";
        try {
          where = loc ? ` to ${new URL(loc, url).origin}` : "";
        } catch {
          /* ignore */
        }
        throw new HotcrpError("http", endpoint, `unexpected redirect (${res.status})${where}; check PCS_HOTCRP_URL (http vs https?)`, {
          status: res.status,
        });
      }

      if (RETRY_STATUSES.has(res.status)) {
        await res.body?.cancel();
        const retryAfter = parseRetryAfter(res.headers.get("retry-after"), o.wallClock);
        if (res.status === 429 && retryAfter !== undefined && retryAfter > o.maxRetryAfterMs) {
          throw new HotcrpError(
            "rate_limit",
            endpoint,
            `rate limited; HotCRP asks to wait ${Math.ceil(retryAfter / 1000)} s (over the ${o.maxRetryAfterMs / 1000} s limit)`,
            { status: 429 },
          );
        }
        if (retryable && attempt < o.maxRetries) {
          await this.backoff(endpoint, attempt, retryAfter, `HTTP ${res.status}`);
          continue;
        }
        throw new HotcrpError(
          res.status === 429 ? "rate_limit" : "http",
          endpoint,
          this.attempts(`HTTP ${res.status}`, retryable ? attempt : 0),
          { status: res.status },
        );
      }

      const text = await res.text();
      // An invalid /assign dry run is HTTP 403 with a full result body
      // (`valid: false`); with allowNotOk that body is the answer.
      if (!res.ok && allowNotOk && res.status >= 400 && res.status < 500 && /"valid"\s*:/.test(text)) {
        return text;
      }
      if (!res.ok) {
        const messages = this.cleanMessages(jsonMessages(text));
        const detail = messages.length > 0 ? `: ${this.clean(describeMessages(messages))}` : "";
        throw new HotcrpError("http", endpoint, `HTTP ${res.status}${detail}`, { status: res.status, messages });
      }
      return text;
    }
  }

  private parse<S extends z.ZodType>(
    endpoint: string,
    text: string,
    format: "json" | "csv",
    schema: S,
    rejectWarnings: boolean,
    allowNotOk = false,
  ): z.output<S> {
    let data: unknown;
    if (format === "json" || text.trimStart().startsWith("{")) {
      try {
        data = JSON.parse(text);
      } catch {
        throw new HotcrpError("protocol", endpoint, `expected JSON, got ${text.length} bytes that don't parse`);
      }
      const env = EnvelopeSchema.safeParse(data);
      if (env.success) {
        const messages = this.cleanMessages(env.data.message_list ?? []);
        if (!env.data.ok && !allowNotOk) {
          throw new HotcrpError("api", endpoint, `ok=false: ${this.clean(describeMessages(messages)) || "(no message)"}`, {
            messages,
          });
        }
        const warnings = messages.filter((m: HotcrpMessage) => m.status >= 1);
        if (rejectWarnings && warnings.length > 0) {
          throw new HotcrpError("api", endpoint, `HotCRP reported problems: ${this.clean(describeMessages(warnings))}`, {
            messages: warnings,
          });
        }
      } else if (format === "csv") {
        throw new HotcrpError("protocol", endpoint, "expected CSV, got a JSON object");
      }
    } else {
      try {
        data = parseCsvRecords(text);
      } catch (e) {
        if (e instanceof CsvError) throw new HotcrpError("protocol", endpoint, `bad CSV: ${e.message}`);
        throw e;
      }
    }
    const r = schema.safeParse(data);
    if (!r.success) {
      throw new HotcrpError("schema", endpoint, `response doesn't match schema:\n${this.clean(formatIssues(r.error))}`);
    }
    return r.data;
  }

  private async backoff(endpoint: string, attempt: number, retryAfterMs: number | undefined, reason: string) {
    const o = this.#o;
    const exp = Math.min(o.retryMaxMs, o.retryBaseMs * 2 ** attempt);
    const jitter = Math.floor(o.random() * exp); // full jitter
    const delayMs = retryAfterMs !== undefined ? Math.max(retryAfterMs, jitter) : jitter;
    o.onEvent?.({ type: "retry", endpoint, attempt, delayMs, reason });
    await o.sleep(delayMs);
  }

  private attempts(reason: string, attempt: number): string {
    return attempt > 0 ? `${reason} (after ${attempt + 1} attempts)` : reason;
  }

  private cleanMessages(ms: readonly HotcrpMessage[]): HotcrpMessage[] {
    // Keep only status/message/field (drop e.g. `context`, which echoes input).
    return ms.map((m) => ({
      status: m.status,
      ...(m.message !== undefined ? { message: this.clean(m.message) } : {}),
      ...(m.field !== undefined ? { field: this.clean(m.field) } : {}),
    }));
  }

  /** Redact the token (and anything token-shaped). */
  private clean(s: string): string {
    return redact(s, [this.#token]);
  }
}

/** Build a client from validated config (config.hotcrp). */
export function clientFromConfig(
  cfg: HotcrpConfig,
  overrides: Omit<HotcrpClientOptions, "baseUrl" | "token"> = {},
): HotcrpClient {
  return new HotcrpClient({
    baseUrl: cfg.url,
    token: cfg.token,
    forceShow: cfg.forceShow,
    concurrency: cfg.sync.concurrency,
    chunkSize: cfg.sync.chunk,
    ...overrides,
  });
}

function checkId(n: number): number {
  if (!Number.isInteger(n) || n < 1) throw new RangeError(`invalid HotCRP id ${n}`);
  return n;
}

function errorText(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const cause = e.cause instanceof Error ? `: ${e.cause.message}` : "";
  return `${e.message}${cause}`;
}

function jsonMessages(text: string): HotcrpMessage[] {
  try {
    const env = EnvelopeSchema.safeParse(JSON.parse(text));
    return env.success ? (env.data.message_list ?? []) : [];
  } catch {
    return [];
  }
}

/** Zod issues as "path: message" lines. Paths and messages only, never values. */
function formatIssues(err: z.ZodError): string {
  return err.issues
    .slice(0, 20)
    .map((i) => `  ${i.path.length > 0 ? i.path.join(".") : "(root)"}: ${i.message}`)
    .concat(err.issues.length > 20 ? [`  ... and ${err.issues.length - 20} more`] : [])
    .join("\n");
}

/** Retry-After as delay in ms: delta-seconds, or an HTTP-date (wall clock). */
export function parseRetryAfter(v: string | null, wallClock: Clock = systemClock): number | undefined {
  if (v === null || v.trim() === "") return undefined;
  if (/^\d+$/.test(v.trim())) return Number(v.trim()) * 1000;
  const at = Date.parse(v);
  return Number.isNaN(at) ? undefined : Math.max(0, at - wallClock.now().getTime());
}
