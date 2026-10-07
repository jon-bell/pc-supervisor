// Read-only transport for `pcs probe`. The probe is the one command the chair
// may run against a real instance (AGENTS.md rule 2), so it must be strictly
// GET-only. Two layers enforce that:
//
// 1. ProbeReader exposes only reads: its spec type has no `method`, and every
//    call goes to HotcrpClient.call with method "GET" (the client may turn a
//    long GET into POST-as-GET, `?:method:=GET`, which HotCRP treats as GET).
// 2. readOnlyFetch wraps fetch and refuses any request that is not a GET or a
//    POST-as-GET, whatever code path produced it.
//
// readOnlyFetch also records rate-limit headers (numbers only) for the report.

import { z } from "zod";
import type { HotcrpClient, Params } from "../hotcrp/client.js";
import { pidChunks } from "../hotcrp/chunk.js";

export class WriteRefusedError extends Error {
  constructor(method: string) {
    super(`pcs probe is read-only: refused a ${method} request that is not POST-as-GET`);
    this.name = "WriteRefusedError";
  }
}

export interface RateLimitObservation {
  /** Header names seen (lowercase), e.g. x-ratelimit-limit. */
  headers: Set<string>;
  limit?: number;
  minRemaining?: number;
  responses: number;
  status429: number;
  retryAfterSeen: number;
}

export function newRateLimitObservation(): RateLimitObservation {
  return { headers: new Set(), responses: 0, status429: 0, retryAfterSeen: 0 };
}

/** True if this request is a read: GET/HEAD, or POST with `:method:=GET`. */
export function isReadRequest(method: string, url: URL): boolean {
  const m = method.toUpperCase();
  if (m === "GET" || m === "HEAD") return true;
  return m === "POST" && url.searchParams.get(":method:") === "GET";
}

export function readOnlyFetch(inner: typeof globalThis.fetch, rl: RateLimitObservation): typeof globalThis.fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (!isReadRequest(method, url)) throw new WriteRefusedError(method.toUpperCase());
    const res = await inner(input, init);
    rl.responses++;
    if (res.status === 429) rl.status429++;
    for (const [name, value] of res.headers) {
      const n = name.toLowerCase();
      if (n.startsWith("x-ratelimit-") || n === "retry-after" || n.startsWith("ratelimit")) rl.headers.add(n);
      if (n === "retry-after") rl.retryAfterSeen++;
      const num = Number(value);
      if (!Number.isFinite(num)) continue;
      if (n === "x-ratelimit-limit") rl.limit = num;
      if (n === "x-ratelimit-remaining") rl.minRemaining = Math.min(rl.minRemaining ?? num, num);
    }
    return res;
  };
}

export interface ReadSpec {
  /** Path under /api, e.g. "reviews" or "12/reviewhistory". */
  path: string;
  params?: Params;
  postAsGet?: boolean;
  format?: "json" | "csv";
}

/**
 * Read-only view of a HotcrpClient. Returns the response body after the
 * client's envelope checks (ok:true, no warnings) but before schema
 * validation, so the probe can report schema drift instead of throwing.
 */
export class ProbeReader {
  readonly #client: HotcrpClient;
  constructor(client: HotcrpClient) {
    this.#client = client;
  }

  get forceShow(): boolean {
    return this.#client.forceShow;
  }

  read(spec: ReadSpec): Promise<unknown> {
    return this.#client.call({ ...spec, method: "GET", schema: z.unknown() });
  }

  /** `read` once per pid-range chunk (q=<range>), bounded by the client's limiter. */
  async readChunks(pids: readonly number[], spec: (q: string) => ReadSpec, each: (body: unknown) => void): Promise<number> {
    const chunks = pidChunks(pids, this.#client.chunkSize);
    await Promise.all(chunks.map(async (c) => each(await this.read(spec(c.q)))));
    return chunks.length;
  }
}
