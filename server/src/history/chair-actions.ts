// chair_action (migration 7): the chair's confirmed HotCRP tag writes
// (PLAN M8), one row per paper, recorded after the write succeeds. Shown in
// the paper's flag timeline and the flag-history feed.

import type { Db } from "../store/db.js";

export interface ChairAction {
  id: number;
  /** Epoch ms. */
  at: number;
  actor: string;
  kind: "tag" | "untag";
  tag: string;
  pid: number;
}

export function recordTagWrite(db: Db, o: { atMs: number; actor: string; tag: string; gain: readonly number[]; lose: readonly number[] }): number {
  const at = Math.floor(o.atMs / 1000);
  const ins = db.prepare("insert into chair_action (at, actor, kind, tag, pid) values (?, ?, ?, ?, ?)");
  return db.transaction(() => {
    for (const pid of o.gain) ins.run(at, o.actor, "tag", o.tag, pid);
    for (const pid of o.lose) ins.run(at, o.actor, "untag", o.tag, pid);
    return o.gain.length + o.lose.length;
  })();
}

export function chairActions(db: Db, q: { pid?: number; pids?: readonly number[]; before?: number; limit?: number } = {}): ChairAction[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (q.pid !== undefined) {
    where.push("pid = ?");
    args.push(q.pid);
  }
  if (q.pids) {
    where.push("pid in (select value from json_each(?))");
    args.push(JSON.stringify(q.pids));
  }
  if (q.before !== undefined) {
    where.push("at < ?");
    args.push(Math.floor(q.before / 1000));
  }
  args.push(q.limit ?? 1000);
  const rows = db
    .prepare(`select id, at, actor, kind, tag, pid from chair_action ${where.length ? `where ${where.join(" and ")}` : ""} order by at desc, id desc limit ?`)
    .all(...args) as ChairAction[];
  return rows.map((r) => ({ ...r, at: r.at * 1000 }));
}
