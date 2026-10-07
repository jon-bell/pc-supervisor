import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, StoreError } from "../../src/store/db.js";
import { MIGRATIONS, SCHEMA_VERSION } from "../../src/store/migrations.js";
import { openStore } from "../../src/store/store.js";
import { dbFiles, wipeDb } from "../../src/store/wipe.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pcs-store-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const KEY = "unit-test-key-not-secret";

describe("openDb", () => {
  it("creates a 0700 parent dir and a 0600 file, and migrates", () => {
    const path = join(dir, "nested", "deeper", "t.db");
    const db = openDb(path, { key: KEY });
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    db.close();
    expect(statSync(join(dir, "nested", "deeper")).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("tightens an existing world-readable file to 0600", () => {
    const path = join(dir, "t.db");
    openDb(path, { key: KEY }).close();
    chmodSync(path, 0o644);
    openDb(path, { key: KEY }).close();
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("encrypts the file: no SQLite header, no plaintext", () => {
    const path = join(dir, "t.db");
    const db = openDb(path, { key: KEY });
    db.prepare("insert into meta (key, value) values ('probe', 'PLAINTEXT-CANARY-123')").run();
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.close();
    const bytes = readFileSync(path);
    expect(bytes.subarray(0, 15).toString("latin1")).not.toBe("SQLite format 3");
    expect(bytes.includes(Buffer.from("PLAINTEXT-CANARY-123"))).toBe(false);
  });

  it("fails with a clear error on the wrong key", () => {
    const path = join(dir, "t.db");
    openDb(path, { key: KEY }).close();
    let err: unknown;
    try {
      openDb(path, { key: "some-other-key" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(StoreError);
    expect(err).toMatchObject({ kind: "bad_key" });
    expect((err as Error).message).toMatch(/wrong PCS_DB_KEY/);
    expect((err as Error).message).not.toContain("some-other-key");
    expect((err as Error).message).not.toContain(KEY);
  });

  it("fails when an encrypted DB is opened without a key", () => {
    const path = join(dir, "t.db");
    openDb(path, { key: KEY }).close();
    expect(() => openDb(path, { key: undefined })).toThrow(StoreError);
  });

  it("re-opens with the right key and keeps data", () => {
    const path = join(dir, "t.db");
    const a = openDb(path, { key: KEY });
    a.prepare("insert into meta (key, value) values ('k', 'v')").run();
    a.close();
    const b = openDb(path, { key: KEY });
    expect(b.prepare("select value from meta where key = 'k'").get()).toEqual({ value: "v" });
    b.close();
  });

  it("refuses a DB from a newer schema", () => {
    const path = join(dir, "t.db");
    const a = openDb(path, { key: KEY });
    a.pragma(`user_version = ${MIGRATIONS.length + 1}`);
    a.close();
    expect(() => openDb(path, { key: KEY })).toThrow(/newer than this build supports/);
  });

  it("readonly open of a missing file is a clear error", () => {
    expect(() => openDb(join(dir, "missing.db"), { key: KEY, readonly: true })).toThrow(/run `pcs sync` first/);
  });

  it("migrating twice is a no-op", () => {
    const path = join(dir, "t.db");
    openDb(path, { key: KEY }).close();
    const db = openDb(path, { key: KEY });
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    db.close();
  });

  it("openStore uses cfg.db", () => {
    const path = join(dir, "s.db");
    const s = openStore({ db: { path, key: KEY } });
    expect(s.papers()).toEqual([]);
    expect(s.lastSync()).toBeUndefined();
    s.close();
  });
});

describe("wipe", () => {
  it("deletes the DB and its sidecars", () => {
    const path = join(dir, "t.db");
    const db = openDb(path, { key: KEY });
    db.prepare("insert into meta (key, value) values ('k', 'v')").run();
    // While open in WAL mode, -wal and -shm exist.
    expect(dbFiles(path).sort()).toEqual([path, `${path}-shm`, `${path}-wal`].sort());
    db.close();
    writeFileSync(`${path}-journal`, "");
    const removed = wipeDb(path);
    expect(removed).toContain(path);
    expect(removed).toContain(`${path}-journal`);
    for (const f of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) expect(existsSync(f)).toBe(false);
    expect(wipeDb(path)).toEqual([]);
  });
});
