// Rule settings (spec §5c "Rule settings"): what the paper-risk rules use
// besides the data. Env (PCS_RULE_* / PCS_THRESH_* / the three score knobs)
// supplies the defaults; the chair's in-app overrides overlay them. The
// overrides live in the local store (store/rule-profile.ts), never in HotCRP.
//
// - A setting is named by its env variable (PCS_THRESH_SPLIT_RANGE, ...), and
//   an override is validated by that variable's own FIELDS entry in
//   config.ts, so env and the app accept exactly the same values and bounds.
// - Effective = env defaults, then every override on top (overlay()). An
//   override equal to the env default is still kept: the chair pinned it.
// - A disabled rule's effective weight is 0, which the evaluator already
//   treats as "not evaluated" (evaluate.ts).
//
// Pure: no SQLite, no clock. The store and the service add persistence,
// revisions and the actor.

import {
  FIELDS,
  RULE_NAMES,
  RULE_SETTING_BOUNDS,
  THRESHOLD_NAMES,
  type Config,
  type RuleName,
  type ThresholdName,
} from "../config.js";

export interface RuleSettings {
  enabled: Readonly<Record<RuleName, boolean>>;
  weights: Readonly<Record<RuleName, number>>;
  thresholds: Readonly<Record<ThresholdName, number>>;
  meritAcceptMin: number;
  expertiseOkMin: number;
  reviewsRequired: number;
}

export type SettingValue = number | boolean;

export type ScaleKey = "PCS_MERIT_ACCEPT_MIN" | "PCS_EXPERTISE_OK_MIN" | "PCS_REVIEWS_REQUIRED";
export type SettingKey = `PCS_RULE_${RuleName}_ENABLED` | `PCS_RULE_${RuleName}_WEIGHT` | `PCS_THRESH_${ThresholdName}` | ScaleKey;

/** The chair's overrides: only the keys they set. */
export type Overrides = Partial<Record<SettingKey, SettingValue>>;

export const enabledKey = (r: RuleName) => `PCS_RULE_${r}_ENABLED` as const;
export const weightKey = (r: RuleName) => `PCS_RULE_${r}_WEIGHT` as const;
export const thresholdKey = (t: ThresholdName) => `PCS_THRESH_${t}` as const;

type SettingsSource = Pick<Config, "rules" | "meritAcceptMin" | "expertiseOkMin" | "reviewsRequired">;

/** The env defaults (a loaded Config). */
export function envSettings(cfg: SettingsSource): RuleSettings {
  const all = Object.fromEntries(RULE_NAMES.map((r) => [r, true])) as Record<RuleName, boolean>;
  return {
    enabled: { ...all, ...cfg.rules.enabled },
    weights: { ...cfg.rules.weights },
    thresholds: { ...cfg.rules.thresholds },
    meritAcceptMin: cfg.meritAcceptMin,
    expertiseOkMin: cfg.expertiseOkMin,
    reviewsRequired: cfg.reviewsRequired,
  };
}

// ---------------------------------------------------------------------------
// Metadata: what the Rules page and `pcs rules show` explain.

export type PhaseGate = "any" | "after-review-due" | "discussion" | "deadline-window";

export interface RuleMeta {
  name: RuleName;
  label: string;
  /** One sentence: when it fires. */
  description: string;
  phase: PhaseGate;
  /** Still fires on decided papers. */
  decisionIndependent: boolean;
  /** The settings this rule reads, besides its switch and weight. */
  settings: SettingKey[];
}

export interface SettingMeta {
  key: SettingKey;
  kind: "bool" | "int" | "number";
  label: string;
  description: string;
  /** "days", "words", "raters", "merit points", ... ("" for switches). */
  unit: string;
  min?: number;
  max?: number;
  step?: number;
  /** The rule whose card shows it; null = shared or not a paper rule (see `uses`). */
  rule: RuleName | null;
  /** Every paper rule that reads it. */
  rules: RuleName[];
  /** Other places that read it (metrics, views). */
  alsoUsedBy: string[];
}

export const PHASE_LABEL: Readonly<Record<PhaseGate, string>> = {
  any: "any phase",
  "after-review-due": "after the review deadline",
  discussion: "once discussion has opened",
  "deadline-window": "close to the decision deadline",
};

const T = thresholdKey;

export const RULE_META: readonly RuleMeta[] = [
  {
    name: "MISSING_REVIEWS",
    label: "Missing reviews",
    description: "Fewer submitted reviewer reviews than required after the review deadline.",
    phase: "after-review-due",
    decisionIndependent: false,
    settings: ["PCS_REVIEWS_REQUIRED"],
  },
  {
    name: "SPLIT",
    label: "Split",
    description: "At least 2 merits whose range reaches the split range, or merits on both sides of the accept line.",
    phase: "any",
    decisionIndependent: false,
    settings: [T("SPLIT_RANGE"), "PCS_MERIT_ACCEPT_MIN"],
  },
  {
    name: "UNRESOLVED_SPLIT",
    label: "Unresolved split",
    description: "Split, discussion open longer than the limit, and no reviewer merit change since discussion opened.",
    phase: "discussion",
    decisionIndependent: false,
    settings: [T("UNRESOLVED_DAYS"), T("SPLIT_RANGE"), "PCS_MERIT_ACCEPT_MIN"],
  },
  {
    name: "SILENT_DISCUSSION",
    label: "No comments yet",
    description: "No published comment (by anyone) since discussion opened.",
    phase: "discussion",
    decisionIndependent: false,
    settings: [],
  },
  {
    name: "GONE_QUIET",
    label: "Gone quiet",
    description: "No in-HotCRP activity (reviews or comments, AC ones included) for longer than the limit, measured from discussion opening at the earliest.",
    phase: "discussion",
    decisionIndependent: false,
    settings: [T("STALE_DAYS")],
  },
  {
    name: "AC_ABSENT",
    label: "No AC comment yet",
    description: "None of the paper's area chairs has commented since discussion opened (or the paper has no AC).",
    phase: "discussion",
    decisionIndependent: false,
    settings: [],
  },
  {
    name: "CHAMPION_MISSING",
    label: "No champion comment",
    description: "The top merit is on the accept side, and no reviewer holding it has commented since discussion opened.",
    phase: "discussion",
    decisionIndependent: false,
    settings: ["PCS_MERIT_ACCEPT_MIN"],
  },
  {
    name: "LOW_EXPERTISE",
    label: "Low expertise",
    description: "After the review deadline, no submitted review has knowledgeable expertise.",
    phase: "after-review-due",
    decisionIndependent: false,
    settings: ["PCS_EXPERTISE_OK_MIN"],
  },
  {
    name: "THIN_REVIEWS",
    label: "Thin reviews",
    description: "A submitted review under the word floor, or flagged short (or vague) by enough raters.",
    phase: "any",
    decisionIndependent: false,
    settings: [T("MIN_WORDS"), T("RATING_RATERS")],
  },
  {
    name: "RESPONSE_UNADDRESSED",
    label: "Response not discussed",
    description: "An author response exists and no reviewer has commented after the latest one.",
    phase: "discussion",
    decisionIndependent: false,
    settings: [],
  },
  {
    name: "REVIEW_FLAGGED",
    label: "Flagged review",
    description: "A review on the paper is rated disrespectful or wrong. Fires on decided papers too.",
    phase: "any",
    decisionIndependent: true,
    settings: [],
  },
  {
    name: "DEADLINE_NO_CONSENSUS",
    label: "Deadline, no consensus",
    description: "Inside the window before decisions are due (or overdue), undecided, and split or without comments.",
    phase: "deadline-window",
    decisionIndependent: false,
    settings: [T("DEADLINE_DAYS"), T("SPLIT_RANGE"), "PCS_MERIT_ACCEPT_MIN"],
  },
];

const NUM = RULE_SETTING_BOUNDS.number;
const SCALE = RULE_SETTING_BOUNDS.scale;
const REVIEWS = RULE_SETTING_BOUNDS.reviews;

type KnobMeta = Omit<SettingMeta, "key" | "kind" | "rules" | "min" | "max"> & { kind?: SettingMeta["kind"] };

const THRESHOLD_META: Readonly<Record<ThresholdName, KnobMeta>> = {
  SPLIT_RANGE: { label: "Split range", description: "Merit range (highest minus lowest) at or above which a paper is split (inclusive).", unit: "merit points", step: 1, rule: "SPLIT", alsoUsedBy: ["overview spread histogram", "burndown", "reviewer 'silent on split papers'"] },
  STALE_DAYS: { label: "Quiet limit", description: "Days without in-HotCRP activity before a paper has gone quiet (strictly longer).", unit: "days", step: 0.5, rule: "GONE_QUIET", alsoUsedBy: ["AC stale papers"] },
  UNRESOLVED_DAYS: { label: "Unresolved after", description: "Days of discussion without merit movement before a split is unresolved (strictly longer).", unit: "days", step: 0.5, rule: "UNRESOLVED_SPLIT", alsoUsedBy: [] },
  PING_DAYS: { label: "Unanswered ping after", description: "Days before an @mention or AC comment counts as an unanswered ping.", unit: "days", step: 0.5, rule: null, alsoUsedBy: ["reviewer unanswered pings", "person page open pings"] },
  MIN_WORDS: { label: "Word floor", description: "Submitted reviews under this many words are thin (strictly under).", unit: "words", step: 10, rule: "THIN_REVIEWS", alsoUsedBy: ["reviewer thin reviews", "tier progress", "process report"] },
  DEADLINE_DAYS: { label: "Deadline window", description: "Days before decisions are due when the rule can fire (strictly less than).", unit: "days", step: 0.5, rule: "DEADLINE_NO_CONSENSUS", alsoUsedBy: [] },
  RATING_RATERS: { label: "Raters for a short/vague flag", description: "How many raters must flag a review short (or vague, counted separately) before it counts as thin.", unit: "raters", step: 1, rule: "THIN_REVIEWS", alsoUsedBy: ["reviewer thin reviews"] },
  FLAGGED_PAPERS: { label: "Repeatedly flagged after", description: "Different papers on which a reviewer's reviews drew a negative rating flag before they are listed as repeatedly flagged.", unit: "papers", step: 1, rule: null, alsoUsedBy: ["reviewer 'repeatedly flagged' list"] },
};

const SCALE_META: Readonly<Record<ScaleKey, KnobMeta & { min: number; max: number }>> = {
  PCS_MERIT_ACCEPT_MIN: { kind: "int", label: "Accept-side merit", description: "Lowest merit on the accept side of the review form's scale.", unit: "merit", step: 1, min: SCALE.min, max: SCALE.max, rule: null, alsoUsedBy: ["process report agreement"] },
  PCS_EXPERTISE_OK_MIN: { kind: "int", label: "Knowledgeable expertise", description: "Lowest expertise value that counts as knowledgeable.", unit: "expertise", step: 1, min: SCALE.min, max: SCALE.max, rule: "LOW_EXPERTISE", alsoUsedBy: [] },
  PCS_REVIEWS_REQUIRED: { kind: "int", label: "Reviews required", description: "Submitted reviewer reviews each paper needs.", unit: "reviews", step: 1, min: REVIEWS.min, max: REVIEWS.max, rule: "MISSING_REVIEWS", alsoUsedBy: ["overview stages", "discussion leads"] },
};

function rulesReading(key: SettingKey): RuleName[] {
  return RULE_META.filter((r) => r.settings.includes(key)).map((r) => r.name);
}

/** Every setting, in display order: per rule (switch, weight), then thresholds, then the score knobs. */
export const SETTING_META: readonly SettingMeta[] = [
  ...RULE_META.flatMap((r): SettingMeta[] => [
    { key: enabledKey(r.name), kind: "bool", label: "Enabled", description: `Evaluate ${r.label}. Off: it never fires, whatever its weight.`, unit: "", rule: r.name, rules: [r.name], alsoUsedBy: [] },
    { key: weightKey(r.name), kind: "number", label: "Weight", description: "Added to a paper's severity when the rule fires. 0 also disables it.", unit: "points", min: NUM.min, max: NUM.max, step: 1, rule: r.name, rules: [r.name], alsoUsedBy: [] },
  ]),
  ...THRESHOLD_NAMES.map((t): SettingMeta => ({ key: T(t), kind: "number", min: NUM.min, max: NUM.max, rules: rulesReading(T(t)), ...THRESHOLD_META[t] })),
  ...(Object.keys(SCALE_META) as ScaleKey[]).map((k): SettingMeta => {
    const m = SCALE_META[k];
    return { key: k, kind: m.kind ?? "int", rules: rulesReading(k), ...m };
  }),
];

export const SETTING_KEYS: readonly SettingKey[] = SETTING_META.map((m) => m.key);
const META_BY_KEY: ReadonlyMap<string, SettingMeta> = new Map(SETTING_META.map((m) => [m.key, m]));

export const isSettingKey = (k: string): k is SettingKey => META_BY_KEY.has(k);
export const settingMeta = (k: SettingKey): SettingMeta => META_BY_KEY.get(k)!;

// ---------------------------------------------------------------------------
// Values

/** Every setting as a flat key -> value map. */
export function flatSettings(s: RuleSettings): Record<SettingKey, SettingValue> {
  const out: Partial<Record<SettingKey, SettingValue>> = {};
  for (const r of RULE_NAMES) {
    out[enabledKey(r)] = s.enabled[r];
    out[weightKey(r)] = s.weights[r];
  }
  for (const t of THRESHOLD_NAMES) out[T(t)] = s.thresholds[t];
  out.PCS_MERIT_ACCEPT_MIN = s.meritAcceptMin;
  out.PCS_EXPERTISE_OK_MIN = s.expertiseOkMin;
  out.PCS_REVIEWS_REQUIRED = s.reviewsRequired;
  return out as Record<SettingKey, SettingValue>;
}

/** The env defaults with the overrides on top. */
export function overlay(defaults: RuleSettings, o: Overrides): RuleSettings {
  const enabled = { ...defaults.enabled };
  const weights = { ...defaults.weights };
  const thresholds = { ...defaults.thresholds };
  for (const r of RULE_NAMES) {
    const e = o[enabledKey(r)];
    if (typeof e === "boolean") enabled[r] = e;
    const w = o[weightKey(r)];
    if (typeof w === "number") weights[r] = w;
  }
  for (const t of THRESHOLD_NAMES) {
    const v = o[T(t)];
    if (typeof v === "number") thresholds[t] = v;
  }
  const num = (k: ScaleKey, d: number) => (typeof o[k] === "number" ? (o[k] as number) : d);
  return {
    enabled,
    weights,
    thresholds,
    meritAcceptMin: num("PCS_MERIT_ACCEPT_MIN", defaults.meritAcceptMin),
    expertiseOkMin: num("PCS_EXPERTISE_OK_MIN", defaults.expertiseOkMin),
    reviewsRequired: num("PCS_REVIEWS_REQUIRED", defaults.reviewsRequired),
  };
}

/** Weights as the evaluator sees them: a disabled rule weighs 0 (not evaluated). */
export function effectiveWeights(s: RuleSettings): Record<RuleName, number> {
  return Object.fromEntries(RULE_NAMES.map((r) => [r, s.enabled[r] ? s.weights[r] : 0])) as Record<RuleName, number>;
}

export type ParseResult = { ok: true; value: SettingValue } | { ok: false; error: string };

/**
 * Validate one override with the env variable's own FIELDS parser. JSON
 * booleans/numbers and their string forms (the CLI) are accepted; the value
 * is rendered to the env string form and parsed exactly as env would be.
 */
export function parseSetting(key: string, value: unknown): ParseResult {
  if (!isSettingKey(key)) return { ok: false, error: `unknown rule setting ${JSON.stringify(key)}` };
  const meta = settingMeta(key);
  let text: string;
  if (meta.kind === "bool") {
    if (typeof value !== "boolean" && typeof value !== "string") return { ok: false, error: "expected true or false" };
    text = String(value);
  } else {
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return { ok: false, error: "expected a finite number" };
      text = String(value);
    } else if (typeof value === "string") text = value;
    else return { ok: false, error: meta.kind === "int" ? "expected an integer" : "expected a number" };
  }
  if (text.trim() === "") return { ok: false, error: "empty value (use null / `default` to reset to the env default)" };
  const field = (FIELDS as Record<string, { safeParse(v: unknown): { success: boolean; data?: unknown; error?: { issues: { message: string }[] } } }>)[key]!;
  const r = field.safeParse(text);
  if (!r.success) return { ok: false, error: r.error?.issues.map((i) => i.message).join("; ") ?? "invalid" };
  return { ok: true, value: r.data as SettingValue };
}

export interface ChangeError {
  key: string;
  error: string;
}

/**
 * Apply a change request to the current overrides: key -> value sets an
 * override, key -> null removes it (back to the env default). All-or-nothing:
 * any error and `overrides` is the unchanged input.
 */
export function applyChanges(current: Overrides, changes: Readonly<Record<string, unknown>>): { overrides: Overrides; errors: ChangeError[] } {
  let next: Overrides = { ...current };
  const errors: ChangeError[] = [];
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) {
      if (!isSettingKey(key)) errors.push({ key, error: `unknown rule setting ${JSON.stringify(key)}` });
      else next = Object.fromEntries(Object.entries(next).filter(([k]) => k !== key)) as Overrides;
      continue;
    }
    const p = parseSetting(key, value);
    if (!p.ok) errors.push({ key, error: p.error });
    else next[key as SettingKey] = p.value;
  }
  return errors.length ? { overrides: current, errors } : { overrides: next, errors };
}

/** Drop keys this build doesn't know or no longer accepts (e.g. narrower bounds after an upgrade). */
export function sanitizeOverrides(raw: unknown): { overrides: Overrides; dropped: string[] } {
  const overrides: Overrides = {};
  const dropped: string[] = [];
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const p = parseSetting(k, v);
      if (p.ok) overrides[k as SettingKey] = p.value;
      else dropped.push(k);
    }
  }
  return { overrides, dropped };
}

export interface SettingChange {
  key: SettingKey;
  /** Effective value before / after. */
  from: SettingValue;
  to: SettingValue;
  /** Whether the value before / after was an override (false = the env default). */
  fromOverride: boolean;
  toOverride: boolean;
}

/** What changes between two override sets, over the same env defaults (display order). */
export function diffOverrides(defaults: RuleSettings, before: Overrides, after: Overrides): SettingChange[] {
  const a = flatSettings(overlay(defaults, before));
  const b = flatSettings(overlay(defaults, after));
  const out: SettingChange[] = [];
  for (const key of SETTING_KEYS) {
    const fromOverride = before[key] !== undefined;
    const toOverride = after[key] !== undefined;
    if (a[key] !== b[key] || fromOverride !== toOverride) out.push({ key, from: a[key], to: b[key], fromOverride, toOverride });
  }
  return out;
}

/** "PCS_THRESH_STALE_DAYS 4 -> 7 (default 4)". */
export function describeChange(c: SettingChange): string {
  const v = (x: SettingValue, over: boolean) => `${x}${over ? "" : " (env default)"}`;
  return `${c.key}: ${v(c.from, c.fromOverride)} -> ${v(c.to, c.toOverride)}`;
}
