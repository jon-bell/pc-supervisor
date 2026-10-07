// better-sqlite3-multiple-ciphers ships index.d.ts but its package.json
// "exports" hides it from NodeNext resolution. Its API is better-sqlite3's
// (it is a fork), so borrow @types/better-sqlite3. Cipher settings go through
// db.pragma(), which those types cover.
declare module "better-sqlite3-multiple-ciphers" {
  import Database from "better-sqlite3";
  export default Database;
}
