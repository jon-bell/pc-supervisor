// Redaction for anything that might reach a log, an error message, or stdout.
// The HotCRP token must never appear in any of those (AGENTS.md rule 5).

const TOKEN_PATTERNS: readonly RegExp[] = [
  /\bhct_[A-Za-z0-9_-]+/g, // HotCRP API tokens
  /(Bearer\s+)[^\s"',;]+/gi, // Authorization header values
];

export const REDACTED = "[REDACTED]";

/** Remove `secrets` (exact values) and anything token-shaped from `text`. */
export function redact(text: string, secrets: readonly (string | undefined)[] = []): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 4) out = out.split(s).join(REDACTED);
  }
  for (const re of TOKEN_PATTERNS) {
    out = out.replace(re, (_m, prefix?: string) => (typeof prefix === "string" ? `${prefix}${REDACTED}` : REDACTED));
  }
  return out;
}
