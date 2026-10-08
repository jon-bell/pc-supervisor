// Zod schemas for every HotCRP response the app consumes. Checked against the
// harness by the contract tests (server/test/contract/). When HotCRP
// surprises you, fix the schema here and add a contract test; don't catch
// and hide it.
//
// Conventions:
// - Objects are `z.looseObject`: unknown keys pass through (HotCRP adds keys
//   freely), but every key we rely on is typed.
// - Keys HotCRP omits when empty/false are `.optional()`.
// - Facts below were read from HotCRP @ 60f693f (src/paperexport.php,
//   src/commentinfo.php, src/listaction.php, src/api/*) and the harness.

import { z } from "zod";
import { RATING_FLAGS } from "../ratings.js";

const int = z.number().int();
const pid = int.positive();

/** HotCRP message_list entry. status: -5..-1 notes, 0 plain, 1 warning, 2 error, 3 urgent. */
export const MessageSchema = z.looseObject({
  status: int,
  message: z.string().optional(),
  field: z.string().optional(),
});
export type HotcrpMessage = z.infer<typeof MessageSchema>;

/** Every JSON API response; `ok: false` responses carry message_list. */
export const EnvelopeSchema = z.looseObject({
  ok: z.boolean(),
  message_list: z.array(MessageSchema).optional(),
});

const ok = { ok: z.literal(true), message_list: z.array(MessageSchema).optional() };

// --- /whoami ---------------------------------------------------------------

export const WhoamiSchema = z.looseObject({
  ...ok,
  email: z.string(),
  given_name: z.string().optional(),
  family_name: z.string().optional(),
  affiliation: z.string().optional(),
  roles: z.array(z.string()).optional(),
});
export type Whoami = z.infer<typeof WhoamiSchema>;

// --- /pc -------------------------------------------------------------------
// NOTE: /pc does NOT return per-user tags. `color_classes` only reflects tags
// that have colors; top-level `tags` lists tag names viewable on users.

export const PcMemberSchema = z.looseObject({
  name: z.string(),
  email: z.string(),
  affiliation: z.string().optional(),
  /** Present ("chair") only for chairs. */
  roles: z.string().optional(),
  color_classes: z.string().optional(),
});
export type PcMember = z.infer<typeof PcMemberSchema>;

export const PcSchema = z.looseObject({
  ...ok,
  pc: z.array(PcMemberSchema),
  tags: z.array(z.string()).optional(),
  sort: z.string().optional(),
});
export type PcResponse = z.infer<typeof PcSchema>;

// --- /search (with f=... and format=csv) -----------------------------------
// Despite format=csv the response is JSON; `format` only makes field values
// plain text. A field is omitted from a paper's object when empty (lead,
// shepherd, ...). Asking for `manager` yields the key `administrator`.

export const SearchFieldSchema = z.looseObject({
  name: z.string(),
  title: z.string().optional(),
});

export const SearchPaperSchema = z.looseObject({ pid }).catchall(z.string());
export type SearchPaper = z.infer<typeof SearchPaperSchema>;

export const SearchSchema = z.looseObject({
  ...ok,
  ids: z.array(pid),
  search_params: z.string(),
  groups: z.array(z.unknown()).optional(),
  fields: z.array(SearchFieldSchema).optional(),
  papers: z.array(SearchPaperSchema).optional(),
});
export type SearchResponse = z.infer<typeof SearchSchema>;

// --- /searchcompletion, /alltags (what HotCRP's own search box suggests) ----
// hotcrp@60f693f src/api/api_completion.php: a list of completion strings
// ("has:lead", "dec:Accepted", "show:OveMer", "abstract:{text}", ...) and
// priority groups {pri, nosort, i}. No tags, users or keywords: HotCRP's
// script.js gets tags from /alltags and hard-codes nothing else.
// /alltags: tag names on papers the token can see (no counts, no values).

export const SearchCompletionItemSchema = z.union([
  z.string(),
  z.looseObject({ pri: z.number().optional(), nosort: z.boolean().optional(), i: z.union([z.string(), z.array(z.string())]) }),
]);
export const SearchCompletionSchema = z.looseObject({ ...ok, searchcompletion: z.array(SearchCompletionItemSchema) });
export type SearchCompletionResponse = z.infer<typeof SearchCompletionSchema>;

export const AllTagsSchema = z.looseObject({ ...ok, tags: z.array(z.string()) });

// --- /searchaction?action=get/pcassignments (CSV) ---------------------------
// Header: paper,action,email[,round][,review_token],title[,message]. The
// first row per paper is `clearreview` with email "#pc" and the title; later
// rows omit trailing empty cells. At HotCRP 60f693f this list contains review
// assignments only (no lead/shepherd/manager rows; get those from /search).

export const ASSIGNMENT_ACTIONS = [
  "clearreview",
  "externalreview",
  "pcreview",
  "secondaryreview",
  "primaryreview",
  "metareview",
  "warning",
] as const;

export const PcAssignmentRowSchema = z.looseObject({
  paper: z.string().regex(/^[1-9]\d*$/, "expected a pid").transform(Number),
  action: z.enum(ASSIGNMENT_ACTIONS),
  email: z.string().optional(),
  round: z.string().optional(),
  review_token: z.string().optional(),
  title: z.string().optional(),
  message: z.string().optional(),
});
export const PcAssignmentsSchema = z.array(PcAssignmentRowSchema);
export type PcAssignmentRow = z.infer<typeof PcAssignmentRowSchema>;

// --- /searchaction?action=get/lead | get/shepherd (CSV) ----------------------
// Header: paper,title,given_name,family_name,<kind>email. One row per paper
// that has a lead (shepherd). /search's `lead` and `manager` fields give only
// display names, so lead/shepherd emails come from here
// (src/listactions/la_getlead.php).

export interface PaperRoleRow {
  pid: number;
  email: string;
}

const csvPid = z.string().regex(/^[1-9]\d*$/, "expected a pid").transform(Number);

export const LeadRowsSchema = z.array(
  z
    .looseObject({ paper: csvPid, leademail: z.string().min(1) })
    .transform((r): PaperRoleRow => ({ pid: r.paper, email: r.leademail })),
);
export const ShepherdRowsSchema = z.array(
  z
    .looseObject({ paper: csvPid, shepherdemail: z.string().min(1) })
    .transform((r): PaperRoleRow => ({ pid: r.paper, email: r.shepherdemail })),
);

export function paperRoleRowsSchema(kind: "lead" | "shepherd") {
  return kind === "lead" ? LeadRowsSchema : ShepherdRowsSchema;
}

// --- /searchaction?action=get/pcconf (CSV) ----------------------------------
// The "PC conflicts" download (src/listactions/la_get_sub.php,
// GetPcconflicts_ListAction; managers only). Header:
// paper,title,given_name,family_name,email,conflicttype. One row per
// conflicted (paper, PC member) pair, ordered by paper, then PC order; papers
// without conflicts have no row. conflicttype is the text label: "Author",
// "Contact", "Conflict", "Pinned conflict", or a configured description
// (e.g. "Advisor/student"). PC members only: non-PC authors don't appear.

export interface PcConflictRow {
  pid: number;
  title: string;
  givenName: string;
  familyName: string;
  email: string;
  conflictType: string;
}

export const PcConflictsSchema = z.array(
  z
    .looseObject({
      paper: csvPid,
      title: z.string().optional(),
      given_name: z.string().optional(),
      family_name: z.string().optional(),
      email: z.string().min(1),
      conflicttype: z.string().min(1),
    })
    .transform(
      (r): PcConflictRow => ({
        pid: r.paper,
        title: r.title ?? "",
        givenName: r.given_name ?? "",
        familyName: r.family_name ?? "",
        email: r.email.toLowerCase(),
        conflictType: r.conflicttype,
      }),
    ),
);

// --- /searchaction?action=get/allrevpref (CSV) ------------------------------
// "PC review preferences" download (src/listactions/la_getallrevpref.php,
// GetAllRevpref_ListAction; managers only, and a scoped token needs
// preference:read). Header: paper,title,given_name,family_name,email,
// conflict,preference[,expertise][,topic_score]. `expertise` appears only if
// some preference carries one, `topic_score` only if some PC member declared a
// topic interest. One row per (paper, PC member) with a nonzero preference, an
// expertise, a nonzero topic score, or a conflict; other pairs have no row.
// conflict is "conflict" or empty; preference an integer (empty = 0);
// expertise X (expert), Y, or Z (unfamiliar), empty = none; topic_score a
// number (empty = 0).

export interface RevPrefRow {
  pid: number;
  email: string;
  conflict: boolean;
  preference: number;
  expertise: "X" | "Y" | "Z" | null;
  topicScore: number;
}

const csvNumber = z
  .string()
  .optional()
  .transform((v, ctx) => {
    if (v === undefined || v.trim() === "") return 0;
    const n = Number(v);
    if (!Number.isFinite(n)) {
      ctx.addIssue({ code: "custom", message: `expected a number, got ${JSON.stringify(v.slice(0, 20))}` });
      return z.NEVER;
    }
    return n;
  });

export const AllRevPrefSchema = z.array(
  z
    .looseObject({
      paper: csvPid,
      email: z.string().min(1),
      conflict: z.enum(["", "conflict"]).optional(),
      preference: csvNumber,
      expertise: z.enum(["", "X", "Y", "Z"]).optional(),
      topic_score: csvNumber,
    })
    .transform(
      (r): RevPrefRow => ({
        pid: r.paper,
        email: r.email.toLowerCase(),
        conflict: r.conflict === "conflict",
        preference: r.preference,
        expertise: r.expertise === undefined || r.expertise === "" ? null : r.expertise,
        topicScore: r.topic_score,
      }),
    ),
);

// --- /reviews, /{p}/reviewhistory -------------------------------------------

/** rtype: 1 external, 2 PC, 3 secondary, 4 primary, 5 metareview. */
export const ReviewTypeSchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]);
export const REVIEW_STATUSES = ["empty", "acknowledged", "draft", "delivered", "approved", "complete"] as const;
export const ReviewStatusSchema = z.enum(REVIEW_STATUSES);

/**
 * A review-form field value (ReviewField::unparse_json, by field type):
 * - text: string;
 * - radio/dropdown: the score symbol (number, or a letter), or false for "no entry";
 * - checkbox: boolean;
 * - checkboxes: list of symbols;
 * - any type: null.
 */
export const ReviewFieldValueSchema = z.union([
  z.number(),
  z.string(),
  z.boolean(),
  z.array(z.union([z.number(), z.string()])),
  z.null(),
]);
export type ReviewFieldValue = z.infer<typeof ReviewFieldValueSchema>;

/** Review-field types whose values are free text. */
export const TEXT_FIELD_TYPES: ReadonlySet<string> = new Set(["text"]);
/** Review-field types whose values are scores. Others (checkbox, checkboxes) are not stored. */
export const SCORE_FIELD_TYPES: ReadonlySet<string> = new Set(["radio", "dropdown"]);

/** One HotCRP rating flag (ReviewInfo::$rating_bits). An unknown flag fails the parse: fix the vocabulary, don't hide it. */
export const RatingFlagSchema = z.enum(RATING_FLAGS);
/** /reviews `ratings`: one flag, or a sorted multiset of flags. */
export const RatingsFieldSchema = z.union([RatingFlagSchema, z.array(RatingFlagSchema)]);

/**
 * One review. Review-form fields appear as extra keys named by field UID
 * (e.g. OveMer, RevExp, PapSum); read them with reviewField().
 *
 * - `version` is an opaque vtag: compare with !== only, never order.
 * - `modified_at` (epoch seconds) is omitted when reviewModified <= timeRequested.
 * - `reviewer` is HTML; use `reviewer_email`.
 */
export const ReviewSchema = z.looseObject({
  object: z.literal("review"),
  pid,
  rid: int.positive(),
  version: int.optional(),
  ordinal: z.string().optional(),
  rtype: ReviewTypeSchema.optional(),
  round: z.string().optional(),
  status: ReviewStatusSchema,
  draft: z.boolean().optional(),
  subreview: z.boolean().optional(),
  ghost: z.boolean().optional(),
  blind: z.boolean().optional(),
  reviewer: z.string().optional(),
  reviewer_email: z.string().optional(),
  modified_at: int.optional(),
  user_rating: z.union([z.string(), z.array(z.string())]).optional(),
  /**
   * Ratings of this review (spec §1, server/src/ratings.ts): a sorted
   * MULTISET of flags, one entry per (rater, flag), e.g.
   * ["short","short","vague"]; a bare flag when there is one; omitted when the
   * review is unrated or ratings are off (src/paperexport.php). No rater
   * identity, no timestamp.
   */
  ratings: RatingsFieldSchema.optional(),
});
export type Review = z.infer<typeof ReviewSchema>;

export const ReviewsSchema = z.looseObject({ ...ok, reviews: z.array(ReviewSchema) });

/**
 * One historical delta in /reviewhistory. Holds only the fields that differ
 * from the next-newer version; text fields may appear as "<UID>:p" patches.
 * No modified_at (HotCRP: "XXX modified_at").
 */
export const ReviewDeltaSchema = z.looseObject({
  object: z.literal("review_delta"),
  pid,
  rid: int.positive(),
  version: int,
  status: ReviewStatusSchema,
  rtype: ReviewTypeSchema.optional(),
  round: z.string().optional(),
});
export type ReviewDelta = z.infer<typeof ReviewDeltaSchema>;

export const ReviewHistorySchema = z.looseObject({
  ...ok,
  pid,
  rid: int.positive(),
  /** Newest first: the current review, then deltas (or full reviews) going back. */
  versions: z.array(z.discriminatedUnion("object", [ReviewSchema, ReviewDeltaSchema])),
});
export type ReviewHistory = z.infer<typeof ReviewHistorySchema>;

// --- /{p}/reviewrating -------------------------------------------------------

/** "none", one rating flag, or a sorted multiset of flags ("short", "vague", "disrespectful", ...). */
export const RatingValueSchema = z.union([z.literal("none"), RatingsFieldSchema]);

export const ReviewRatingSchema = z.looseObject({
  ...ok,
  ratings: RatingValueSchema.optional(),
  user_rating: RatingValueSchema.optional(),
});
export type ReviewRating = z.infer<typeof ReviewRatingSchema>;

// --- /comments ---------------------------------------------------------------

export const CommentSchema = z.looseObject({
  object: z.literal("comment"),
  pid,
  cid: int.positive(),
  ordinal: z.string().optional(),
  visibility: z.enum(["admin", "pc", "rev", "au"]),
  topic: z.enum(["paper", "rev", "dec"]).optional(),
  blind: z.boolean().optional(),
  draft: z.boolean().optional(),
  /** Response round name; present only on author responses. */
  response: z.string().optional(),
  by_author: z.boolean().optional(),
  by_shepherd: z.boolean().optional(),
  tags: z.array(z.string()).optional(),
  /** HTML. Use author_email. */
  author: z.string().optional(),
  author_email: z.string().optional(),
  author_pseudonym: z.string().optional(),
  author_hidden: z.boolean().optional(),
  /** Last modification (epoch seconds). There is no creation time. */
  modified_at: int.optional(),
  text: z.string().optional(),
  format: int.optional(),
  /** null for ordinary comments; compute word counts locally. */
  word_count: int.nullable().optional(),
});
export type Comment = z.infer<typeof CommentSchema>;

export const CommentsSchema = z.looseObject({ ...ok, comments: z.array(CommentSchema) });

// --- Review form ------------------------------------------------------------
// Field UIDs (the keys in /reviews) come from
// /searchaction?action=get/jsonrqc. /settings?filter=rf has the same fields
// keyed by internal id (s01, t01) with per-value symbols, but no UIDs.

export const RqcFieldSchema = z.looseObject({
  uid: z.string(),
  name: z.string(),
  type: z.string(),
  order: int.optional(),
  visibility: z.string().optional(),
  required: z.boolean().optional(),
  description: z.string().optional(),
  /** Score labels; value i+1 is values[i] (unless the field has symbols; see settings). */
  values: z.array(z.string()).optional(),
  scheme: z.string().optional(),
});
export type RqcField = z.infer<typeof RqcFieldSchema>;

/** get/jsonrqc is a download: no `ok` key, always pretty-printed. */
export const RqcSchema = z.looseObject({
  hotcrp_version: z.string(),
  hotcrp_commit: z.string().optional(),
  reviewform: z.record(z.string(), RqcFieldSchema),
  papers: z.array(z.unknown()),
});
export type RqcResponse = z.infer<typeof RqcSchema>;

export const SettingsRfValueSchema = z.looseObject({
  id: int,
  symbol: z.union([z.number(), z.string()]),
  name: z.string(),
  order: int.optional(),
});

export const SettingsRfFieldSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  order: int.optional(),
  required: z.boolean().optional(),
  visibility: z.string().optional(),
  condition: z.string().optional(),
  description: z.string().optional(),
  scheme: z.string().optional(),
  values: z.array(SettingsRfValueSchema).optional(),
});
export type SettingsRfField = z.infer<typeof SettingsRfFieldSchema>;

export const SettingsRfSchema = z.looseObject({
  ...ok,
  settings: z.looseObject({ rf: z.array(SettingsRfFieldSchema) }),
});
export type SettingsRfResponse = z.infer<typeof SettingsRfSchema>;

// --- /settings?filter=review_rating OR review_rating_visibility ----------------
// Who may rate reviews (`pc` | `all` | `no`) and who sees ratings (`limited` |
// `yes` | `no`) (etc/settinginfo.json). With `review_rating: "no"`, /reviews
// carries no ratings at all, so rating-based signals are hidden, not zero.

export const RATING_SETTINGS_FILTER = "review_rating OR review_rating_visibility";

export const RatingSettingsSchema = z.looseObject({
  ...ok,
  settings: z.looseObject({
    review_rating: z.enum(["pc", "all", "no"]),
    review_rating_visibility: z.enum(["limited", "yes", "no"]),
  }),
});
export type RatingSettings = z.infer<typeof RatingSettingsSchema>;

// --- /papers (PLAN M10: authors and submission-option values) -----------------
// One `paper` object per paper (src/paperexport.php). Authors carry email and
// affiliation, but only when the viewer may see authors: for a blind
// submission a chair sees them only with forceShow=1 (checked against the
// harness). Every submission option (settings `sf`, numeric id) appears as a
// key named after the option's *name* (PaperOption::json_key), e.g.
// "Reserve designee": text -> string, dropdown/radio -> the choice name,
// checkbox -> boolean, numeric -> number, checkboxes -> list of names. Read
// them with submissionOptionValue(). The object also carries the abstract and
// document metadata; the sync ignores (never stores) those.

export const PaperAuthorSchema = z.looseObject({
  email: z.string().optional(),
  given_name: z.string().optional(),
  family_name: z.string().optional(),
  affiliation: z.string().optional(),
});
export type PaperAuthor = z.infer<typeof PaperAuthorSchema>;

export const PaperSchema = z.looseObject({
  object: z.literal("paper"),
  pid,
  title: z.string().optional(),
  status: z.string().optional(),
  /** Omitted when the viewer can't see authors (blind, no forceShow). */
  authors: z.array(PaperAuthorSchema).optional(),
});
export type Paper = z.infer<typeof PaperSchema>;

export const PapersSchema = z.looseObject({ ...ok, papers: z.array(PaperSchema) });

/** A submission-option value from /papers. */
export const SubmissionOptionValueSchema = z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()]);
export type SubmissionOptionValue = z.infer<typeof SubmissionOptionValueSchema>;

// --- /settings?filter=sf (submission fields) -----------------------------------
// Intrinsic fields (title, authors, abstract, ...) have string ids; configured
// submission options have numeric ids. `name` is the key in /papers.

export const SettingsSfValueSchema = z.looseObject({ id: int, name: z.string(), order: int.optional() });

export const SettingsSfFieldSchema = z.looseObject({
  id: z.union([int, z.string()]),
  name: z.string(),
  type: z.string().optional(),
  order: int.optional(),
  visibility: z.string().optional(),
  values: z.array(SettingsSfValueSchema).optional(),
});
export type SettingsSfField = z.infer<typeof SettingsSfFieldSchema>;

export const SettingsSfSchema = z.looseObject({
  ...ok,
  settings: z.looseObject({ sf: z.array(SettingsSfFieldSchema) }),
});
export type SettingsSfResponse = z.infer<typeof SettingsSfSchema>;

// --- POST /assign (dry run only in M10) ----------------------------------------
// src/api/api_assign.php. With format=json the result lists the assignments
// HotCRP *would* make (`assignments`, action names like "primaryreview").
// `valid: false` comes with ok: false and error messages; it is a result here,
// not a transport error.

export const AssignResultRowSchema = z.looseObject({
  pid,
  action: z.string(),
  email: z.string().optional(),
  round: z.string().optional(),
});

export const AssignResultSchema = z.looseObject({
  ok: z.boolean(),
  message_list: z.array(MessageSchema).optional(),
  dry_run: z.boolean().optional(),
  valid: z.boolean(),
  assignment_count: int.optional(),
  assignment_header: z.array(z.string()).optional(),
  assignments: z.array(AssignResultRowSchema).optional(),
});
export type AssignResult = z.infer<typeof AssignResultSchema>;

// --- helpers -----------------------------------------------------------------

/**
 * A submission-option value from a /papers object, by option name (the key
 * HotCRP uses); undefined when absent. Throws on an unexpected type.
 */
export function submissionOptionValue(p: Paper, name: string): SubmissionOptionValue | undefined {
  const v = (p as Record<string, unknown>)[name];
  if (v === undefined) return undefined;
  const parsed = SubmissionOptionValueSchema.safeParse(v);
  if (!parsed.success) throw new TypeError(`paper ${p.pid}: option ${JSON.stringify(name)} has unexpected type ${typeof v}`);
  return parsed.data;
}

/**
 * A review-form field value by UID: a score (number, or a letter symbol), text,
 * or null; undefined when the key is absent. Throws on any other type.
 */
export function reviewField(r: Review | ReviewDelta, uid: string): ReviewFieldValue | undefined {
  const v = (r as Record<string, unknown>)[uid];
  if (v === undefined) return undefined;
  const parsed = ReviewFieldValueSchema.safeParse(v);
  if (!parsed.success) throw new TypeError(`review ${r.rid}: field ${uid} has unexpected type ${typeof v}`);
  return parsed.data;
}

/**
 * A score-field (radio/dropdown) value by UID: the symbol, or null for no
 * entry (HotCRP sends false); undefined when the key is absent. Throws on any
 * other type.
 */
export function reviewScore(r: Review | ReviewDelta, uid: string): number | string | null | undefined {
  const v = reviewField(r, uid);
  if (v === false) return null;
  if (v === undefined || v === null || typeof v === "number" || typeof v === "string") return v;
  throw new TypeError(`review ${r.rid}: score field ${uid} has unexpected type ${Array.isArray(v) ? "array" : typeof v}`);
}
