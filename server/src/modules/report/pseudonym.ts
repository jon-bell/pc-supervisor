// Pseudonymous IDs (spec §10.4 G, PLAN M13): HMAC-SHA256 of the normalized
// email, keyed with the chair-held PCS_PSEUDONYM_KEY. Stable for a given key,
// different across keys, and not reversible without the key. (Whoever holds
// the key can recompute the pseudonym of any email they already know: that is
// what lets next year's chair join their export to this one.)

import { createHmac } from "node:crypto";

export class PseudonymKeyMissingError extends Error {
  constructor() {
    super(
      "PCS_PSEUDONYM_KEY is not set, so the pseudonymous export cannot run. " +
        "Every exported row carries HMAC-SHA256(PCS_PSEUDONYM_KEY, email) instead of the email. " +
        "Set it to a long random secret (at least 16 characters, e.g. the output of `openssl rand -hex 32`), keep it private, " +
        "and reuse it for later conferences so their exports join on the same pseudonyms.",
    );
    this.name = "PseudonymKeyMissingError";
  }
}

/** Trim, lowercase, Unicode NFC: one pseudonym per mailbox however it was typed. */
export function normalizeEmail(email: string): string {
  return email.normalize("NFC").trim().toLowerCase();
}

/** 64 lowercase hex characters. */
export const PSEUDONYM_RE = /^[0-9a-f]{64}$/;
/** Paper pseudonyms are shorter (16 hex): only unique within one export. */
export const PAPER_ID_RE = /^[0-9a-f]{16}$/;

export interface Pseudonymizer {
  person(email: string): string;
  paper(pid: number): string;
  /** A short public fingerprint of the key, to check two exports used the same one. */
  keyId: string;
}

function hmac(key: string, msg: string): string {
  return createHmac("sha256", key).update(msg, "utf8").digest("hex");
}

/** HMAC-SHA256(key, normalized email), hex. */
export function pseudonym(key: string, email: string): string {
  return hmac(key, normalizeEmail(email));
}

export function keyId(key: string): string {
  return hmac(key, "pcs-pseudonym-key-id").slice(0, 12);
}

export function pseudonymizer(key: string | undefined): Pseudonymizer {
  if (!key) throw new PseudonymKeyMissingError();
  const cache = new Map<string, string>();
  return {
    person(email) {
      let p = cache.get(email);
      if (p === undefined) cache.set(email, (p = pseudonym(key, email)));
      return p;
    },
    // A distinct message space ("paper:" prefix; an email can't start with it and have no "@").
    paper: (pid) => hmac(key, `paper:${pid}`).slice(0, 16),
    keyId: keyId(key),
  };
}
