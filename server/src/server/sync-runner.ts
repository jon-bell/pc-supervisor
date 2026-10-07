// "Sync now" for the server: at most one sync at a time in this process.
// A second request while one runs is refused (the route answers 409), never
// queued, so a double click can't start two full fetches.

import { redact } from "../redact.js";
import type { SyncResult } from "../sync/sync.js";

export class SyncRunner {
  #current: Promise<SyncResult> | undefined;
  #lastError: string | null = null;

  /**
   * `run` performs one sync (runSync with the server's store and source). Its
   * result's errors must already be redacted; a thrown error is redacted here
   * with `secrets` (pass [cfg.hotcrp.token]).
   */
  constructor(
    private readonly run: () => Promise<SyncResult>,
    private readonly onDone: (r: SyncResult) => void = () => undefined,
    private readonly secrets: readonly string[] = [],
  ) {}

  get running(): boolean {
    return this.#current !== undefined;
  }

  get lastError(): string | null {
    return this.#lastError;
  }

  /** The in-flight sync, if any (tests await it). */
  get current(): Promise<SyncResult> | undefined {
    return this.#current;
  }

  /** Start a sync unless one is running. Returns false if one already is. */
  start(): boolean {
    if (this.#current) return false;
    const p = this.run()
      .then((r) => {
        this.#lastError = r.ok ? null : (r.errors.at(-1) ?? "sync failed");
        this.onDone(r);
        return r;
      })
      .finally(() => {
        this.#current = undefined;
      });
    this.#current = p;
    // Failures are recorded above; don't leave an unhandled rejection behind.
    p.catch((e: unknown) => {
      this.#lastError = redact(e instanceof Error ? e.message : String(e), this.secrets);
    });
    return true;
  }
}
