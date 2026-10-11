// The probe's shape report and its renderers (text, Markdown, JSON).
//
// Renderers see only a ProbeReport: counts, booleans, and Safe strings (see
// safe.ts). They never see a HotCRP response, so they cannot print content.

import { label, type Counts, type Safe, type Shape } from "./safe.js";

export type SchemaVerdict = "pass" | "fail" | "skipped";

export interface EndpointResult {
  name: Safe;
  reachable: boolean;
  requests: number;
  /** HTTP status of the failure, if any. */
  status?: number;
  error?: Safe;
  schema: SchemaVerdict;
  /** Responses (chunks) that failed the schema, of `requests`. */
  schemaFailures: number;
  /** Zod issue paths and messages (indices collapsed to []), deduplicated. */
  schemaIssues: Safe[];
}

export interface Presence {
  present: number;
  total: number;
}

export interface ObservedValues {
  /** Reviews where the key is present. */
  present: number;
  nulls: number;
  numeric: number;
  min?: number;
  max?: number;
  /** Short symbol values (e.g. letter scales), with counts. */
  symbols: Counts;
  /** Other string values: counted, never shown. */
  otherStrings: number;
}

export interface FormField {
  uid: Safe;
  name: Safe;
  type: Safe;
  order?: number;
  required?: boolean;
  visibility?: Safe;
  scheme?: Safe;
  /** Score fields: declared labels; value i+1 is labels[i]. */
  labels?: Safe[];
  /** From /settings?filter=rf, matched by order: internal id and value symbols. */
  settingsId?: Safe;
  symbols?: Safe[];
  observed?: ObservedValues;
}

export interface ProbeReport {
  reportVersion: 1;
  hotcrp: { version?: Safe; commit?: Safe };
  account: { roles: Safe[]; chair: boolean; forceShow: boolean };
  endpoints: EndpointResult[];
  shapes: { name: Safe; shape: Shape }[];
  pc?: {
    size: number;
    chairs: number;
    /** Viewable user-tag names from /pc (built-in role tags listed apart). */
    userTags: Safe[];
    builtinTags: Safe[];
    /** Members whose /pc entry carries a per-user `tags` key. */
    membersWithTags: number;
    membersWithColorClasses: number;
    colorClasses: Counts;
  };
  papers?: {
    all: number;
    submitted?: number;
    byStatus: Counts;
    byDecision: Counts;
    fieldsReturned: Safe[];
    withTags: number;
    distinctTags: number;
  };
  assignments?: { rows: number; papers: number; byAction: Counts; withRound: number };
  reviews?: {
    total: number;
    byType: Counts;
    byStatus: Counts;
    /** "type × status" cells. */
    byTypeStatus: Counts;
    modifiedAt: Presence;
    version: Presence;
    reviewerEmail: Presence;
    /** Review keys not in the form and not in ReviewSchema. */
    extraKeys: Safe[];
  };
  comments?: {
    total: number;
    byVisibility: Counts;
    byTopic: Counts;
    responses: number;
    responseDrafts: number;
    responseRounds: Counts;
    drafts: number;
    byAuthor: number;
    withTags: number;
    modifiedAt: Presence;
    wordCountNonNull: number;
  };
  form: FormField[];
  /**
   * Review ratings: HotCRP's `review_rating` (pc | all | no) and
   * `review_rating_visibility` (limited | yes | no) settings, and how many
   * reviews carry ratings, with flag counts (raters per flag, summed).
   */
  ratings?: { setting?: Safe; visibility?: Safe; reviewsRated?: number; flags?: Counts };
  history: { sampled: boolean; versions?: number; objects: Counts; ratingKeys: Safe[] };
  rateLimit: { headers: Safe[]; limit?: number; minRemaining?: number; responses: number; status429: number };
  warnings: Safe[];
}

// ---------------------------------------------------------------------------
// Suggested env

export interface EnvSuggestion {
  name: string;
  value: Safe;
  why: Safe;
}

const isScore = (f: FormField) => (f.labels?.length ?? 0) > 0 || (f.symbols?.length ?? 0) > 0;

function pick(fields: FormField[], uid: string, re: RegExp): FormField | undefined {
  const scores = fields.filter(isScore);
  return scores.find((f) => f.uid === uid) ?? scores.find((f) => re.test(f.name) || re.test(f.uid));
}

function scaleSize(f: FormField): number {
  return f.labels?.length ?? f.symbols?.length ?? 0;
}

function letterScale(f: FormField): boolean {
  return (f.symbols ?? []).some((s) => !/^\d+$/.test(s));
}

function thresholdGuess(f: FormField, re: RegExp, not: RegExp | undefined, fallback: (n: number) => number) {
  const labels = f.labels ?? [];
  const i = labels.findIndex((l) => re.test(l) && !(not?.test(l) ?? false));
  const n = scaleSize(f);
  const value = i >= 0 ? i + 1 : fallback(n);
  const basis = i >= 0 ? `first label matching ${re.source}: ${labels[i]}` : `no matching label; guessed from a 1..${n} scale`;
  const letters = letterScale(f) ? "; LETTER SCALE, check by hand" : "";
  return { value: String(value) as Safe, why: label(`${basis}${letters}`.slice(0, 60)) };
}

export function suggestEnv(r: ProbeReport): EnvSuggestion[] {
  const out: EnvSuggestion[] = [];
  const merit = pick(r.form, "OveMer", /overall|merit/i);
  const expertise = pick(r.form, "RevExp", /expertise|familiarity|confidence/i);
  if (merit) {
    out.push({ name: "PCS_FIELD_MERIT", value: merit.uid, why: merit.name });
    const t = thresholdGuess(merit, /accept/i, /reject/i, (n) => Math.floor(n / 2) + 1);
    out.push({ name: "PCS_MERIT_ACCEPT_MIN", ...t });
  }
  if (expertise) {
    out.push({ name: "PCS_FIELD_EXPERTISE", value: expertise.uid, why: expertise.name });
    const t = thresholdGuess(expertise, /knowledgeable|expert/i, /no |not /i, (n) => Math.ceil((n * 3) / 4));
    out.push({ name: "PCS_EXPERTISE_OK_MIN", ...t });
  }
  const tags = r.pc?.userTags ?? [];
  const tiers: [string, RegExp][] = [
    ["junior", /junior/i],
    ["reciprocal", /recip/i],
    ["reserve-active", /reserve.*activ|activ.*reserve/i],
    ["reserve-pool", /reserve|pool/i],
  ];
  const used = new Set<string>();
  const pairs: string[] = [];
  for (const [tier, re] of tiers) {
    const tag = tags.find((t) => re.test(t) && !used.has(t));
    if (tag) {
      used.add(tag);
      pairs.push(`${tier}=${tag}`);
    }
  }
  out.push({
    name: "PCS_TIER_TAGS",
    value: pairs.join(",") as Safe,
    why: (pairs.length > 0 ? "guessed from /pc user-tag names" : "no tier-like user tags visible in /pc") as Safe,
  });
  return out;
}

// ---------------------------------------------------------------------------
// Rendering

export function failingEndpoints(r: ProbeReport): EndpointResult[] {
  return r.endpoints.filter((e) => !e.reachable);
}

function counts(c: Counts): string {
  return c.length === 0 ? "(none)" : c.map(([k, n]) => `${k} ${n}`).join(", ");
}

function frac(p: Presence): string {
  return `${p.present}/${p.total}`;
}

function shapeLines(s: Shape): string[] {
  const lines = s.keys.map((k) => {
    const opt = k.present === k.total ? "" : `  (present on ${k.present}/${k.total})`;
    return `${k.key}: ${k.types.join(" | ")}${opt}`;
  });
  if (s.otherKeys > 0) lines.push(`(${s.otherKeys} non-identifier keys, not shown)`);
  return lines;
}

function observed(o: ObservedValues | undefined): string {
  if (!o) return "not observed";
  const parts = [`on ${o.present} reviews`];
  if (o.numeric > 0) parts.push(`numeric ${o.min}..${o.max}`);
  if (o.symbols.length > 0) parts.push(`symbols ${counts(o.symbols)}`);
  if (o.nulls > 0) parts.push(`null ${o.nulls}`);
  if (o.otherStrings > 0) parts.push(`text ${o.otherStrings}`);
  return parts.join("; ");
}

interface Section {
  title: string;
  lines: string[];
  /** Pre-formatted block (shapes, env). */
  code?: boolean;
}

function sections(r: ProbeReport): Section[] {
  const s: Section[] = [];
  const bad = failingEndpoints(r);
  const drift = r.endpoints.filter((e) => e.schema === "fail");
  s.push({
    title: "Summary",
    lines: [
      `HotCRP version: ${r.hotcrp.version ?? "unknown"}${r.hotcrp.commit ? ` (${r.hotcrp.commit})` : ""}`,
      `Token roles: ${r.account.roles.join(", ") || "(none)"}${r.account.chair ? "" : "  << not a chair token"}`,
      `forceShow: ${r.account.forceShow ? "1" : "0"}`,
      `Endpoints reachable: ${r.endpoints.length - bad.length}/${r.endpoints.length}`,
      `Schema drift: ${drift.length === 0 ? "none" : drift.map((e) => e.name).join(", ")}`,
      ...r.warnings.map((w) => `Warning: ${w}`),
    ],
  });
  s.push({
    title: "Endpoints",
    lines: r.endpoints.flatMap((e) => {
      const head = `${e.reachable ? "ok  " : "FAIL"} ${e.name}  [${e.requests} req, schema ${e.schema}${
        e.schemaFailures > 0 ? ` (${e.schemaFailures} failing)` : ""
      }]`;
      return [
        head,
        ...(e.error ? [`     error: ${e.error}${e.status !== undefined ? ` (HTTP ${e.status})` : ""}`] : []),
        ...e.schemaIssues.map((i) => `     schema: ${i}`),
      ];
    }),
    code: true,
  });
  if (r.pc) {
    s.push({
      title: "PC",
      lines: [
        `PC size: ${r.pc.size} (chairs ${r.pc.chairs})`,
        `User tags (names): ${r.pc.userTags.join(", ") || "(none)"}`,
        `Built-in role tags: ${r.pc.builtinTags.join(", ") || "(none)"}`,
        `Per-user tags visible in /pc: ${r.pc.membersWithTags > 0 ? `yes, on ${r.pc.membersWithTags}/${r.pc.size}` : "no"}`,
        `color_classes on ${r.pc.membersWithColorClasses}/${r.pc.size} members: ${counts(r.pc.colorClasses)}`,
      ],
    });
  }
  if (r.papers) {
    s.push({
      title: "Papers",
      lines: [
        `All (t=all): ${r.papers.all}; submitted (t=s): ${r.papers.submitted ?? "?"}`,
        `By status: ${counts(r.papers.byStatus)}`,
        `By decision: ${counts(r.papers.byDecision)}`,
        `Search fields returned: ${r.papers.fieldsReturned.join(", ") || "(none)"}`,
        `Papers with tags: ${r.papers.withTags} (${r.papers.distinctTags} distinct tags; names not shown)`,
      ],
    });
  }
  if (r.assignments) {
    s.push({
      title: "Assignments (get/pcassignments)",
      lines: [
        `Rows: ${r.assignments.rows} over ${r.assignments.papers} papers; with round: ${r.assignments.withRound}`,
        `By action: ${counts(r.assignments.byAction)}`,
      ],
    });
  }
  if (r.reviews) {
    s.push({
      title: "Reviews",
      lines: [
        `Total: ${r.reviews.total}`,
        `By type: ${counts(r.reviews.byType)}`,
        `By status: ${counts(r.reviews.byStatus)}`,
        `By type x status: ${counts(r.reviews.byTypeStatus)}`,
        `modified_at present on ${frac(r.reviews.modifiedAt)} reviews`,
        `version present on ${frac(r.reviews.version)}; reviewer_email on ${frac(r.reviews.reviewerEmail)}`,
        `Keys outside the form and schema: ${r.reviews.extraKeys.join(", ") || "(none)"}`,
      ],
    });
  }
  if (r.comments) {
    const c = r.comments;
    s.push({
      title: "Comments",
      lines: [
        `Total: ${c.total} (drafts ${c.drafts}; by authors ${c.byAuthor}; with tags ${c.withTags})`,
        `Responses: ${c.responses} (drafts ${c.responseDrafts}); rounds: ${counts(c.responseRounds)}`,
        `By visibility: ${counts(c.byVisibility)}`,
        `By topic: ${counts(c.byTopic)}`,
        `modified_at present on ${frac(c.modifiedAt)} comments; word_count non-null on ${c.wordCountNonNull}`,
      ],
    });
  }
  s.push({
    title: "Review form",
    lines:
      r.form.length === 0
        ? ["(not available)"]
        : r.form.flatMap((f) => {
            const meta = [
              f.type,
              f.required ? "required" : undefined,
              f.visibility ? `vis ${f.visibility}` : undefined,
              f.scheme ? `scheme ${f.scheme}` : undefined,
              f.settingsId ? `settings ${f.settingsId}` : undefined,
            ].filter((x) => x !== undefined);
            const lines = [`${f.uid}  "${f.name}"  (${meta.join(", ")})`];
            if (f.labels && f.labels.length > 0) {
              const sym = f.symbols && f.symbols.length === f.labels.length ? f.symbols : undefined;
              lines.push(`    declared: ${f.labels.map((l, i) => `${sym ? sym[i] : i + 1}=${l}`).join(", ")}`);
            }
            lines.push(`    observed: ${observed(f.observed)}`);
            return lines;
          }),
  });
  if (r.ratings) {
    const g = r.ratings;
    s.push({
      title: "Review ratings",
      lines: [
        `review_rating: ${g.setting ?? "?"}; review_rating_visibility: ${g.visibility ?? "?"}${g.setting === "no" ? " (ratings off: rating signals will be hidden)" : ""}`,
        `Reviews carrying ratings: ${g.reviewsRated ?? "?"}${r.reviews ? ` of ${r.reviews.total}` : ""}`,
        `Flags: ${g.flags && g.flags.length > 0 ? counts(g.flags) : "(none)"}`,
      ],
    });
  }
  s.push({
    title: "Review history / rating sample",
    lines: r.history.sampled
      ? [
          `reviewhistory versions: ${r.history.versions ?? "?"} (${counts(r.history.objects)})`,
          `reviewrating keys: ${r.history.ratingKeys.join(", ") || "(none)"}`,
        ]
      : ["(no review to sample)"],
  });
  s.push({
    title: "Rate limits",
    lines: [
      `Headers seen: ${r.rateLimit.headers.join(", ") || "(none)"}`,
      `Limit ${r.rateLimit.limit ?? "?"}; lowest remaining ${r.rateLimit.minRemaining ?? "?"}; ${r.rateLimit.responses} responses, ${r.rateLimit.status429} x 429`,
    ],
  });
  for (const sh of r.shapes) {
    s.push({ title: `Shape: ${sh.name} (${sh.shape.objects} objects)`, lines: shapeLines(sh.shape), code: true });
  }
  s.push({
    title: "Suggested env (check before use)",
    lines: suggestEnv(r).map((e) => `${e.name}=${e.value}  # ${e.why}`),
    code: true,
  });
  return s;
}

export function renderText(r: ProbeReport): string {
  const out = ["pcs probe: shape report (no content)", ""];
  for (const sec of sections(r)) {
    out.push(`== ${sec.title}`, ...sec.lines.map((l) => `  ${l}`), "");
  }
  return `${out.join("\n").trimEnd()}\n`;
}

export function renderMarkdown(r: ProbeReport): string {
  const out = [
    "## `pcs probe` report",
    "",
    "_Shape report from the live instance. Contains no titles, names, emails, or text._",
    "",
  ];
  for (const sec of sections(r)) {
    out.push(`### ${sec.title}`, "");
    if (sec.code) out.push("```", ...sec.lines, "```");
    else out.push(...sec.lines.map((l) => `- ${l.replace(/^\s+/, "  ")}`));
    out.push("");
  }
  return `${out.join("\n").trimEnd()}\n`;
}

export function renderJson(r: ProbeReport): string {
  return `${JSON.stringify({ ...r, suggestedEnv: suggestEnv(r) }, null, 2)}\n`;
}
