// Tag writes through HotCRP's assignment API (PLAN M8, spec §1 and §6).
//
// Why POST /assign and not POST /assigntags: /assigntags (src/api/api_tags.php,
// Tags_API::assigntags) only adds tags and executes immediately; it has no
// dry_run. POST /assign (src/api/api_assign.php) runs the same AssignmentSet
// with `dry_run=1` support, and with `format=json` it returns exactly the
// assignments that would change state: a `tag` row for a paper that already
// has the tag, or a `cleartag` row for one that doesn't, is omitted. That
// list is the preview diff.
//
// The body is a JSON array of {pid, action, tag} with the parameters in the
// query string. A form-encoded `assignments=` body also works, but HotCRP at
// 60f693f reads Content-Type from HTTP_CONTENT_TYPE (never set by PHP), so a
// form body trips a PHP warning in Mimetype::is_form(null) that corrupts the
// JSON response wherever display_errors is on (the harness). A JSON body is
// recognized by sniffing and avoids that path.

import { z } from "zod";
import { MessageSchema } from "./schemas.js";

/** HotCRP tag names we write: no `#value`, no `~` (private), no spaces. */
export const WRITABLE_TAG_RE = /^[A-Za-z0-9_.:-]+$/;

export type TagOp = "add" | "remove";

export interface TagChange {
  pid: number;
  op: TagOp;
}

/** One assignment row as POST /assign (format=json) reports it. */
export const TagAssignmentRowSchema = z.object({
  pid: z.number().int().positive(),
  action: z.enum(["tag", "cleartag"]),
  tag: z.string(),
});

export const AssignTagsResultSchema = z.looseObject({
  ok: z.literal(true),
  dry_run: z.boolean().optional(),
  valid: z.boolean(),
  assignment_count: z.number().int().nonnegative().optional(),
  assignments: z.array(TagAssignmentRowSchema).optional(),
  message_list: z.array(MessageSchema).optional(),
});
export type AssignTagsResult = z.infer<typeof AssignTagsResultSchema>;

/** What a tag assignment does (or would do): pids that gain and lose the tag, sorted. */
export interface TagDiff {
  gain: number[];
  lose: number[];
}

/** The request body: one {pid, action, tag} per change. */
export function tagAssignmentBody(changes: readonly TagChange[], tag: string): { pid: number; action: "tag" | "cleartag"; tag: string }[] {
  if (!WRITABLE_TAG_RE.test(tag)) throw new RangeError(`invalid tag ${JSON.stringify(tag)}`);
  if (changes.length === 0) throw new RangeError("no tag changes");
  const seen = new Set<number>();
  return changes.map((c) => {
    if (!Number.isInteger(c.pid) || c.pid < 1) throw new RangeError(`invalid pid ${c.pid}`);
    if (seen.has(c.pid)) throw new RangeError(`pid ${c.pid} listed twice`);
    seen.add(c.pid);
    return { pid: c.pid, action: c.op === "add" ? "tag" : "cleartag", tag };
  });
}

/** The diff HotCRP reported, restricted to `tag` (case-insensitive, as HotCRP compares tags). */
export function tagDiffOf(result: AssignTagsResult, tag: string): TagDiff {
  const gain = new Set<number>();
  const lose = new Set<number>();
  for (const a of result.assignments ?? []) {
    if (a.tag.replace(/#.*$/, "").toLowerCase() !== tag.toLowerCase()) continue;
    (a.action === "tag" ? gain : lose).add(a.pid);
  }
  const sorted = (s: Set<number>) => [...s].sort((a, b) => a - b);
  return { gain: sorted(gain), lose: sorted(lose) };
}
