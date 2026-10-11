// Errors thrown by the HotCRP client. Messages name the endpoint and never
// contain the token (they pass through redact()) or response content (review
// or comment text could be in a body, so bodies are never quoted).

import type { HotcrpMessage } from "./schemas.js";

export type HotcrpErrorKind =
  | "network" // fetch failed (DNS, refused, reset)
  | "timeout" // no response within timeoutMs
  | "http" // unexpected HTTP status (incl. redirects, exhausted retries)
  | "rate_limit" // 429 with a Retry-After too long to wait out
  | "api" // HotCRP said ok:false, or reported warnings about the request
  | "protocol" // body wasn't the expected JSON/CSV
  | "schema" // body didn't match its Zod schema
  | "writes_disabled"; // a write without allowWrites (PLAN M8)

export class HotcrpError extends Error {
  readonly kind: HotcrpErrorKind;
  /** e.g. "GET /reviews" */
  readonly endpoint: string;
  readonly status: number | undefined;
  readonly messages: readonly HotcrpMessage[];

  constructor(
    kind: HotcrpErrorKind,
    endpoint: string,
    message: string,
    opts: { status?: number; messages?: readonly HotcrpMessage[]; cause?: unknown } = {},
  ) {
    super(`HotCRP ${endpoint}: ${message}`, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "HotcrpError";
    this.kind = kind;
    this.endpoint = endpoint;
    this.status = opts.status;
    this.messages = opts.messages ?? [];
  }
}

/** Strip HotCRP's ftext prefix ("<0>plain", "<5>html") for display. */
export function ftext(s: string | undefined): string {
  return (s ?? "").replace(/^<\d+>/, "");
}

export function describeMessages(ms: readonly HotcrpMessage[]): string {
  return ms
    .map((m) => `${m.field ? `${m.field}: ` : ""}${ftext(m.message) || `(status ${m.status})`}`)
    .join("; ");
}
