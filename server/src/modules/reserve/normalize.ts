// Identity normalization for reserve compliance (spec §10.4 A, PLAN M11).
//
// The "Reserve designee" option is a free-text field (M10 seeds it with the
// designee's email). Designees are identified by **email**: an email is what
// HotCRP, TPMS, and the invites sheet key people by. Authors also type a name,
// "Name <email>", a mailto: link, or odd case and spacing, so:
// - normalizeEmail() lowercases, trims, and unwraps "Name <x@y>" / mailto:;
// - a value without an email is matched by normalized name against the
//   paper's own author list (identifiedBy "name");
// - names are compared after normalizeName(): accents, case, punctuation, and
//   spacing ignored, and "Last, First" read as "First Last". Names are only
//   used to *group* designations (the inconsistency check) and to resolve a
//   name-only value; they never decide identity on their own.

const EMAIL_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

/** A lowercased email, or null if `s` doesn't contain exactly one plausible email. */
export function normalizeEmail(s: string | null | undefined): string | null {
  if (!s) return null;
  let v = s.trim();
  const angle = /<([^<>]+)>/.exec(v);
  if (angle) v = angle[1]!.trim();
  v = v.replace(/^mailto:/i, "").trim().toLowerCase();
  return EMAIL_RE.test(v) ? v : null;
}

/** A name for comparison: "Ðoan, Kim-Lý" and "kim ly doan" both become "kim ly doan". */
export function normalizeName(s: string | null | undefined): string {
  let v = (s ?? "").trim();
  const comma = /^([^,]+),\s*([^,]+)$/.exec(v);
  if (comma) v = `${comma[2]} ${comma[1]}`;
  return v
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase()
    // DBLP disambiguates homonyms with a numeric suffix ("Kim Park 0002").
    .replace(/\s+\d{4}$/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export type DesigneeValue =
  | { kind: "empty" }
  | { kind: "email"; email: string; name: string | null }
  | { kind: "name"; name: string }
  | { kind: "invalid"; why: string };

/** Parse the designee option's stored value (any JSON type; text is expected). */
export function parseDesignee(raw: unknown): DesigneeValue {
  if (raw === undefined || raw === null) return { kind: "empty" };
  if (typeof raw !== "string") return { kind: "invalid", why: `a ${Array.isArray(raw) ? "list" : typeof raw}, not text` };
  const s = raw.trim();
  if (s === "") return { kind: "empty" };
  const email = normalizeEmail(s);
  if (email) {
    const name = s.includes("<") ? s.slice(0, s.indexOf("<")).replace(/["']/g, "").trim() : "";
    return { kind: "email", email, name: name === "" ? null : name };
  }
  if (s.includes("@")) return { kind: "invalid", why: "not a valid email address" };
  if (!/\p{L}/u.test(s)) return { kind: "invalid", why: "neither an email nor a name" };
  return { kind: "name", name: s };
}

/** An exemption value as compared against PCS_RESERVE_EXEMPTIONS. */
export function normalizeReason(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}
