// The full harness check for test helpers that write (AGENTS.md rules 2 and 3).
// Tooling only: the app never imports this (it spawns docker).
//
//   1. PCS_HOTCRP_URL is 127.0.0.1/localhost (assertHarnessUrl);
//   2. the harness's compose project publishes the URL's port;
//   3. GET /whoami says the token is the harness chair (admin@example.org).
//
// (2) and (3) catch an SSH port-forward from a real instance onto 127.0.0.1.

import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertHarnessUrl, checkHarnessAdmin, checkPublishedPort, harnessProject, NotHarnessError } from "./harness-guard.js";
import { WhoamiSchema } from "./schemas.js";

type Env = Readonly<Record<string, string | undefined>>;

const COMPOSE_FILE = fileURLToPath(new URL("../../../hotcrp/compose.yaml", import.meta.url));

export interface HarnessProbe {
  /** The email of the token's account, from GET /api/whoami. */
  whoamiEmail(url: string, token: string): Promise<string>;
  /** `docker compose -p <project> port hotcrp 80`, e.g. "127.0.0.1:18082". */
  publishedAddress(project: string): Promise<string>;
}

/**
 * fetch, retrying a 429 (HotCRP's 250/min limit; the request was refused, so a
 * retry is safe even for a write) after Retry-After, up to `tries` times. For
 * harness tooling, which seeds in bursts; the app's client has its own retries.
 */
export async function fetchRetrying429(input: string | URL, init: RequestInit, tries = 8): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(input, init);
    if (res.status !== 429 || attempt >= tries) return res;
    await res.body?.cancel();
    const ra = Number(res.headers.get("retry-after") ?? "");
    await new Promise((r) => setTimeout(r, Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1000 * 2 ** attempt));
  }
}

export const defaultProbe: HarnessProbe = {
  async whoamiEmail(url, token) {
    const res = await fetchRetrying429(`${url.replace(/\/+$/, "")}/api/whoami?pretty=0`, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: "error",
    });
    if (!res.ok) throw new NotHarnessError(`Refusing to run: GET /whoami answered HTTP ${res.status}`);
    const parsed = WhoamiSchema.safeParse(await res.json());
    if (!parsed.success) throw new NotHarnessError("Refusing to run: GET /whoami did not return an account");
    return parsed.data.email;
  },
  publishedAddress(project) {
    return new Promise((resolve, reject) => {
      execFile("docker", ["compose", "-p", project, "-f", COMPOSE_FILE, "port", "hotcrp", "80"], (err, stdout, stderr) => {
        if (err) {
          const why = (stderr || err.message).trim();
          reject(
            new NotHarnessError(
              `Refusing to run: can't find the harness's compose project "${project}" (set HOTCRP_COMPOSE_PROJECT, as .env.test does): ${why}`,
            ),
          );
        } else resolve(stdout.trim());
      });
    });
  },
};

/** Run all three checks; resolves to PCS_HOTCRP_URL. Throws NotHarnessError. */
export async function verifyHarness(env: Env = process.env, probe: HarnessProbe = defaultProbe): Promise<string> {
  const url = assertHarnessUrl(env);
  const token = env.PCS_HOTCRP_TOKEN;
  if (!token) throw new NotHarnessError("PCS_HOTCRP_TOKEN is not set; load .env.test: set -a; . ./.env.test; set +a");
  const project = harnessProject(env);
  checkPublishedPort(await probe.publishedAddress(project), url, project);
  checkHarnessAdmin(await probe.whoamiEmail(url, token), env);
  return url;
}

const verified = new Map<string, Promise<string>>();

/** verifyHarness() with the default probe, at most once per URL, project and token in this process. */
export function verifyHarnessOnce(env: Env = process.env): Promise<string> {
  const key = JSON.stringify([env.PCS_HOTCRP_URL, harnessProject(env), env.HOTCRP_ADMIN_EMAIL, env.PCS_HOTCRP_TOKEN]);
  let p = verified.get(key);
  if (!p) {
    p = verifyHarness(env);
    verified.set(key, p);
    p.catch(() => verified.delete(key));
  }
  return p;
}

/** A fetch that runs verifyHarnessOnce() before its first request (for harness clients). */
export function verifiedFetch(env: Env = process.env): typeof globalThis.fetch {
  return async (input, init) => {
    await verifyHarnessOnce(env);
    return fetch(input, init);
  };
}
