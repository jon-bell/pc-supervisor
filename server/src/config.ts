// Configuration: environment variables only (AGENTS.md, spec §4.1).
//
// To add a setting:
//   1. add a parser to FIELDS below (name, Zod schema, default);
//   2. surface it in the typed Config built by loadConfig();
//   3. document it in .env.example in the same PR.
// Unknown PCS_* variables are reported as errors so typos never pass silently.
//
// Rules for every variable:
// - An empty string means "unset" (.env.example ships lines like `PCS_NOW=`).
// - Problems are collected across ALL variables and thrown together as one
//   ConfigError, one line per variable.
// - Secret values (token, DB key) are never echoed in error messages.

import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { formatInZone, isValidTimeZone, parseIsoLocal, zonedTimeToInstant, type LocalDateTime } from "./tz.js";

// ---------------------------------------------------------------------------
// Rules and thresholds (spec §5c). Weights: PCS_RULE_<NAME>_WEIGHT.
// Thresholds: PCS_THRESH_<NAME>.

export const RULE_WEIGHT_DEFAULTS = {
  MISSING_REVIEWS: 3,
  SPLIT: 3,
  UNRESOLVED_SPLIT: 2,
  SILENT_DISCUSSION: 3,
  GONE_QUIET: 2,
  AC_ABSENT: 2,
  CHAMPION_MISSING: 1,
  LOW_EXPERTISE: 2,
  THIN_REVIEWS: 1,
  RESPONSE_UNADDRESSED: 2,
  DEADLINE_NO_CONSENSUS: 3,
} as const;
export type RuleName = keyof typeof RULE_WEIGHT_DEFAULTS;
export const RULE_NAMES = Object.keys(RULE_WEIGHT_DEFAULTS) as RuleName[];

export const THRESHOLD_DEFAULTS = {
  /** Merit range (max - min) at or above which a paper is split. */
  SPLIT_RANGE: 2,
  /** Days without activity before a paper counts as stale / gone quiet. */
  STALE_DAYS: 4,
  /** Days of discussion with no movement before a split is unresolved. */
  UNRESOLVED_DAYS: 5,
  /** Days before a ping (@mention, AC comment) counts as unanswered. */
  PING_DAYS: 3,
  /** Reviews below this many words are thin. */
  MIN_WORDS: 150,
  /** Days before DECISIONS_DUE when DEADLINE_NO_CONSENSUS can fire. */
  DEADLINE_DAYS: 3,
} as const;
export type ThresholdName = keyof typeof THRESHOLD_DEFAULTS;
export const THRESHOLD_NAMES = Object.keys(THRESHOLD_DEFAULTS) as ThresholdName[];

/** Variables that begin with PCS_ but belong to scripts, not the app. */
const NON_APP_PCS_VARS = new Set(["PCS_ENV_OUT"]);

// ---------------------------------------------------------------------------
// Field parsers. Each takes the raw env string (undefined if unset or empty)
// and produces a typed value or a readable issue.

type Raw = string | undefined;

function show(v: string): string {
  const s = v.length > 60 ? `${v.slice(0, 57)}...` : v;
  return JSON.stringify(s);
}

function fail(ctx: z.RefinementCtx, message: string): typeof z.NEVER {
  ctx.addIssue({ code: "custom", message });
  return z.NEVER;
}

const raw = z.string().optional();

function required<T>(what: string, parse: (v: string, ctx: z.RefinementCtx) => T) {
  return raw.transform((v, ctx): T => (v === undefined ? fail(ctx, `required (${what})`) : parse(v, ctx)));
}

function optional<T>(parse: (v: string, ctx: z.RefinementCtx) => T) {
  return raw.transform((v, ctx): T | undefined => (v === undefined ? undefined : parse(v, ctx)));
}

function withDefault<T>(dflt: T, parse: (v: string, ctx: z.RefinementCtx) => T) {
  return raw.transform((v, ctx): T => (v === undefined ? dflt : parse(v, ctx)));
}

function intIn(min: number, max: number) {
  return (v: string, ctx: z.RefinementCtx): number => {
    const n = /^-?\d+$/.test(v.trim()) ? Number(v) : NaN;
    if (!Number.isSafeInteger(n) || n < min || n > max) {
      return fail(ctx, `expected an integer from ${min} to ${max}, got ${show(v)}`);
    }
    return n;
  };
}

function numberIn(min: number, max: number, { exclusiveMin = false } = {}) {
  return (v: string, ctx: z.RefinementCtx): number => {
    const n = /^-?(\d+\.?\d*|\.\d+)$/.test(v.trim()) ? Number(v) : NaN;
    const lowOk = exclusiveMin ? n > min : n >= min;
    if (!Number.isFinite(n) || !lowOk || n > max) {
      const lo = exclusiveMin ? `greater than ${min}` : `at least ${min}`;
      return fail(ctx, `expected a number ${lo} and at most ${max}, got ${show(v)}`);
    }
    return n;
  };
}

function bool(v: string, ctx: z.RefinementCtx): boolean {
  const s = v.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(s)) return true;
  if (["0", "false", "no", "off"].includes(s)) return false;
  return fail(ctx, `expected true or false, got ${show(v)}`);
}

function secret(v: string, ctx: z.RefinementCtx): string {
  if (v.trim() !== v || /\s/.test(v)) {
    return fail(ctx, "must not contain whitespace (value not shown)");
  }
  return v;
}

function hotcrpUrl(v: string, ctx: z.RefinementCtx): string {
  let u: URL;
  try {
    u = new URL(v.trim());
  } catch {
    return fail(ctx, `expected an absolute http(s) URL like https://conf.hotcrp.com, got ${show(v)}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return fail(ctx, `expected an http(s) URL, got ${show(v)}`);
  }
  if (u.search || u.hash || u.username || u.password) {
    return fail(ctx, `must not include credentials, a query, or a fragment, got ${show(v)}`);
  }
  const path = u.pathname.replace(/\/+$/, "");
  if (/\/api$/.test(path)) {
    return fail(ctx, `give the conference base URL without /api, got ${show(v)}`);
  }
  return `${u.origin}${path}`;
}

function timeZone(v: string, ctx: z.RefinementCtx): string {
  if (!isValidTimeZone(v.trim())) {
    return fail(ctx, `unknown time zone ${show(v)} (use an IANA name like America/New_York)`);
  }
  return v.trim();
}

function localDateTime(v: string, ctx: z.RefinementCtx): LocalDateTime {
  const t = parseIsoLocal(v);
  if (!t) {
    return fail(ctx, `expected an ISO date-time like 2027-01-15T23:59 (local to PCS_TZ), got ${show(v)}`);
  }
  return t;
}

export type AcRole =
  | { kind: "meta" }
  | { kind: "lead" }
  | { kind: "manager" }
  | { kind: "tag"; tag: string };

const TAG_RE = /^[A-Za-z0-9_.:-]+$/;
const TAG_RE_HUMAN = "letters, digits, and _ . : -";

function acRole(v: string, ctx: z.RefinementCtx): AcRole {
  const s = v.trim();
  if (s === "meta" || s === "lead" || s === "manager") return { kind: s };
  if (s.startsWith("tag:") && TAG_RE.test(s.slice(4))) return { kind: "tag", tag: s.slice(4) };
  return fail(ctx, `expected meta, lead, manager, or tag:<tag>, got ${show(v)}`);
}

/** Tier name -> HotCRP user tag. Untagged reviewers are "senior". */
export type TierTags = Readonly<Record<string, string>>;

function tierTags(v: string, ctx: z.RefinementCtx): TierTags {
  const out: Record<string, string> = {};
  for (const part of v.split(",").map((p) => p.trim()).filter((p) => p !== "")) {
    const m = /^([a-z][a-z0-9_-]*)=(.+)$/.exec(part);
    if (!m || !TAG_RE.test(m[2]!)) {
      return fail(ctx, `expected tier=tag pairs like junior=junior,reciprocal=reciprocal (tags: ${TAG_RE_HUMAN}), got ${show(v)}`);
    }
    const [, tier, tag] = m as unknown as [string, string, string];
    if (tier === "senior") {
      return fail(ctx, `"senior" is the implicit tier for untagged reviewers; don't map it, got ${show(v)}`);
    }
    if (tier in out) return fail(ctx, `tier "${tier}" listed twice in ${show(v)}`);
    out[tier] = tag;
  }
  return out;
}

function fieldUid(v: string, ctx: z.RefinementCtx): string {
  const s = v.trim();
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(s)) {
    return fail(ctx, `expected a review-form field UID like OveMer (see pcs probe), got ${show(v)}`);
  }
  return s;
}

// Assignment validator policy (spec §10.4 C, PLAN M10).

/** How many third-slot (junior or reserve) reviews a paper needs. */
export type ThirdSlotPolicy = "exactly1" | "atleast1";

function thirdSlot(v: string, ctx: z.RefinementCtx): ThirdSlotPolicy {
  const s = v.trim().toLowerCase();
  if (s === "exactly1" || s === "atleast1") return s;
  return fail(ctx, `expected exactly1 or atleast1, got ${show(v)}`);
}

/** The four tiers of spec §10.2 that have load bands, with their env-name stems. */
export const LOAD_TIERS = [
  ["senior", "SENIOR"],
  ["junior", "JUNIOR"],
  ["reserve-active", "RESERVE_ACTIVE"],
  ["reserve-pool", "RESERVE_POOL"],
] as const;
export type LoadTier = (typeof LOAD_TIERS)[number][0];

/** Default review-load bands per tier (review assignments per person, inclusive). */
export const LOAD_DEFAULTS: Readonly<Record<LoadTier, { min: number; max: number }>> = {
  senior: { min: 4, max: 12 },
  junior: { min: 2, max: 8 },
  "reserve-active": { min: 1, max: 3 },
  // Designated but not activated: any review assignment is a problem.
  "reserve-pool": { min: 0, max: 0 },
};

const LOAD_FIELDS = Object.fromEntries(
  LOAD_TIERS.flatMap(([tier, stem]) => [
    [`PCS_LOAD_${stem}_MIN`, withDefault<number>(LOAD_DEFAULTS[tier].min, intIn(0, 100_000))],
    [`PCS_LOAD_${stem}_MAX`, withDefault<number>(LOAD_DEFAULTS[tier].max, intIn(0, 100_000))],
  ]),
) as unknown as {
  [S in (typeof LOAD_TIERS)[number][1] as `PCS_LOAD_${S}_MIN` | `PCS_LOAD_${S}_MAX`]: ReturnType<typeof withDefault<number>>;
};

// Reserve compliance and quick-reject tracker (spec §10.4 A/B, PLAN M11).

/** A comma-separated list of non-empty names (trimmed; duplicates dropped, case-insensitively). */
function nameList(what: string) {
  return (v: string, ctx: z.RefinementCtx): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const part of v.split(",").map((p) => p.trim())) {
      if (part === "") continue;
      if (part.length > 200) return fail(ctx, `${what} names must be at most 200 characters, got ${show(part)}`);
      if (seen.has(part.toLowerCase())) continue;
      seen.add(part.toLowerCase());
      out.push(part);
    }
    if (out.length === 0) return fail(ctx, `expected a comma-separated list of ${what} names, got ${show(v)}`);
    return out;
  };
}

/** A HotCRP submission-option name (free text, as configured in HotCRP). */
function optionName(v: string, ctx: z.RefinementCtx): string {
  const s = v.trim();
  // eslint-disable-next-line no-control-regex
  if (s.length > 200 || /[\u0000-\u001f]/.test(s)) return fail(ctx, `expected a submission-option name, got ${show(v)}`);
  return s;
}

/** A HotCRP paper tag (no leading #, no value). */
function paperTag(v: string, ctx: z.RefinementCtx): string {
  const s = v.trim().replace(/^#/, "");
  if (!TAG_RE.test(s)) return fail(ctx, `expected a tag (${TAG_RE_HUMAN}), got ${show(v)}`);
  return s;
}

/** A review round name (HotCRP: letters, digits, _ and -). */
function roundName(v: string, ctx: z.RefinementCtx): string {
  const s = v.trim();
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(s)) return fail(ctx, `expected a review round name like quickreject, got ${show(v)}`);
  return s;
}

function httpsBase(v: string, ctx: z.RefinementCtx): string {
  let u: URL;
  try {
    u = new URL(v.trim());
  } catch {
    return fail(ctx, `expected an absolute https URL, got ${show(v)}`);
  }
  if (u.protocol !== "https:" || u.search || u.hash || u.username || u.password) {
    return fail(ctx, `expected an https URL without credentials, query, or fragment, got ${show(v)}`);
  }
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
}

/** The quick-reject tag vocabulary (PCS_QR_TAGS): state -> paper tag. */
export const QR_TAG_KEYS = [
  "ac-reject",
  "ac-keep",
  "chair-desk-reject",
  "chair-keep",
  "appeal",
  "appeal-upheld",
  "appeal-overturned",
] as const;
export type QrTagKey = (typeof QR_TAG_KEYS)[number];
export type QrTags = Readonly<Record<QrTagKey, string>>;
export const QR_TAG_DEFAULTS: QrTags = {
  "ac-reject": "qr-ac-reject",
  "ac-keep": "qr-ac-keep",
  "chair-desk-reject": "qr-chair-desk-reject",
  "chair-keep": "qr-chair-keep",
  appeal: "qr-appeal",
  "appeal-upheld": "qr-appeal-upheld",
  "appeal-overturned": "qr-appeal-overturned",
};

/** Overrides of QR_TAG_DEFAULTS, as key=tag pairs; unnamed keys keep their default. */
function qrTags(v: string, ctx: z.RefinementCtx): QrTags {
  const out: Record<string, string> = { ...QR_TAG_DEFAULTS };
  const given = new Set<string>();
  for (const part of v.split(",").map((p) => p.trim()).filter((p) => p !== "")) {
    const m = /^([a-z-]+)=#?(.+)$/.exec(part);
    if (!m || !(QR_TAG_KEYS as readonly string[]).includes(m[1]!) || !TAG_RE.test(m[2]!)) {
      return fail(ctx, `expected key=tag pairs with keys ${QR_TAG_KEYS.join(", ")} (tags: ${TAG_RE_HUMAN}), got ${show(v)}`);
    }
    if (given.has(m[1]!)) return fail(ctx, `"${m[1]}" listed twice in ${show(v)}`);
    given.add(m[1]!);
    out[m[1]!] = m[2]!;
  }
  const tags = Object.values(out).map((t) => t.toLowerCase());
  if (new Set(tags).size !== tags.length) return fail(ctx, `every quick-reject state needs its own tag, got ${show(v)}`);
  return out as QrTags;
}

/** Default reserve-exemption reasons: the values M10's seeder gives the dropdown. */
export const RESERVE_EXEMPTION_DEFAULTS: readonly string[] = ["no-eligible-author", "all-authors-on-pc", "other"];
/** Default venue list for the optional DBLP hint (spec §10.4 A). */
export const DBLP_VENUE_DEFAULTS: readonly string[] = ["ICSE", "ESEC/SIGSOFT FSE", "SIGSOFT FSE", "Proc. ACM Softw. Eng.", "ASE", "ISSTA"];

function path(v: string): string {
  const s = v.trim();
  return s === "~" ? homedir() : s.startsWith("~/") ? join(homedir(), s.slice(2)) : s;
}

const nonNeg = numberIn(0, 1_000_000);
const numField = (dflt: number) => withDefault<number>(dflt, nonNeg);
type NumField = ReturnType<typeof numField>;

// ---------------------------------------------------------------------------
// The variable table. Order here is the order problems are reported in.

const RULE_FIELDS = Object.fromEntries(
  RULE_NAMES.map((n) => [`PCS_RULE_${n}_WEIGHT`, numField(RULE_WEIGHT_DEFAULTS[n])]),
) as unknown as { [N in RuleName as `PCS_RULE_${N}_WEIGHT`]: NumField };

const THRESHOLD_FIELDS = Object.fromEntries(
  THRESHOLD_NAMES.map((n) => [`PCS_THRESH_${n}`, numField(THRESHOLD_DEFAULTS[n])]),
) as unknown as { [N in ThresholdName as `PCS_THRESH_${N}`]: NumField };

export const FIELDS = {
  PCS_HOTCRP_URL: required("conference base URL, e.g. https://conf.hotcrp.com", hotcrpUrl),
  PCS_HOTCRP_TOKEN: required("chair API token: HotCRP > Account settings > Developer", secret),
  PCS_FORCE_SHOW: withDefault(true, bool),
  PCS_TZ: withDefault("America/New_York", timeZone),
  // Extended phase model (spec §10.1, PLAN M9). All optional; the MVP runs without them.
  PCS_PHASE_REGISTRATION_DUE: optional(localDateTime),
  PCS_PHASE_SUBMISSION_DUE: optional(localDateTime),
  PCS_PHASE_QUICKREJECT_DUE: optional(localDateTime),
  PCS_PHASE_ASSIGNMENT_DONE: optional(localDateTime),
  PCS_PHASE_REVIEW_DUE: required("review deadline, ISO date-time", localDateTime),
  PCS_PHASE_EARLYREJECT_OPEN: optional(localDateTime),
  PCS_PHASE_EARLYREJECT_CLOSE: optional(localDateTime),
  PCS_PHASE_RESPONSE_OPEN: optional(localDateTime),
  PCS_PHASE_RESPONSE_CLOSE: optional(localDateTime),
  PCS_PHASE_DISCUSSION_OPEN: required("discussion opens, ISO date-time", localDateTime),
  PCS_PHASE_DISCUSSION_CLOSE: required("discussion closes, ISO date-time", localDateTime),
  PCS_PHASE_DECISIONS_DUE: required("decisions due, ISO date-time", localDateTime),
  PCS_NOW: optional(localDateTime),
  PCS_AC_ROLE: withDefault<AcRole>({ kind: "meta" }, acRole),
  PCS_TIER_TAGS: withDefault<TierTags>({}, tierTags),
  PCS_FIELD_MERIT: withDefault("OveMer", fieldUid),
  PCS_FIELD_EXPERTISE: withDefault("RevExp", fieldUid),
  PCS_MERIT_ACCEPT_MIN: withDefault(3, intIn(-1000, 1000)),
  PCS_EXPERTISE_OK_MIN: withDefault(3, intIn(-1000, 1000)),
  PCS_REVIEWS_REQUIRED: withDefault(3, intIn(0, 100)),
  ...THRESHOLD_FIELDS,
  ...RULE_FIELDS,
  // Assignment validator (spec §10.4 C, PLAN M10).
  PCS_POLICY_MIN_SENIOR: withDefault(2, intIn(0, 20)),
  PCS_POLICY_THIRD_SLOT: withDefault<ThirdSlotPolicy>("exactly1", thirdSlot),
  ...LOAD_FIELDS,
  PCS_CYCLE_MAX_K: withDefault(3, intIn(2, 6)),
  PCS_CYCLE_MAX_REPORT: withDefault(500, intIn(1, 100_000)),
  PCS_CONFLICT_AFFILIATION: withDefault(true, bool),
  PCS_CONFLICT_DBLP: withDefault(false, bool),
  // Reserve compliance (spec §10.4 A, PLAN M11).
  PCS_RESERVE_DESIGNEE_FIELD: withDefault("Reserve designee", optionName),
  PCS_RESERVE_EXEMPTION_FIELD: withDefault("Reserve exemption", optionName),
  PCS_RESERVE_SENIORITY_FIELD: withDefault("Reserve seniority", optionName),
  PCS_RESERVE_EXEMPTIONS: withDefault<string[]>([...RESERVE_EXEMPTION_DEFAULTS], nameList("exemption")),
  PCS_RESERVE_EXEMPTION_ALL_PC: withDefault("all-authors-on-pc", optionName),
  PCS_RESERVE_MAX_COVER: withDefault(3, intIn(1, 10_000)),
  PCS_RESERVE_TPMS_MIN_PAPERS: withDefault(1, intIn(0, 10_000)),
  PCS_DBLP_ENABLED: withDefault(false, bool),
  PCS_DBLP_URL: withDefault("https://dblp.org", httpsBase),
  PCS_DBLP_VENUES: withDefault<string[]>([...DBLP_VENUE_DEFAULTS], nameList("venue")),
  PCS_DBLP_SENIOR_MIN: withDefault(5, intIn(1, 10_000)),
  PCS_DBLP_RPS: withDefault(1, numberIn(0, 10, { exclusiveMin: true })),
  // Quick-reject tracker (spec §10.4 B, PLAN M11).
  PCS_QR_ROUND: withDefault("quickreject", roundName),
  PCS_QR_FIELD: optional(fieldUid),
  PCS_QR_REJECT_MAX: withDefault(1, intIn(-1000, 1000)),
  PCS_QR_AC_FLAG_TAG: withDefault("qr-flag", paperTag),
  PCS_QR_TAGS: withDefault<QrTags>(QR_TAG_DEFAULTS, qrTags),
  PCS_QR_REJECT_DECISIONS: withDefault<string[]>(["Rejected"], nameList("decision")),
  PCS_QR_EXCLUDE_FROM_SLOTS: withDefault(true, bool),
  PCS_REFCHECK_HALLUCINATED_MIN: withDefault(1, intIn(1, 100_000)),
  PCS_REFCHECK_IN_FIELD_MIN: withDefault(1, intIn(0, 100_000)),
  PCS_DB_PATH: optional(path),
  PCS_DB_KEY: optional(secret),
  PCS_SYNC_INTERVAL_MIN: withDefault(15, intIn(1, 24 * 60)),
  PCS_SYNC_CHUNK: withDefault(200, intIn(1, 10_000)),
  PCS_SYNC_CONCURRENCY: withDefault(2, intIn(1, 16)),
  PCS_HISTORY_RPS: withDefault(1, numberIn(0, 50, { exclusiveMin: true })),
  PCS_PORT: withDefault(5317, intIn(1, 65_535)),
} satisfies Record<string, z.ZodType<unknown, Raw>>;

export type FieldName = keyof typeof FIELDS;
export const FIELD_NAMES = Object.keys(FIELDS) as FieldName[];
type FieldValues = { [K in FieldName]: z.output<(typeof FIELDS)[K]> };

// ---------------------------------------------------------------------------
// Errors

export interface ConfigProblem {
  name: string;
  message: string;
}

export class ConfigError extends Error {
  readonly problems: readonly ConfigProblem[];
  constructor(problems: readonly ConfigProblem[]) {
    const n = problems.length;
    const lines = problems.map((p) => `  ${p.name}: ${p.message}`);
    super(
      `Invalid configuration (${n} problem${n === 1 ? "" : "s"}):\n${lines.join("\n")}\n` +
        "Every setting is an environment variable; see .env.example.",
    );
    this.name = "ConfigError";
    this.problems = problems;
  }
}

type Env = Readonly<Record<string, string | undefined>>;

function cleaned(env: Env, name: string): Raw {
  const v = env[name];
  return v === undefined || v.trim() === "" ? undefined : v;
}

function parseFields<K extends FieldName>(env: Env, names: readonly K[]) {
  const values: Partial<Pick<FieldValues, K>> = {};
  const problems: ConfigProblem[] = [];
  for (const name of names) {
    const r = (FIELDS[name] as z.ZodType<unknown, Raw>).safeParse(cleaned(env, name));
    if (r.success) {
      (values as Record<string, unknown>)[name] = r.data;
    } else {
      for (const issue of r.error.issues) problems.push({ name, message: issue.message });
    }
  }
  return { values, problems };
}

function unknownVars(env: Env): ConfigProblem[] {
  const known = new Set<string>(FIELD_NAMES);
  return Object.keys(env)
    .filter((k) => k.startsWith("PCS_") && !known.has(k) && !NON_APP_PCS_VARS.has(k))
    .sort()
    .map((name) => ({ name, message: "unknown setting (typo?); see .env.example for the full list" }));
}

/** The test-mode rule for PCS_DB_KEY: NODE_ENV=test (Vitest sets this). */
export function isTestMode(env: Env): boolean {
  return env.NODE_ENV === "test";
}

// ---------------------------------------------------------------------------
// Typed config

export interface HotcrpConfig {
  /** Base URL, normalized: no trailing slash, no /api. */
  url: string;
  token: string;
  forceShow: boolean;
  sync: { chunk: number; concurrency: number; historyRps: number };
}

export interface Phases {
  reviewDue: Date;
  responseOpen: Date | undefined;
  responseClose: Date | undefined;
  discussionOpen: Date;
  discussionClose: Date;
  decisionsDue: Date;
  // Extended phase model (spec §10.1). Optional, so code that builds a
  // Phases literal for the MVP keeps compiling; unset = undefined.
  registrationDue?: Date | undefined;
  submissionDue?: Date | undefined;
  quickRejectDue?: Date | undefined;
  assignmentDone?: Date | undefined;
  earlyRejectOpen?: Date | undefined;
  earlyRejectClose?: Date | undefined;
}

/** Extended (spec §10.1) phase keys of Phases, in deadline order, with their env names. */
export const EXTENDED_PHASE_FIELDS = [
  ["registrationDue", "PCS_PHASE_REGISTRATION_DUE"],
  ["submissionDue", "PCS_PHASE_SUBMISSION_DUE"],
  ["quickRejectDue", "PCS_PHASE_QUICKREJECT_DUE"],
  ["assignmentDone", "PCS_PHASE_ASSIGNMENT_DONE"],
  ["earlyRejectOpen", "PCS_PHASE_EARLYREJECT_OPEN"],
  ["earlyRejectClose", "PCS_PHASE_EARLYREJECT_CLOSE"],
] as const;

/**
 * Ordering problems for the extended phase dates (spec §10.1 order):
 *   REGISTRATION_DUE <= SUBMISSION_DUE <= QUICKREJECT_DUE <= ASSIGNMENT_DONE
 *   <= REVIEW_DUE <= EARLYREJECT_OPEN <= EARLYREJECT_CLOSE
 *   <= RESPONSE_OPEN (if set) and <= DISCUSSION_OPEN.
 * Unset dates are skipped (each is compared with the nearest set neighbor).
 * Only pairs involving at least one extended date are checked here, so MVP
 * validation is unchanged. EARLYREJECT_OPEN/_CLOSE: set both or neither.
 */
export function extendedPhaseProblems(
  phases: Partial<Record<keyof Phases, Date | undefined>>,
  isSet: (name: FieldName) => boolean,
): ConfigProblem[] {
  const problems: ConfigProblem[] = [];
  const chain: [keyof Phases, FieldName, boolean][] = [
    ["registrationDue", "PCS_PHASE_REGISTRATION_DUE", true],
    ["submissionDue", "PCS_PHASE_SUBMISSION_DUE", true],
    ["quickRejectDue", "PCS_PHASE_QUICKREJECT_DUE", true],
    ["assignmentDone", "PCS_PHASE_ASSIGNMENT_DONE", true],
    ["reviewDue", "PCS_PHASE_REVIEW_DUE", false],
    ["earlyRejectOpen", "PCS_PHASE_EARLYREJECT_OPEN", true],
    ["earlyRejectClose", "PCS_PHASE_EARLYREJECT_CLOSE", true],
    ["responseOpen", "PCS_PHASE_RESPONSE_OPEN", false],
    ["discussionOpen", "PCS_PHASE_DISCUSSION_OPEN", false],
  ];
  const present = chain.filter(([k]) => phases[k] !== undefined);
  for (let i = 1; i < present.length; i++) {
    const [prevKey, prevName, prevExt] = present[i - 1]!;
    const [key, name, ext] = present[i]!;
    if (!prevExt && !ext) continue;
    if (phases[key]! < phases[prevKey]!) {
      // Blame the extended date (the MVP ones are checked elsewhere).
      problems.push(
        ext ? { name, message: `must not be earlier than ${prevName}` } : { name: prevName, message: `must not be later than ${name}` },
      );
    }
  }
  // With a response window set, the chain above skips EARLYREJECT_CLOSE vs
  // DISCUSSION_OPEN; check it directly so the windows can never overlap.
  const erClose = phases.earlyRejectClose ?? phases.earlyRejectOpen;
  if (erClose && phases.responseOpen && phases.discussionOpen && phases.discussionOpen < erClose) {
    const n = phases.earlyRejectClose ? "PCS_PHASE_EARLYREJECT_CLOSE" : "PCS_PHASE_EARLYREJECT_OPEN";
    problems.push({ name: n, message: "must not be later than PCS_PHASE_DISCUSSION_OPEN" });
  }
  const hasOpen = isSet("PCS_PHASE_EARLYREJECT_OPEN");
  const hasClose = isSet("PCS_PHASE_EARLYREJECT_CLOSE");
  if (hasOpen !== hasClose) {
    problems.push({
      name: hasOpen ? "PCS_PHASE_EARLYREJECT_CLOSE" : "PCS_PHASE_EARLYREJECT_OPEN",
      message: "set both PCS_PHASE_EARLYREJECT_OPEN and PCS_PHASE_EARLYREJECT_CLOSE, or neither",
    });
  }
  return problems;
}

/** PCS_POLICY_*, PCS_LOAD_*, PCS_CYCLE_*, PCS_CONFLICT_* (spec §10.4 C). */
export interface AssignmentPolicy {
  /** PCS_POLICY_MIN_SENIOR: senior reviews every paper needs. */
  minSenior: number;
  /** PCS_POLICY_THIRD_SLOT: junior/reserve reviews per paper. */
  thirdSlot: ThirdSlotPolicy;
  /** PCS_LOAD_<TIER>_MIN/_MAX: review assignments per person, inclusive. */
  load: Readonly<Record<LoadTier, { min: number; max: number }>>;
  /** PCS_CYCLE_MAX_K: longest reciprocal cycle searched for (2 = pairs only). */
  cycleMaxK: number;
  /** PCS_CYCLE_MAX_REPORT: stop listing cycles after this many. */
  cycleMaxReport: number;
  /** PCS_CONFLICT_AFFILIATION: flag reviewer/author pairs with the same affiliation. */
  affiliationConflicts: boolean;
  /** PCS_CONFLICT_DBLP: DBLP co-authorship check (optional; no provider ships in M10). */
  dblpConflicts: boolean;
}

/** The default policy (every PCS_POLICY_/LOAD_/CYCLE_/CONFLICT_ variable unset). */
export const DEFAULT_ASSIGNMENT_POLICY: AssignmentPolicy = {
  minSenior: 2,
  thirdSlot: "exactly1",
  load: LOAD_DEFAULTS,
  cycleMaxK: 3,
  cycleMaxReport: 500,
  affiliationConflicts: true,
  dblpConflicts: false,
};

/** PCS_RESERVE_* and PCS_DBLP_* (spec §10.4 A). */
export interface ReservePolicy {
  /** Submission-option names in HotCRP. */
  designeeField: string;
  exemptionField: string;
  seniorityField: string;
  /** PCS_RESERVE_EXEMPTIONS: the exemption reasons that count. */
  exemptions: readonly string[];
  /** PCS_RESERVE_EXEMPTION_ALL_PC: the reason whose claim is "every author is on the PC" (checked). */
  exemptionAllPc: string;
  maxCover: number;
  tpmsMinPapers: number;
  dblp: { enabled: boolean; url: string; venues: readonly string[]; seniorMin: number; rps: number };
}

export const DEFAULT_RESERVE_POLICY: ReservePolicy = {
  designeeField: "Reserve designee",
  exemptionField: "Reserve exemption",
  seniorityField: "Reserve seniority",
  exemptions: RESERVE_EXEMPTION_DEFAULTS,
  exemptionAllPc: "all-authors-on-pc",
  maxCover: 3,
  tpmsMinPapers: 1,
  dblp: { enabled: false, url: "https://dblp.org", venues: DBLP_VENUE_DEFAULTS, seniorMin: 5, rps: 1 },
};

/** PCS_QR_* and PCS_REFCHECK_* (spec §10.4 B). */
export interface QuickRejectPolicy {
  round: string;
  /** Review-form field holding the verdict (PCS_QR_FIELD, else PCS_FIELD_MERIT). */
  field: string;
  /** A quick-reject review votes "reject" when its field value is at most this. */
  rejectMax: number;
  acFlagTag: string;
  tags: QrTags;
  rejectDecisions: readonly string[];
  /** Leave quick-reject-round reviews out of the review slots (MISSING_REVIEWS, composition, load). */
  excludeFromSlots: boolean;
  refcheck: { hallucinatedMin: number; inFieldMin: number };
}

export const DEFAULT_QUICKREJECT_POLICY: QuickRejectPolicy = {
  round: "quickreject",
  field: "OveMer",
  rejectMax: 1,
  acFlagTag: "qr-flag",
  tags: QR_TAG_DEFAULTS,
  rejectDecisions: ["Rejected"],
  excludeFromSlots: true,
  refcheck: { hallucinatedMin: 1, inFieldMin: 1 },
};

/** Review rounds left out of the review slots (empty unless PCS_QR_EXCLUDE_FROM_SLOTS). */
export function excludedRounds(c: { quickReject?: QuickRejectPolicy | undefined }): string[] {
  const q = c.quickReject;
  return q && q.excludeFromSlots ? [q.round] : [];
}

export interface Config {
  hotcrp: HotcrpConfig;
  tz: string;
  phases: Phases;
  /** PCS_NOW: a pinned clock instant. Read it via clock.ts, not directly. */
  now: Date | undefined;
  acRole: AcRole;
  tierTags: TierTags;
  fields: { merit: string; expertise: string };
  meritAcceptMin: number;
  expertiseOkMin: number;
  reviewsRequired: number;
  rules: {
    weights: Readonly<Record<RuleName, number>>;
    thresholds: Readonly<Record<ThresholdName, number>>;
  };
  /**
   * Assignment validator policy (spec §10.4 C). Optional in the type so code
   * that builds a Config literal keeps compiling; loadConfig always sets it.
   */
  assignment?: AssignmentPolicy;
  /** Reserve compliance (spec §10.4 A); optional like `assignment`, always set by loadConfig. */
  reserve?: ReservePolicy;
  /** Quick-reject tracker (spec §10.4 B); optional like `assignment`, always set by loadConfig. */
  quickReject?: QuickRejectPolicy;
  db: { path: string; key: string | undefined };
  sync: { intervalMin: number; chunk: number; concurrency: number; historyRps: number };
  port: number;
}

const HOTCRP_FIELDS = [
  "PCS_HOTCRP_URL",
  "PCS_HOTCRP_TOKEN",
  "PCS_FORCE_SHOW",
  "PCS_SYNC_CHUNK",
  "PCS_SYNC_CONCURRENCY",
  "PCS_HISTORY_RPS",
] as const satisfies readonly FieldName[];

/** Default DB file: ~/.local/share/pc-supervisor/<host>.db (outside the repo). */
export function defaultDbPath(hotcrpUrl: string, home: string = homedir()): string {
  const host = new URL(hotcrpUrl).host.replace(/[^A-Za-z0-9.-]/g, "_");
  return join(home, ".local", "share", "pc-supervisor", `${host}.db`);
}

function buildHotcrp(v: Pick<FieldValues, (typeof HOTCRP_FIELDS)[number]>): HotcrpConfig {
  return {
    url: v.PCS_HOTCRP_URL,
    token: v.PCS_HOTCRP_TOKEN,
    forceShow: v.PCS_FORCE_SHOW,
    sync: { chunk: v.PCS_SYNC_CHUNK, concurrency: v.PCS_SYNC_CONCURRENCY, historyRps: v.PCS_HISTORY_RPS },
  };
}

/**
 * Only the settings needed to talk to HotCRP (URL, token, force-show, sync
 * tuning). For commands like `pcs probe` that don't need phase dates or a DB.
 */
export function loadHotcrpConfig(env: Env = process.env): HotcrpConfig {
  const { values, problems } = parseFields(env, HOTCRP_FIELDS);
  problems.push(...unknownVars(env));
  if (problems.length > 0) throw new ConfigError(problems);
  return buildHotcrp(values as Pick<FieldValues, (typeof HOTCRP_FIELDS)[number]>);
}

/** Only PCS_NOW and PCS_TZ, for clock.ts. */
export function loadClockConfig(env: Env = process.env): { now: Date | undefined; tz: string } {
  const { values, problems } = parseFields(env, ["PCS_NOW", "PCS_TZ"] as const);
  if (problems.length > 0) throw new ConfigError(problems);
  const tz = values.PCS_TZ!;
  return { tz, now: values.PCS_NOW ? zonedTimeToInstant(values.PCS_NOW, tz) : undefined };
}

const PHASE_FIELDS = [
  "PCS_TZ",
  "PCS_PHASE_REVIEW_DUE",
  "PCS_PHASE_RESPONSE_OPEN",
  "PCS_PHASE_RESPONSE_CLOSE",
  "PCS_PHASE_DISCUSSION_OPEN",
  "PCS_PHASE_DISCUSSION_CLOSE",
  "PCS_PHASE_DECISIONS_DUE",
  "PCS_PHASE_REGISTRATION_DUE",
  "PCS_PHASE_SUBMISSION_DUE",
  "PCS_PHASE_QUICKREJECT_DUE",
  "PCS_PHASE_ASSIGNMENT_DONE",
  "PCS_PHASE_EARLYREJECT_OPEN",
  "PCS_PHASE_EARLYREJECT_CLOSE",
] as const satisfies readonly FieldName[];

/**
 * Only PCS_TZ and the PCS_PHASE_* dates, for tools (the seeder) that place
 * events relative to phase dates but don't need a DB or token. Same parsing
 * as loadConfig; the cross-field ordering checks are loadConfig's job.
 */
export function loadPhaseConfig(env: Env = process.env): { tz: string; phases: Phases } {
  const { values: v, problems } = parseFields(env, PHASE_FIELDS);
  if (problems.length > 0) throw new ConfigError(problems);
  const tz = v.PCS_TZ!;
  const at = (t: LocalDateTime | undefined): Date | undefined => (t ? zonedTimeToInstant(t, tz) : undefined);
  return {
    tz,
    phases: {
      reviewDue: at(v.PCS_PHASE_REVIEW_DUE)!,
      responseOpen: at(v.PCS_PHASE_RESPONSE_OPEN),
      responseClose: at(v.PCS_PHASE_RESPONSE_CLOSE),
      discussionOpen: at(v.PCS_PHASE_DISCUSSION_OPEN)!,
      discussionClose: at(v.PCS_PHASE_DISCUSSION_CLOSE)!,
      decisionsDue: at(v.PCS_PHASE_DECISIONS_DUE)!,
      registrationDue: at(v.PCS_PHASE_REGISTRATION_DUE),
      submissionDue: at(v.PCS_PHASE_SUBMISSION_DUE),
      quickRejectDue: at(v.PCS_PHASE_QUICKREJECT_DUE),
      assignmentDone: at(v.PCS_PHASE_ASSIGNMENT_DONE),
      earlyRejectOpen: at(v.PCS_PHASE_EARLYREJECT_OPEN),
      earlyRejectClose: at(v.PCS_PHASE_EARLYREJECT_CLOSE),
    },
  };
}

export interface LoadOptions {
  /** Home directory for the default DB path (tests). */
  home?: string;
}

/** Validate every PCS_* variable. Throws one ConfigError listing all problems. */
export function loadConfig(env: Env = process.env, opts: LoadOptions = {}): Config {
  const { values: v, problems } = parseFields(env, FIELD_NAMES);
  problems.push(...unknownVars(env));

  const tz = v.PCS_TZ;
  const at = (t: LocalDateTime | undefined): Date | undefined =>
    t && tz !== undefined ? zonedTimeToInstant(t, tz) : undefined;

  const phases = {
    reviewDue: at(v.PCS_PHASE_REVIEW_DUE),
    responseOpen: at(v.PCS_PHASE_RESPONSE_OPEN),
    responseClose: at(v.PCS_PHASE_RESPONSE_CLOSE),
    discussionOpen: at(v.PCS_PHASE_DISCUSSION_OPEN),
    discussionClose: at(v.PCS_PHASE_DISCUSSION_CLOSE),
    decisionsDue: at(v.PCS_PHASE_DECISIONS_DUE),
    registrationDue: at(v.PCS_PHASE_REGISTRATION_DUE),
    submissionDue: at(v.PCS_PHASE_SUBMISSION_DUE),
    quickRejectDue: at(v.PCS_PHASE_QUICKREJECT_DUE),
    assignmentDone: at(v.PCS_PHASE_ASSIGNMENT_DONE),
    earlyRejectOpen: at(v.PCS_PHASE_EARLYREJECT_OPEN),
    earlyRejectClose: at(v.PCS_PHASE_EARLYREJECT_CLOSE),
  };

  // Cross-field checks, on whichever values parsed.
  const order: [keyof typeof phases, FieldName][] = [
    ["reviewDue", "PCS_PHASE_REVIEW_DUE"],
    ["discussionOpen", "PCS_PHASE_DISCUSSION_OPEN"],
    ["discussionClose", "PCS_PHASE_DISCUSSION_CLOSE"],
    ["decisionsDue", "PCS_PHASE_DECISIONS_DUE"],
  ];
  for (let i = 1; i < order.length; i++) {
    const [prevKey, prevName] = order[i - 1]!;
    const [key, name] = order[i]!;
    const prev = phases[prevKey];
    const cur = phases[key];
    if (prev && cur && cur < prev) {
      problems.push({ name, message: `must not be earlier than ${prevName}` });
    }
  }
  const hasOpen = cleaned(env, "PCS_PHASE_RESPONSE_OPEN") !== undefined;
  const hasClose = cleaned(env, "PCS_PHASE_RESPONSE_CLOSE") !== undefined;
  if (hasOpen !== hasClose) {
    problems.push({
      name: hasOpen ? "PCS_PHASE_RESPONSE_CLOSE" : "PCS_PHASE_RESPONSE_OPEN",
      message: "set both PCS_PHASE_RESPONSE_OPEN and PCS_PHASE_RESPONSE_CLOSE, or neither",
    });
  }
  if (phases.responseOpen && phases.responseClose && phases.responseClose < phases.responseOpen) {
    problems.push({ name: "PCS_PHASE_RESPONSE_CLOSE", message: "must not be earlier than PCS_PHASE_RESPONSE_OPEN" });
  }
  problems.push(...extendedPhaseProblems(phases, (n) => cleaned(env, n) !== undefined));
  if (cleaned(env, "PCS_DB_KEY") === undefined && !isTestMode(env)) {
    problems.push({
      name: "PCS_DB_KEY",
      message: "required (SQLCipher key for the local DB; only NODE_ENV=test may omit it)",
    });
  }

  for (const [, stem] of LOAD_TIERS) {
    const lo = v[`PCS_LOAD_${stem}_MIN`];
    const hi = v[`PCS_LOAD_${stem}_MAX`];
    if (lo !== undefined && hi !== undefined && lo > hi) {
      problems.push({ name: `PCS_LOAD_${stem}_MAX`, message: `must not be less than PCS_LOAD_${stem}_MIN (${lo})` });
    }
  }
  if (problems.length > 0) throw new ConfigError(problems);
  const f = v as FieldValues;

  return {
    hotcrp: buildHotcrp(f),
    tz: f.PCS_TZ,
    phases: phases as Phases,
    now: at(f.PCS_NOW),
    acRole: f.PCS_AC_ROLE,
    tierTags: f.PCS_TIER_TAGS,
    fields: { merit: f.PCS_FIELD_MERIT, expertise: f.PCS_FIELD_EXPERTISE },
    meritAcceptMin: f.PCS_MERIT_ACCEPT_MIN,
    expertiseOkMin: f.PCS_EXPERTISE_OK_MIN,
    reviewsRequired: f.PCS_REVIEWS_REQUIRED,
    rules: {
      weights: Object.fromEntries(RULE_NAMES.map((n) => [n, f[`PCS_RULE_${n}_WEIGHT`]])) as Record<RuleName, number>,
      thresholds: Object.fromEntries(THRESHOLD_NAMES.map((n) => [n, f[`PCS_THRESH_${n}`]])) as Record<
        ThresholdName,
        number
      >,
    },
    assignment: {
      minSenior: f.PCS_POLICY_MIN_SENIOR,
      thirdSlot: f.PCS_POLICY_THIRD_SLOT,
      load: Object.fromEntries(
        LOAD_TIERS.map(([tier, stem]) => [tier, { min: f[`PCS_LOAD_${stem}_MIN`], max: f[`PCS_LOAD_${stem}_MAX`] }]),
      ) as Record<LoadTier, { min: number; max: number }>,
      cycleMaxK: f.PCS_CYCLE_MAX_K,
      cycleMaxReport: f.PCS_CYCLE_MAX_REPORT,
      affiliationConflicts: f.PCS_CONFLICT_AFFILIATION,
      dblpConflicts: f.PCS_CONFLICT_DBLP,
    },
    reserve: {
      designeeField: f.PCS_RESERVE_DESIGNEE_FIELD,
      exemptionField: f.PCS_RESERVE_EXEMPTION_FIELD,
      seniorityField: f.PCS_RESERVE_SENIORITY_FIELD,
      exemptions: f.PCS_RESERVE_EXEMPTIONS,
      exemptionAllPc: f.PCS_RESERVE_EXEMPTION_ALL_PC,
      maxCover: f.PCS_RESERVE_MAX_COVER,
      tpmsMinPapers: f.PCS_RESERVE_TPMS_MIN_PAPERS,
      dblp: {
        enabled: f.PCS_DBLP_ENABLED,
        url: f.PCS_DBLP_URL,
        venues: f.PCS_DBLP_VENUES,
        seniorMin: f.PCS_DBLP_SENIOR_MIN,
        rps: f.PCS_DBLP_RPS,
      },
    },
    quickReject: {
      round: f.PCS_QR_ROUND,
      field: f.PCS_QR_FIELD ?? f.PCS_FIELD_MERIT,
      rejectMax: f.PCS_QR_REJECT_MAX,
      acFlagTag: f.PCS_QR_AC_FLAG_TAG,
      tags: f.PCS_QR_TAGS,
      rejectDecisions: f.PCS_QR_REJECT_DECISIONS,
      excludeFromSlots: f.PCS_QR_EXCLUDE_FROM_SLOTS,
      refcheck: { hallucinatedMin: f.PCS_REFCHECK_HALLUCINATED_MIN, inFieldMin: f.PCS_REFCHECK_IN_FIELD_MIN },
    },
    db: { path: f.PCS_DB_PATH ?? defaultDbPath(f.PCS_HOTCRP_URL, opts.home), key: f.PCS_DB_KEY },
    sync: {
      intervalMin: f.PCS_SYNC_INTERVAL_MIN,
      chunk: f.PCS_SYNC_CHUNK,
      concurrency: f.PCS_SYNC_CONCURRENCY,
      historyRps: f.PCS_HISTORY_RPS,
    },
    port: f.PCS_PORT,
  };
}

/**
 * For CLI entry points: run a loader, or print its ConfigError and exit 1.
 *   const cfg = orExit(() => loadConfig());
 */
export function orExit<T>(load: () => T): T {
  try {
    return load();
  } catch (e) {
    if (e instanceof ConfigError) {
      process.stderr.write(`${e.message}\n`);
      process.exit(1);
    }
    throw e;
  }
}

/** Human-readable summary with secrets redacted (for `pcs config-check`). */
export function describeConfig(c: Config): string[] {
  const when = (d: Date | undefined) => (d ? formatInZone(d, c.tz) : "(unset)");
  const acRole = c.acRole.kind === "tag" ? `tag:${c.acRole.tag}` : c.acRole.kind;
  const tiers = Object.entries(c.tierTags).map(([t, g]) => `${t}=${g}`).join(",") || "(none)";
  // Extended phases (spec §10.1) are listed only when any is set, so MVP output is unchanged.
  const p = c.phases;
  const extended = EXTENDED_PHASE_FIELDS.some(([k]) => p[k] !== undefined)
    ? [
        `Registration due  ${when(p.registrationDue)}`,
        `Submission due    ${when(p.submissionDue)}`,
        `Quick-reject due  ${when(p.quickRejectDue)}`,
        `Assignment done   ${when(p.assignmentDone)}`,
        `Early reject      ${when(p.earlyRejectOpen)} .. ${when(p.earlyRejectClose)}`,
      ]
    : [];
  return [
    `HotCRP URL        ${c.hotcrp.url}`,
    `HotCRP token      (set, ${c.hotcrp.token.length} chars; not shown)`,
    `Force show        ${c.hotcrp.forceShow}`,
    `Time zone         ${c.tz}`,
    ...extended,
    `Review due        ${when(c.phases.reviewDue)}`,
    `Response window   ${when(c.phases.responseOpen)} .. ${when(c.phases.responseClose)}`,
    `Discussion        ${when(c.phases.discussionOpen)} .. ${when(c.phases.discussionClose)}`,
    `Decisions due     ${when(c.phases.decisionsDue)}`,
    `Clock             ${c.now ? `pinned at ${when(c.now)}` : "real time"}`,
    `AC role           ${acRole}`,
    `Tier tags         ${tiers}`,
    `Fields            merit=${c.fields.merit} (accept >= ${c.meritAcceptMin}), expertise=${c.fields.expertise} (ok >= ${c.expertiseOkMin})`,
    `Reviews required  ${c.reviewsRequired}`,
    ...(c.assignment
      ? [
          `Assignment        ${c.assignment.minSenior} senior + ${c.assignment.thirdSlot} third slot; loads ` +
            LOAD_TIERS.map(([t]) => `${t} ${c.assignment!.load[t].min}-${c.assignment!.load[t].max}`).join(", ") +
            `; cycles k<=${c.assignment.cycleMaxK}; affiliation ${c.assignment.affiliationConflicts ? "on" : "off"}, dblp ${c.assignment.dblpConflicts ? "on" : "off"}`,
        ]
      : []),
    ...(c.reserve
      ? [
          `Reserve           designee "${c.reserve.designeeField}", exemption "${c.reserve.exemptionField}" (${c.reserve.exemptions.join(", ")}); max cover ${c.reserve.maxCover}; DBLP hint ${c.reserve.dblp.enabled ? `ON (${c.reserve.dblp.url}; venues ${c.reserve.dblp.venues.join(", ")})` : "off"}`,
        ]
      : []),
    ...(c.quickReject
      ? [
          `Quick reject      round ${c.quickReject.round}, verdict ${c.quickReject.field} <= ${c.quickReject.rejectMax}, AC flag #${c.quickReject.acFlagTag}; ${c.quickReject.excludeFromSlots ? "excluded from" : "counted in"} review slots`,
        ]
      : []),
    `Rule weights      ${RULE_NAMES.map((n) => `${n}=${c.rules.weights[n]}`).join(" ")}`,
    `Thresholds        ${THRESHOLD_NAMES.map((n) => `${n}=${c.rules.thresholds[n]}`).join(" ")}`,
    `DB path           ${c.db.path}`,
    `DB key            ${c.db.key ? "(set; not shown)" : "(unset; test mode)"}`,
    `Sync              every ${c.sync.intervalMin} min, chunk ${c.sync.chunk}, concurrency ${c.sync.concurrency}, history ${c.sync.historyRps} rps`,
    `Port              ${c.port} (binds 127.0.0.1)`,
  ];
}
