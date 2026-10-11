// `pcs wipe`: delete the DB file and its SQLite sidecars (spec §7).

import { existsSync, rmSync } from "node:fs";

export const DB_SIDECARS = ["", "-wal", "-shm", "-journal"] as const;

/** Existing files that make up the DB at `path`. */
export function dbFiles(path: string): string[] {
  return DB_SIDECARS.map((s) => `${path}${s}`).filter((p) => existsSync(p));
}

/** Delete the DB and sidecars. Returns the paths removed. */
export function wipeDb(path: string): string[] {
  const files = dbFiles(path);
  for (const f of files) rmSync(f, { force: true });
  return files;
}
