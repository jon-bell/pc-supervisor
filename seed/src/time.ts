// Resolve symbolic scenario times against the configured phase dates.

import type { Phases } from "@pcs/server/config";
import { formatInZone, parseIsoLocal, zonedTimeToInstant } from "@pcs/server/tz";
import type { PhaseName, When } from "./format.js";

export interface PhaseContext {
  tz: string;
  phases: Phases;
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** The instant a `When` denotes (see format.ts). Throws on an unset phase or bad time. */
export function resolveWhen(w: When, ctx: PhaseContext): Date {
  const base = ctx.phases[w.phase as PhaseName];
  if (!base) {
    const env = `PCS_PHASE_${w.phase.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`;
    throw new Error(`scenario uses phase "${w.phase}", but ${env} is not set`);
  }
  if (!Number.isInteger(w.day)) throw new Error(`day offset must be an integer, got ${w.day}`);
  // The phase's wall-clock date/time in PCS_TZ (drop the offset suffix).
  const local = parseIsoLocal(formatInZone(base, ctx.tz).slice(0, 19))!;
  let hour = local.hour;
  let minute = local.minute;
  let second = local.second;
  if (w.time !== undefined) {
    const m = TIME_RE.exec(w.time);
    if (!m) throw new Error(`time must be "HH:MM", got ${JSON.stringify(w.time)}`);
    hour = Number(m[1]);
    minute = Number(m[2]);
    second = 0;
  }
  // Calendar arithmetic on the local date (DST-safe: days, not 24 h blocks).
  const d = new Date(Date.UTC(local.year, local.month - 1, local.day + w.day));
  return zonedTimeToInstant(
    {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
      hour,
      minute,
      second,
      millisecond: 0,
    },
    ctx.tz,
  );
}

/** Epoch seconds, as HotCRP stores times. */
export function epochSeconds(d: Date): number {
  return Math.floor(d.getTime() / 1000);
}

export function describeWhen(w: When): string {
  const sign = w.day >= 0 ? "+" : "";
  return `${w.phase} ${sign}${w.day}d${w.time ? ` ${w.time}` : ""}`;
}
