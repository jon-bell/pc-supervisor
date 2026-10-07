// The confirmed tagging flow (PLAN M8, spec §6; AGENTS.md rule 3): the only
// code that passes `allowWrites` to the HotCRP client.
//
// State machine, per preview token:
//
//   preview(add, remove)
//     -> HotCRP dry run (POST /assign?dry_run=1): the exact diff
//     -> empty diff: nothing to confirm, no token
//     -> otherwise a token (32 random bytes) bound to that diff and tag,
//        valid for ttlMs (default 5 min, measured on a monotonic clock so a
//        pinned PCS_NOW can't keep it alive)
//   commit(token, gain, lose, confirm)
//     1. unknown token (never issued, already used, evicted) -> unknown_token
//     2. the token is consumed here, before anything else can fail: single use
//     3. older than ttlMs                                      -> expired
//     4. gain/lose differ from the previewed diff              -> mismatch
//     5. confirm isn't the tag name typed out                  -> not_confirmed
//     6. a fresh dry run of the same changes differs (HotCRP
//        changed since the preview)                            -> stale
//     7. the write, with allowWrites; its reported diff is returned
//
// The write sends only the previewed diff (gain as `tag`, lose as
// `cleartag`), never the client's request, so what runs is what was shown.

import { randomBytes } from "node:crypto";
import type { TagChange, TagDiff } from "../hotcrp/tag-assign.js";

/** What the flow needs from the HotCRP client (HotcrpClient satisfies it). */
export interface TagWriter {
  assignTags(changes: readonly TagChange[], tag: string, opts: { dryRun: true } | { dryRun: false; allowWrites: true }): Promise<TagDiff>;
}

export type TagFlowErrorCode = "invalid" | "unknown_token" | "expired" | "mismatch" | "not_confirmed" | "stale";

const STATUS: Record<TagFlowErrorCode, number> = {
  invalid: 400,
  not_confirmed: 400,
  unknown_token: 409,
  mismatch: 409,
  stale: 409,
  expired: 410,
};

export class TagFlowError extends Error {
  readonly status: number;
  constructor(
    readonly code: TagFlowErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TagFlowError";
    this.status = STATUS[code];
  }
}

export interface TagPreview {
  tag: string;
  /** null when the diff is empty (nothing to confirm). */
  token: string | null;
  gain: number[];
  lose: number[];
  /** Requested pids HotCRP would leave as they are. */
  unchanged: number[];
  /** Milliseconds until the token expires. */
  expiresInMs: number;
}

export interface TagFlowOptions {
  writer: TagWriter;
  tag: string;
  /** Token lifetime. Default 5 minutes. */
  ttlMs?: number;
  /** Monotonic milliseconds (default performance.now). Never the PCS_NOW clock. */
  monotonic?: () => number;
  /** Token generator (tests). Default 32 random bytes, base64url. */
  newToken?: () => string;
  /** Pending previews kept; the oldest is dropped beyond this. Default 16. */
  maxPending?: number;
  /** Most pids in one request. Default 5000. */
  maxPids?: number;
}

interface Pending {
  diff: TagDiff;
  createdAt: number;
}

export const DEFAULT_TTL_MS = 5 * 60_000;

export class TagFlow {
  readonly tag: string;
  readonly ttlMs: number;
  readonly #writer: TagWriter;
  readonly #monotonic: () => number;
  readonly #newToken: () => string;
  readonly #maxPending: number;
  readonly #maxPids: number;
  readonly #pending = new Map<string, Pending>();

  constructor(o: TagFlowOptions) {
    this.tag = o.tag;
    this.ttlMs = o.ttlMs ?? DEFAULT_TTL_MS;
    this.#writer = o.writer;
    this.#monotonic = o.monotonic ?? (() => performance.now());
    this.#newToken = o.newToken ?? (() => randomBytes(32).toString("base64url"));
    this.#maxPending = o.maxPending ?? 16;
    this.#maxPids = o.maxPids ?? 5000;
  }

  /** Pending (unused, unexpired) previews; for tests. */
  get pendingCount(): number {
    this.#purge();
    return this.#pending.size;
  }

  /** Dry-run `add`/`remove` and, if anything would change, issue a token for exactly that diff. */
  async preview(req: { add?: unknown; remove?: unknown }): Promise<TagPreview> {
    const add = this.#pids(req.add, "add");
    const remove = this.#pids(req.remove, "remove");
    if (add.length + remove.length === 0) throw new TagFlowError("invalid", "nothing to preview: give pids to add or remove");
    if (add.length + remove.length > this.#maxPids) throw new TagFlowError("invalid", `at most ${this.#maxPids} papers per change`);
    const both = add.filter((p) => remove.includes(p));
    if (both.length > 0) throw new TagFlowError("invalid", `#${both[0]} is in both add and remove`);
    const changes: TagChange[] = [...add.map((pid) => ({ pid, op: "add" as const })), ...remove.map((pid) => ({ pid, op: "remove" as const }))];
    const diff = await this.#writer.assignTags(changes, this.tag, { dryRun: true });
    const changed = new Set([...diff.gain, ...diff.lose]);
    const unchanged = [...add, ...remove].filter((p) => !changed.has(p)).sort((a, b) => a - b);
    if (changed.size === 0) return { tag: this.tag, token: null, ...diff, unchanged, expiresInMs: 0 };
    this.#purge();
    while (this.#pending.size >= this.#maxPending) this.#pending.delete(this.#pending.keys().next().value!);
    const token = this.#newToken();
    this.#pending.set(token, { diff, createdAt: this.#monotonic() });
    return { tag: this.tag, token, ...diff, unchanged, expiresInMs: this.ttlMs };
  }

  /** Commit a previewed diff. See the state machine above. */
  async commit(req: { token?: unknown; gain?: unknown; lose?: unknown; confirm?: unknown }): Promise<TagDiff> {
    if (typeof req.token !== "string" || req.token === "") throw new TagFlowError("invalid", "token is required: run the dry run first");
    const p = this.#pending.get(req.token);
    if (!p) throw new TagFlowError("unknown_token", "this preview is unknown or was already used; run the dry run again");
    this.#pending.delete(req.token);
    if (this.#monotonic() - p.createdAt > this.ttlMs) {
      throw new TagFlowError("expired", `this preview is older than ${Math.round(this.ttlMs / 1000)} s; run the dry run again`);
    }
    let gain: number[];
    let lose: number[];
    try {
      gain = this.#pids(req.gain, "gain");
      lose = this.#pids(req.lose, "lose");
    } catch {
      throw new TagFlowError("mismatch", "the confirmed papers don't match the preview; run the dry run again");
    }
    if (!same(gain, p.diff.gain) || !same(lose, p.diff.lose)) {
      throw new TagFlowError("mismatch", "the confirmed papers don't match the preview; run the dry run again");
    }
    if (req.confirm !== this.tag) throw new TagFlowError("not_confirmed", `type the tag name (${this.tag}) to confirm`);

    const changes: TagChange[] = [
      ...p.diff.gain.map((pid) => ({ pid, op: "add" as const })),
      ...p.diff.lose.map((pid) => ({ pid, op: "remove" as const })),
    ];
    const again = await this.#writer.assignTags(changes, this.tag, { dryRun: true });
    if (!same(again.gain, p.diff.gain) || !same(again.lose, p.diff.lose)) {
      throw new TagFlowError("stale", "HotCRP changed since the preview; run the dry run again");
    }
    return this.#writer.assignTags(changes, this.tag, { dryRun: false, allowWrites: true });
  }

  #purge(): void {
    const now = this.#monotonic();
    for (const [k, v] of this.#pending) if (now - v.createdAt > this.ttlMs) this.#pending.delete(k);
  }

  #pids(v: unknown, what: string): number[] {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) throw new TagFlowError("invalid", `${what} must be a list of paper numbers`);
    const out = new Set<number>();
    for (const x of v) {
      if (typeof x !== "number" || !Number.isInteger(x) || x < 1 || x > 999_999_999) {
        throw new TagFlowError("invalid", `${what} must be a list of paper numbers`);
      }
      out.add(x);
    }
    return [...out].sort((a, b) => a - b);
  }
}

function same(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}
