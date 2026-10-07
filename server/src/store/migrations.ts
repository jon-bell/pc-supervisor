// Forward-only, numbered schema migrations. PRAGMA user_version holds the
// number of migrations applied. Never edit a shipped migration: append a new
// one. See README.md in this directory for what each table means.
//
// Conventions:
// - Times are integer epoch seconds. `*_seen_at` times come from the app
//   clock (clock.ts, PCS_NOW); `modified_at` is HotCRP's own timestamp.
// - `*_approx = 1` marks a time that is a best guess (items already present
//   at the first sync take HotCRP's modified_at, spec §1).
// - Nothing is ever deleted by sync: disappearances set deleted_seen_at /
//   removed_seen_at.
// - Emails are stored lowercased.
// - JSON columns hold arrays/objects as text.

import type { Db } from "./db.js";
import { StoreError } from "./errors.js";

export const MIGRATIONS: readonly string[] = [
  // 1: initial schema (spec §3)
  `
  create table meta (
    key text primary key,
    value text not null
  ) strict;

  -- Review-form fields from get/jsonrqc; uid = the key used in /reviews.
  create table review_field (
    uid text primary key,
    name text not null,
    type text not null,
    is_text integer not null,
    ord integer,
    values_json text,
    first_seen_at integer not null,
    removed_seen_at integer
  ) strict;

  create table person (
    email text primary key,
    name text,
    affiliation text,
    is_pc integer not null default 0,
    roles text not null default '[]',
    tags text not null default '[]',
    tier text not null default 'senior',
    first_seen_at integer not null,
    removed_seen_at integer
  ) strict;

  create table paper (
    pid integer primary key,
    title text,
    status text,
    decision text,
    tags text not null default '[]',
    lead text,
    shepherd text,
    manager text,
    first_seen_at integer not null,
    synced_at integer not null,
    deleted_seen_at integer
  ) strict;

  create table assignment (
    pid integer not null,
    email text not null,
    role text not null check (role in ('meta','primary','secondary','pc','external','lead','shepherd','manager')),
    round text,
    first_seen_at integer not null,
    first_seen_approx integer not null default 0,
    removed_seen_at integer,
    primary key (pid, email, role)
  ) strict, without rowid;
  create index assignment_email on assignment(email);

  create table review (
    rid integer primary key,
    pid integer not null,
    email text not null,
    rtype integer,
    status text not null,
    round text,
    ordinal text,
    vtag integer,
    modified_at integer,
    first_seen_at integer not null,
    first_seen_approx integer not null default 0,
    first_complete_seen_at integer,
    first_complete_approx integer not null default 0,
    scores text not null default '{}',
    word_count integer not null default 0,
    ratings text not null default '[]',
    deleted_seen_at integer
  ) strict;
  create index review_pid on review(pid);
  create index review_email on review(email);

  -- One row per distinct vtag. source: snapshot (seen by a sync) or history
  -- (from /reviewhistory backfill). seen_at: sync time for snapshots; the
  -- version's modified_at (approximate, maybe null) for history rows.
  create table review_version (
    id integer primary key,
    rid integer not null,
    vtag integer not null,
    seen_at integer,
    seen_approx integer not null default 0,
    source text not null check (source in ('snapshot','history')),
    status text not null,
    modified_at integer,
    scores text not null,
    word_count integer,
    sync_run_id integer,
    unique (rid, vtag)
  ) strict;

  create table review_text (
    id integer primary key,
    rid integer not null,
    vtag integer not null,
    field_uid text not null,
    text text not null,
    unique (rid, vtag, field_uid)
  ) strict;

  create table comment (
    cid integer primary key,
    pid integer not null,
    email text,
    topic text,
    visibility text not null,
    is_response integer not null,
    response_round text,
    draft integer not null,
    by_author integer not null,
    by_shepherd integer not null,
    tags text not null default '[]',
    word_count integer not null,
    mentions text not null default '[]',
    text_hash text not null,
    modified_at integer,
    first_seen_at integer not null,
    first_seen_approx integer not null default 0,
    deleted_seen_at integer
  ) strict;
  create index comment_pid on comment(pid);
  create index comment_email on comment(email);

  -- One row per observed text version of a comment.
  create table comment_text (
    id integer primary key,
    cid integer not null,
    modified_at integer,
    seen_at integer not null,
    text text not null,
    sync_run_id integer
  ) strict;
  create index comment_text_cid on comment_text(cid);

  create table comment_mention (
    cid integer not null,
    email text not null,
    primary key (cid, email)
  ) strict, without rowid;
  create index comment_mention_email on comment_mention(email);

  create table sync_run (
    id integer primary key,
    kind text not null default 'sync' check (kind in ('sync','backfill')),
    started_at integer not null,
    finished_at integer,
    now_used integer not null,
    ok integer,
    counts text not null default '{}',
    errors text not null default '[]'
  ) strict;

  create table history_backfill (
    rid integer primary key,
    done_at integer not null,
    versions integer not null,
    sync_run_id integer
  ) strict;

  -- Full-text index over review_text and comment_text, contentless (the text
  -- lives once, in those tables). rowid = review_text.id*2 or comment_text.id*2+1.
  create virtual table text_fts using fts5(
    text, content='', contentless_delete=1, tokenize='unicode61 remove_diacritics 2'
  );
  create trigger review_text_fts_ai after insert on review_text begin
    insert into text_fts(rowid, text) values (new.id * 2, new.text);
  end;
  create trigger review_text_fts_ad after delete on review_text begin
    delete from text_fts where rowid = old.id * 2;
  end;
  create trigger comment_text_fts_ai after insert on comment_text begin
    insert into text_fts(rowid, text) values (new.id * 2 + 1, new.text);
  end;
  create trigger comment_text_fts_ad after delete on comment_text begin
    delete from text_fts where rowid = old.id * 2 + 1;
  end;
  `,

  // 2 (M5): when the sync first saw a paper's current decision. HotCRP
  // exposes no decision timestamp; the burndown and triage list need one.
  // Decisions already present at the first sync are approximate.
  `
  alter table paper add column decision_seen_at integer;
  alter table paper add column decision_seen_approx integer not null default 0;
  update paper set decision_seen_at = first_seen_at, decision_seen_approx = 1 where decision is not null;
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

/** Apply pending migrations, each in its own transaction. */
export function migrate(db: Db): number {
  const current = db.pragma("user_version", { simple: true }) as number;
  if (current > MIGRATIONS.length) {
    throw new StoreError(
      "newer_schema",
      `database schema version ${current} is newer than this build supports (${MIGRATIONS.length}); upgrade pc-supervisor`,
    );
  }
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
  return MIGRATIONS.length - current;
}
