// The ONLY source of "now" in this codebase (AGENTS.md). ESLint bans
// `Date.now()`, `Date()`, and argument-less `new Date()` everywhere else.
//
// Phase logic takes a Clock (or a Date from one) instead of reading time
// itself, so it is testable at any instant. PCS_NOW pins the clock; it is
// parsed by config.ts in PCS_TZ unless it carries an explicit offset.

import { loadClockConfig } from "./config.js";

export interface Clock {
  /** The current instant. Returns a fresh Date each call (safe to mutate). */
  now(): Date;
  /** True when pinned by PCS_NOW or a test. */
  readonly pinned: boolean;
}

/** Wall-clock time. Use for transport timing (Retry-After), never for phase logic. */
export const systemClock: Clock = Object.freeze({
  now: () => new Date(),
  pinned: false,
});

/** A clock frozen at `at`. */
export function fixedClock(at: Date): Clock {
  const ms = at.getTime();
  if (!Number.isFinite(ms)) throw new RangeError("fixedClock: invalid Date");
  return Object.freeze({ now: () => new Date(ms), pinned: true });
}

/** The app clock for a loaded Config: pinned if PCS_NOW was set. */
export function clockFromConfig(cfg: { now: Date | undefined }): Clock {
  return cfg.now ? fixedClock(cfg.now) : systemClock;
}

/** The app clock straight from env (only PCS_NOW and PCS_TZ are read). */
export function clockFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): Clock {
  return clockFromConfig(loadClockConfig(env));
}
