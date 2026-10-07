// AGENTS.md rule 2: tests, the seeder, and any write path may only talk to
// the local harness. Call assertHarnessUrl() before touching HotCRP from a
// test helper or script.

export class NotHarnessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotHarnessError";
  }
}

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** True if `url` is an http(s) URL on 127.0.0.1, localhost, or [::1]. */
export function isHarnessUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return (u.protocol === "http:" || u.protocol === "https:") && LOCAL_HOSTS.has(u.hostname) && !u.username;
  } catch {
    return false;
  }
}

/**
 * Throw unless PCS_HOTCRP_URL is a local harness URL. Returns the URL.
 * Run `scripts/hotcrp-up.sh`, then `set -a; . ./.env.test; set +a`.
 */
export function assertHarnessUrl(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const url = env.PCS_HOTCRP_URL;
  if (!url) {
    throw new NotHarnessError(
      "PCS_HOTCRP_URL is not set. Start the harness (scripts/hotcrp-up.sh) and load .env.test: set -a; . ./.env.test; set +a",
    );
  }
  if (!isHarnessUrl(url)) {
    let host = "(unparseable)";
    try {
      host = new URL(url).host;
    } catch {
      /* keep placeholder */
    }
    throw new NotHarnessError(
      `Refusing to run: PCS_HOTCRP_URL host ${host} is not 127.0.0.1/localhost. Tests and the seeder only ever target the local harness.`,
    );
  }
  return url;
}
