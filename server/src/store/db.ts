// Opening the local store: SQLCipher via better-sqlite3-multiple-ciphers
// (spec §7). The DB holds every review and comment plus reviewer identities,
// so it is encrypted at rest, lives outside the repo by default, and gets a
// 0700 parent directory and a 0600 file.

// The reference carries the module typing to other workspaces that import this file.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./sqlite-types.d.ts" />
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, statSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3-multiple-ciphers";
import { StoreError } from "./errors.js";
import { migrate } from "./migrations.js";

export type Db = Database.Database;
export { StoreError, type StoreErrorKind } from "./errors.js";

export interface OpenDbOptions {
  /** SQLCipher key (PCS_DB_KEY). Undefined = unencrypted (tests only; config enforces this). */
  key: string | undefined;
  /** Open read-only and don't migrate. The file must exist. */
  readonly?: boolean;
  /** Skip migrations (tests of the migration runner). */
  noMigrate?: boolean;
}

export const MEMORY = ":memory:";

/** SQL string literal for a PRAGMA argument (PRAGMAs can't take bound parameters). */
function sqlString(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * Open (creating if needed) the store at `path` and run migrations.
 * Throws StoreError("bad_key") if the key doesn't decrypt the file.
 */
export function openDb(path: string, opts: OpenDbOptions): Db {
  const memory = path === MEMORY;
  if (!memory) {
    if (opts.readonly) {
      if (!existsSync(path)) throw new StoreError("not_found", `no database at ${path}; run \`pcs sync\` first`);
    } else {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      if (!existsSync(path)) closeSync(openSync(path, "wx", 0o600));
      // Tighten an existing file too. -wal/-shm inherit the file's mode.
      if ((statSync(path).mode & 0o077) !== 0) chmodSync(path, 0o600);
    }
  }

  const db = new Database(path, { readonly: opts.readonly ?? false, fileMustExist: opts.readonly ?? false });
  try {
    if (opts.key !== undefined) {
      db.pragma(`cipher=${sqlString("sqlcipher")}`);
      db.pragma(`key=${sqlString(opts.key)}`);
    }
    try {
      // The first read is where a wrong key shows up.
      db.prepare("select count(*) as n from sqlite_master").get();
    } catch (e) {
      if (e instanceof Error && (e as { code?: string }).code === "SQLITE_NOTADB") {
        throw new StoreError(
          "bad_key",
          `cannot open ${memory ? "the database" : path}: wrong PCS_DB_KEY, or not a PC Supervisor database ` +
            "(if the key is lost, delete it with `pcs wipe --yes` and re-sync)",
          { cause: e },
        );
      }
      throw e;
    }
    // Temp tables (sync bookkeeping) stay in memory, never in unencrypted temp files.
    db.pragma("temp_store = MEMORY");
    db.pragma("foreign_keys = ON");
    if (!opts.readonly) {
      if (!memory) db.pragma("journal_mode = WAL");
      db.pragma("secure_delete = ON");
      if (!opts.noMigrate) migrate(db);
    }
    return db;
  } catch (e) {
    db.close();
    throw e;
  }
}
