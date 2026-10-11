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

// --- Is it the disposable harness? ------------------------------------------
// A hostname check alone passes an SSH port-forward from a real instance onto
// 127.0.0.1. Test helpers that write also check (harness-verify.ts) that the
// token belongs to the harness's own chair and that the URL's port is the one
// the harness's compose project publishes.

type Env = Readonly<Record<string, string | undefined>>;

/** The chair account scripts/hotcrp-up.sh creates (HOTCRP_ADMIN_EMAIL, default admin@example.org). */
export function harnessAdminEmail(env: Env = process.env): string {
  return env.HOTCRP_ADMIN_EMAIL || "admin@example.org";
}

/** The harness's compose project (HOTCRP_COMPOSE_PROJECT from .env.test, else COMPOSE_PROJECT_NAME, else "pcs"). */
export function harnessProject(env: Env = process.env): string {
  return env.HOTCRP_COMPOSE_PROJECT || env.COMPOSE_PROJECT_NAME || "pcs";
}

/** Throw unless the token's account (from /whoami) is the harness chair. */
export function checkHarnessAdmin(email: string, env: Env = process.env): void {
  const want = harnessAdminEmail(env);
  if (email.toLowerCase() !== want.toLowerCase()) {
    throw new NotHarnessError(
      `Refusing to run: the token belongs to ${email || "(no email)"}, not the harness chair ${want}. Is PCS_HOTCRP_URL a port-forward to a real instance?`,
    );
  }
}

/**
 * Throw unless `publishedAddress` (from `docker compose port hotcrp 80`, e.g.
 * "127.0.0.1:18082") carries the same port as `url`, so batch/SQL writes and
 * API writes hit the same, disposable instance.
 */
export function checkPublishedPort(publishedAddress: string, url: string, project: string): void {
  const u = new URL(url);
  const port = u.port || (u.protocol === "https:" ? "443" : "80");
  const addr = publishedAddress.trim();
  const m = /:(\d+)$/.exec(addr);
  if (!m || m[1] !== port) {
    throw new NotHarnessError(`Refusing to run: compose project "${project}" publishes ${addr || "(nothing)"}, but PCS_HOTCRP_URL is ${u.host}`);
  }
}
