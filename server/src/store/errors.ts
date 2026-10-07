// Errors from the local store. Messages never include the DB key or content.

export type StoreErrorKind = "bad_key" | "newer_schema" | "not_found";

export class StoreError extends Error {
  readonly kind: StoreErrorKind;
  constructor(kind: StoreErrorKind, message: string, opts?: { cause?: unknown }) {
    super(message, opts);
    this.name = "StoreError";
    this.kind = kind;
  }
}
