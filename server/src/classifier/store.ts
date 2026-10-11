// Comment-type tables (migration 9; spec §5e). Everything here stays in the
// encrypted store: labels, embeddings of real comments, the chair's labels
// and their audit trail.

import type { AcRole } from "../config.js";
import type { Store } from "../store/store.js";
import type { Db } from "../store/db.js";
import { textHash } from "../sync/text.js";
import { blobToVec, vecToBlob } from "./embedder.js";
import type { StructuralFeatures } from "./features.js";
import { isCommentKind, type CommentKind, type LabelSource, type Prediction } from "./kinds.js";

/** meta key bumped on every label write, so cached analyses re-read the labels. */
const GEN_KEY = "comment_labels_gen";

export function labelGeneration(db: Db): number {
  const r = db.prepare("select value from meta where key = ?").get(GEN_KEY) as { value: string } | undefined;
  return r ? Number(r.value) : 0;
}

export function bumpLabelGeneration(db: Db): void {
  db.prepare("insert into meta (key, value) values (?, '1') on conflict(key) do update set value = cast(cast(value as integer) + 1 as text)").run(GEN_KEY);
}

export interface PendingComment {
  cid: number;
  pid: number;
  textHash: string;
}

/**
 * Published, non-response, live comments whose current text has no label from
 * `head` yet (new, edited, or labelled by another classifier/head).
 */
export function pendingComments(db: Db, head: string): PendingComment[] {
  return (
    db
      .prepare(
        `select c.cid, c.pid, c.text_hash from comment c
           left join comment_class k on k.cid = c.cid
          where c.deleted_seen_at is null and c.draft = 0 and c.is_response = 0
            and (k.cid is null or k.text_hash <> c.text_hash or k.head <> ?)
          order by c.pid, c.cid`,
      )
      .all(head) as { cid: number; pid: number; text_hash: string }[]
  ).map((r) => ({ cid: r.cid, pid: r.pid, textHash: r.text_hash }));
}

export interface PaperItem {
  kind: "comment" | "review";
  /** cid or rid. */
  id: number;
  email: string;
  /** Epoch ms (earliest known time for a comment; first submission for a review). */
  at: number;
  text: string;
}

/** One paper's comments (current text) and submitted reviews (current text), time order, plus its ACs and lead. */
export function paperContext(store: Store, pid: number, acRole: AcRole): { items: PaperItem[]; acs: Set<string> } {
  const db = store.db;
  const comments = db
    .prepare(
      `select c.cid, c.email,
              min(c.first_seen_at, coalesce((select min(t.modified_at) from comment_text t where t.cid = c.cid), c.first_seen_at)) as at,
              (select t.text from comment_text t where t.cid = c.cid order by t.id desc limit 1) as text
         from comment c
        where c.pid = ? and c.deleted_seen_at is null and c.draft = 0`,
    )
    .all(pid) as { cid: number; email: string | null; at: number; text: string | null }[];
  const reviews = db
    .prepare(
      `select r.rid, r.email,
              coalesce((select min(coalesce(v.modified_at, v.seen_at)) from review_version v
                         where v.rid = r.rid and v.status in ('delivered','approved','complete')),
                       r.first_complete_seen_at, r.modified_at) as at,
              (select group_concat(t.text, char(10)) from review_text t where t.rid = r.rid and t.vtag = r.vtag) as text
         from review r
        where r.pid = ? and r.deleted_seen_at is null and r.status in ('delivered','approved','complete')`,
    )
    .all(pid) as { rid: number; email: string; at: number | null; text: string | null }[];
  const items: PaperItem[] = [
    ...comments.map((c) => ({ kind: "comment" as const, id: c.cid, email: (c.email ?? "").toLowerCase(), at: c.at * 1000, text: c.text ?? "" })),
    ...reviews.filter((r) => r.at !== null).map((r) => ({ kind: "review" as const, id: r.rid, email: r.email.toLowerCase(), at: r.at! * 1000, text: r.text ?? "" })),
  ].sort((a, b) => a.at - b.at || (a.kind === b.kind ? a.id - b.id : a.kind === "review" ? -1 : 1));
  const acs = new Set(store.areaChairs(acRole, { pids: [pid] }).map((a) => a.email.toLowerCase()));
  for (const r of db.prepare("select email from assignment where pid = ? and role = 'lead' and removed_seen_at is null").all(pid) as { email: string }[]) {
    acs.add(r.email.toLowerCase());
  }
  return { items, acs };
}

export interface ClassRow {
  cid: number;
  textHash: string;
  source: "heuristic" | "model";
  prediction: Prediction;
  head: string;
  features: StructuralFeatures;
}

export function writeClasses(db: Db, rows: readonly ClassRow[], atMs: number): void {
  if (rows.length === 0) return;
  const st = db.prepare(
    `insert into comment_class (cid, text_hash, source, kind, confidence, probs, head, features, classified_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict(cid) do update set text_hash = excluded.text_hash, source = excluded.source, kind = excluded.kind,
       confidence = excluded.confidence, probs = excluded.probs, head = excluded.head, features = excluded.features,
       classified_at = excluded.classified_at`,
  );
  db.transaction(() => {
    for (const r of rows) {
      st.run(r.cid, r.textHash, r.source, r.prediction.kind, r.prediction.confidence, JSON.stringify(r.prediction.probs), r.head, JSON.stringify(r.features), Math.floor(atMs / 1000));
    }
    bumpLabelGeneration(db);
  })();
}

export interface StoredEmbedding {
  vec: Float32Array;
  features: StructuralFeatures;
}

export function getEmbeddings(db: Db, model: string, keys: readonly { cid: number; textHash: string }[]): Map<number, StoredEmbedding> {
  const st = db.prepare("select vec, features from comment_embedding where cid = ? and text_hash = ? and model = ?");
  const out = new Map<number, StoredEmbedding>();
  for (const k of keys) {
    const r = st.get(k.cid, k.textHash, model) as { vec: Buffer; features: string } | undefined;
    if (r) out.set(k.cid, { vec: blobToVec(r.vec), features: JSON.parse(r.features) as StructuralFeatures });
  }
  return out;
}

export function putEmbeddings(db: Db, model: string, rows: readonly { cid: number; textHash: string; vec: Float32Array; features: StructuralFeatures }[]): void {
  const st = db.prepare(
    `insert into comment_embedding (cid, text_hash, model, dim, vec, features) values (?, ?, ?, ?, ?, ?)
     on conflict(cid, text_hash, model) do update set vec = excluded.vec, features = excluded.features, dim = excluded.dim`,
  );
  db.transaction(() => {
    for (const r of rows) st.run(r.cid, r.textHash, model, r.vec.length, vecToBlob(r.vec), JSON.stringify(r.features));
  })();
}

/** Drop embeddings of comment versions that are no longer current and that the chair didn't label. */
export function pruneEmbeddings(db: Db): number {
  return db
    .prepare(
      `delete from comment_embedding where not exists (select 1 from comment c where c.cid = comment_embedding.cid and c.text_hash = comment_embedding.text_hash and c.deleted_seen_at is null)
         and not exists (select 1 from comment_chair_label l where l.cid = comment_embedding.cid and l.text_hash = comment_embedding.text_hash)`,
    )
    .run().changes;
}

// ---------------------------------------------------------------------------
// The chair's labels

export interface ChairLabel {
  cid: number;
  pid: number;
  textHash: string;
  kind: CommentKind;
  revisionId: number;
}

export function chairLabels(db: Db): ChairLabel[] {
  return (
    db
      .prepare("select l.cid, coalesce(c.pid, 0) as pid, l.text_hash, l.kind, l.revision_id from comment_chair_label l left join comment c on c.cid = l.cid order by l.cid")
      .all() as { cid: number; pid: number; text_hash: string; kind: string; revision_id: number }[]
  )
    .filter((r) => isCommentKind(r.kind))
    .map((r) => ({ cid: r.cid, pid: r.pid, textHash: r.text_hash, kind: r.kind as CommentKind, revisionId: r.revision_id }));
}

/** The latest relabel id (0 = none); part of the model head's id, so a relabel retrains. */
export function latestLabelRevision(db: Db): number {
  return (db.prepare("select coalesce(max(id), 0) as id from comment_label_revision").get() as { id: number }).id;
}

export interface EffectiveLabel {
  kind: CommentKind;
  source: LabelSource;
  /** 1 for the chair's own label. */
  confidence: number;
  probs: Record<string, number> | null;
  /** The classifier's label underneath a chair label (null if none or the same). */
  classifier: { kind: CommentKind; source: "heuristic" | "model"; confidence: number } | null;
}

/** Effective labels (chair's, else the classifier's) for the current text of these comments. */
export function effectiveLabels(db: Db, cids: readonly number[]): Map<number, EffectiveLabel> {
  const out = new Map<number, EffectiveLabel>();
  if (cids.length === 0) return out;
  const rows = db
    .prepare(
      `select c.cid, k.kind as k_kind, k.source as k_source, k.confidence as k_conf, k.probs as k_probs, l.kind as l_kind
         from comment c
         left join comment_class k on k.cid = c.cid and k.text_hash = c.text_hash
         left join comment_chair_label l on l.cid = c.cid and l.text_hash = c.text_hash
        where c.cid in (select value from json_each(?))`,
    )
    .all(JSON.stringify(cids)) as { cid: number; k_kind: string | null; k_source: "heuristic" | "model" | null; k_conf: number | null; k_probs: string | null; l_kind: string | null }[];
  for (const r of rows) {
    const cls = r.k_kind && isCommentKind(r.k_kind) ? { kind: r.k_kind, source: r.k_source!, confidence: r.k_conf! } : null;
    if (r.l_kind && isCommentKind(r.l_kind)) {
      out.set(r.cid, { kind: r.l_kind, source: "chair", confidence: 1, probs: null, classifier: cls });
    } else if (cls) {
      out.set(r.cid, { kind: cls.kind, source: cls.source, confidence: cls.confidence, probs: r.k_probs ? (JSON.parse(r.k_probs) as Record<string, number>) : null, classifier: null });
    }
  }
  return out;
}

export interface LabelRevision {
  id: number;
  at: number;
  actor: string;
  cid: number;
  pid: number;
  kind: CommentKind | null;
  previous: string | null;
  previousSource: string | null;
}

const revisionOf = (r: Record<string, unknown>): LabelRevision => ({
  id: r.id as number,
  at: (r.at as number) * 1000,
  actor: r.actor as string,
  cid: r.cid as number,
  pid: r.pid as number,
  kind: isCommentKind(r.kind) ? r.kind : null,
  previous: (r.previous as string | null) ?? null,
  previousSource: (r.previous_source as string | null) ?? null,
});

export function labelRevisions(db: Db, o: { cid?: number; limit?: number } = {}): LabelRevision[] {
  const rows = (
    o.cid === undefined
      ? db.prepare("select * from comment_label_revision order by id desc limit ?").all(o.limit ?? 200)
      : db.prepare("select * from comment_label_revision where cid = ? order by id desc limit ?").all(o.cid, o.limit ?? 200)
  ) as Record<string, unknown>[];
  return rows.map(revisionOf);
}

export class RelabelError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "RelabelError";
  }
}

/**
 * The chair relabels a comment (kind), or clears their label (null = back to
 * the classifier). Appends an audit row; no HotCRP call. Throws RelabelError
 * for an unknown comment (404), a non-labellable one (400), or no change (409).
 */
export function relabel(db: Db, o: { cid: number; kind: CommentKind | null; actor: string; atMs: number }): LabelRevision {
  const c = db.prepare("select cid, pid, text_hash, is_response, draft, deleted_seen_at from comment where cid = ?").get(o.cid) as
    | { cid: number; pid: number; text_hash: string; is_response: number; draft: number; deleted_seen_at: number | null }
    | undefined;
  if (!c || c.deleted_seen_at !== null) throw new RelabelError(404, `no comment #${o.cid} in the local store`);
  if (c.is_response || c.draft) throw new RelabelError(400, "author responses and drafts are not classified");
  const before = effectiveLabels(db, [o.cid]).get(o.cid);
  const current = db.prepare("select kind from comment_chair_label where cid = ? and text_hash = ?").get(o.cid, c.text_hash) as { kind: string } | undefined;
  if (o.kind === null ? !current : current?.kind === o.kind) throw new RelabelError(409, o.kind === null ? "this comment has no label of yours to clear" : `already labelled ${o.kind}`);
  return db.transaction(() => {
    const info = db
      .prepare("insert into comment_label_revision (at, actor, cid, pid, text_hash, kind, previous, previous_source) values (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(Math.floor(o.atMs / 1000), o.actor, c.cid, c.pid, c.text_hash, o.kind, before?.kind ?? null, before?.source ?? null);
    const id = Number(info.lastInsertRowid);
    if (o.kind === null) db.prepare("delete from comment_chair_label where cid = ?").run(c.cid);
    else
      db.prepare(
        "insert into comment_chair_label (cid, text_hash, kind, revision_id) values (?, ?, ?, ?) on conflict(cid) do update set text_hash = excluded.text_hash, kind = excluded.kind, revision_id = excluded.revision_id",
      ).run(c.cid, c.text_hash, o.kind, id);
    bumpLabelGeneration(db);
    return revisionOf(db.prepare("select * from comment_label_revision where id = ?").get(id) as Record<string, unknown>);
  })();
}

/** The text of a comment version (current or historical), by its hash; undefined if no longer stored. */
export function commentVersionText(db: Db, cid: number, hash: string): string | undefined {
  for (const r of db.prepare("select text from comment_text where cid = ? order by id desc").all(cid) as { text: string }[]) {
    if (textHash(r.text) === hash) return r.text;
  }
  return undefined;
}

/** Counts for the status line. */
export function labelCounts(db: Db): { comments: number; labelled: number; bySource: Record<string, number>; byKind: Record<string, number>; chair: number } {
  const comments = (db.prepare("select count(*) as n from comment where deleted_seen_at is null and draft = 0 and is_response = 0").get() as { n: number }).n;
  const rows = db
    .prepare(
      `select k.source, k.kind, count(*) as n from comment c join comment_class k on k.cid = c.cid and k.text_hash = c.text_hash
        where c.deleted_seen_at is null and c.draft = 0 and c.is_response = 0 group by k.source, k.kind`,
    )
    .all() as { source: string; kind: string; n: number }[];
  const bySource: Record<string, number> = {};
  const byKind: Record<string, number> = {};
  let labelled = 0;
  for (const r of rows) {
    labelled += r.n;
    bySource[r.source] = (bySource[r.source] ?? 0) + r.n;
    byKind[r.kind] = (byKind[r.kind] ?? 0) + r.n;
  }
  const chair = (db.prepare("select count(*) as n from comment_chair_label l join comment c on c.cid = l.cid and c.text_hash = l.text_hash where c.deleted_seen_at is null").get() as { n: number }).n;
  return { comments, labelled, bySource, byKind, chair };
}
