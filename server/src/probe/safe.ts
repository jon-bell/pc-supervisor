// "No content" plumbing for `pcs probe` (PLAN M0).
//
// The probe's report must never contain titles, names, emails, review or
// comment text, or tag values attached to people. That is enforced by types:
// every string in a ProbeReport is a `Safe`, and the only ways to make one are
// the sanitizers below. The collector (collect.ts) is the only code that sees
// raw HotCRP responses; it hands the renderers aggregated counts plus Safe
// strings drawn from configuration (key names, field UIDs, form labels,
// decision and status names, user-tag names).

declare const SAFE: unique symbol;
/** A string vetted for the probe report. Build with ident(), label() or note(). */
export type Safe = string & { readonly [SAFE]: true };

const IDENT = /^[A-Za-z0-9_.:~#+-]{1,64}$/;
const EMAIL = /[^\s@<>"']+@[^\s@<>"']+/g;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;

/** An identifier-like token (JSON key, field UID, tag name, role); otherwise "?". */
export function ident(s: string): Safe {
  return (IDENT.test(s) ? s : "?") as Safe;
}

/** True if `s` would survive ident() unchanged. */
export function isIdent(s: string): boolean {
  return IDENT.test(s);
}

/**
 * A short configuration label (form field name, score label, decision or
 * status name). No "@", no control characters, at most 60 characters.
 */
export function label(s: string): Safe {
  const t = s.replace(CONTROL, " ").trim();
  if (t.length === 0 || t.length > 60 || t.includes("@") || t.includes("<")) return "?" as Safe;
  return t as Safe;
}

/** A diagnostic message (e.g. a HotcrpError): emails masked, capped at 300 chars. */
export function note(s: string): Safe {
  const t = s.replace(CONTROL, " ").replace(EMAIL, "[email]");
  return (t.length > 300 ? `${t.slice(0, 297)}...` : t) as Safe;
}

// ---------------------------------------------------------------------------
// Shape accumulation: which keys appear on a set of objects, how often, and
// with which JSON types. Only key names (filtered through ident) are kept.

export type JsonType = "string" | "integer" | "number" | "boolean" | "null" | "array" | "object";

export function jsonType(v: unknown): JsonType {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  switch (typeof v) {
    case "string":
      return "string";
    case "number":
      return Number.isInteger(v) ? "integer" : "number";
    case "boolean":
      return "boolean";
    default:
      return "object";
  }
}

export interface KeyShape {
  key: Safe;
  present: number;
  total: number;
  types: JsonType[];
}

export interface Shape {
  objects: number;
  keys: KeyShape[];
  /** Keys that weren't identifier-like (counted, never named). */
  otherKeys: number;
}

export class ShapeAccumulator {
  #objects = 0;
  readonly #keys = new Map<string, { present: number; types: Set<JsonType> }>();
  readonly #other = new Set<string>();

  add(obj: unknown): void {
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return;
    this.#objects++;
    for (const [k, v] of Object.entries(obj)) {
      if (!isIdent(k)) {
        this.#other.add(k);
        continue;
      }
      let e = this.#keys.get(k);
      if (!e) this.#keys.set(k, (e = { present: 0, types: new Set() }));
      e.present++;
      e.types.add(jsonType(v));
    }
  }

  get objects(): number {
    return this.#objects;
  }

  present(key: string): number {
    return this.#keys.get(key)?.present ?? 0;
  }

  result(): Shape {
    const keys = [...this.#keys.entries()]
      .map(([k, e]) => ({ key: ident(k), present: e.present, total: this.#objects, types: [...e.types].sort() }))
      .sort((a, b) => b.present - a.present || a.key.localeCompare(b.key));
    return { objects: this.#objects, keys, otherKeys: this.#other.size };
  }
}

/** [name, count] pairs, most frequent first. */
export type Counts = [Safe, number][];

/** Counter keyed by Safe strings. */
export class Tally {
  readonly #m = new Map<Safe, number>();
  add(k: Safe, n = 1): void {
    this.#m.set(k, (this.#m.get(k) ?? 0) + n);
  }
  get size(): number {
    return this.#m.size;
  }
  result(): Counts {
    return [...this.#m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }
}
