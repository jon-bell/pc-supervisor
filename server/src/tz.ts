// Time-zone conversion using the built-in Intl API (Node ships full ICU), so
// there is no date library dependency. Phase dates and PCS_NOW are written as
// ISO local times ("2030-02-01T23:59") and interpreted in PCS_TZ.
//
// DST rule (same as Temporal's "compatible" disambiguation):
// - a local time that occurs twice (fall back) maps to the EARLIER instant;
// - a local time that never occurs (spring forward) is pushed FORWARD by the
//   length of the gap (02:30 on a 02:00->03:00 day becomes 03:30).

export interface LocalDateTime {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
  /** Explicit UTC offset in minutes, when the string carried one ("Z", "+02:00"). */
  offsetMinutes?: number;
}

const ISO_LOCAL =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:?\d{2})?$/;

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Parse "YYYY-MM-DDTHH:MM[:SS[.sss]][Z|±HH:MM]". A time is required: a bare
 * date is ambiguous for a deadline (start or end of day?). Returns null on any
 * malformed or out-of-range component.
 */
export function parseIsoLocal(s: string): LocalDateTime | null {
  const m = ISO_LOCAL.exec(s.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, sec, ms, off] = m;
  const out: LocalDateTime = {
    year: Number(y),
    month: Number(mo),
    day: Number(d),
    hour: Number(h),
    minute: Number(mi),
    second: sec ? Number(sec) : 0,
    millisecond: ms ? Number(ms.padEnd(3, "0")) : 0,
  };
  if (out.month < 1 || out.month > 12) return null;
  if (out.day < 1 || out.day > daysInMonth(out.year, out.month)) return null;
  if (out.hour > 23 || out.minute > 59 || out.second > 59) return null;
  if (off) {
    if (off === "Z") {
      out.offsetMinutes = 0;
    } else {
      const sign = off[0] === "-" ? -1 : 1;
      const digits = off.slice(1).replace(":", "");
      const oh = Number(digits.slice(0, 2));
      const om = Number(digits.slice(2, 4));
      if (oh > 23 || om > 59) return null;
      out.offsetMinutes = sign * (oh * 60 + om);
    }
  }
  return out;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** True if `tz` is an IANA zone name (or "UTC") that Intl understands. */
export function isValidTimeZone(tz: string): boolean {
  if (tz.trim() === "") return false;
  try {
    formatterFor(tz);
    return true;
  } catch {
    return false;
  }
}

/** Offset of `timeZone` from UTC at instant `epochMs`, in milliseconds (local - UTC). */
export function zoneOffsetMs(epochMs: number, timeZone: string): number {
  const parts = formatterFor(timeZone).formatToParts(new Date(epochMs));
  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  // formatToParts drops milliseconds; compare at whole-second resolution.
  return asUtc - Math.floor(epochMs / 1000) * 1000;
}

const DAY_MS = 86_400_000;

/** Convert a wall-clock time in `timeZone` to an instant (see DST rule above). */
export function zonedTimeToInstant(t: LocalDateTime, timeZone: string): Date {
  const wall = Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second, t.millisecond);
  if (t.offsetMinutes !== undefined) {
    return new Date(wall - t.offsetMinutes * 60_000);
  }
  // Real zones have at most one transition within +-1 day, so the true offset
  // is one of these two.
  const before = zoneOffsetMs(wall - DAY_MS, timeZone);
  const after = zoneOffsetMs(wall + DAY_MS, timeZone);
  const valid = [before, after]
    .map((off) => wall - off)
    .filter((cand) => zoneOffsetMs(cand, timeZone) === wall - cand);
  if (valid.length > 0) {
    return new Date(Math.min(...valid));
  }
  // Gap: use the pre-transition offset, which lands after the gap.
  return new Date(wall - before);
}

/** Parse an ISO local (or offset) date-time in `timeZone`. Null if malformed. */
export function parseInstant(s: string, timeZone: string): Date | null {
  const t = parseIsoLocal(s);
  return t ? zonedTimeToInstant(t, timeZone) : null;
}

function pad(n: number, w = 2): string {
  return String(Math.abs(n)).padStart(w, "0");
}

/** Format an instant as ISO 8601 with the zone's offset, e.g. 2030-02-01T23:59:00-05:00. */
export function formatInZone(d: Date, timeZone: string): string {
  const off = zoneOffsetMs(d.getTime(), timeZone);
  const local = new Date(d.getTime() + off);
  const offMin = Math.round(off / 60_000);
  const sign = offMin < 0 ? "-" : "+";
  return (
    `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}` +
    `T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}` +
    `${sign}${pad(Math.floor(Math.abs(offMin) / 60))}:${pad(Math.abs(offMin) % 60)}`
  );
}
