// The harness's Docker side: batch scripts in the hotcrp container and SQL in
// the db container (`docker compose exec`). Only ever the local harness
// defined by hotcrp/compose.yaml; checkHarnessMatchesUrl() makes sure the
// compose project is the same instance PCS_HOTCRP_URL points at.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkPublishedPort, harnessProject } from "@pcs/server/hotcrp/harness-guard";

export const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const COMPOSE_FILE = fileURLToPath(new URL("../../hotcrp/compose.yaml", import.meta.url));

export interface DockerOptions {
  /** Compose project (HOTCRP_COMPOSE_PROJECT from .env.test, else COMPOSE_PROJECT_NAME, else "pcs"). */
  project: string;
  /** MariaDB database name (HOTCRP_DB_NAME, default hotcrp). */
  dbName: string;
}

export function dockerOptionsFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): DockerOptions {
  return {
    project: harnessProject(env),
    dbName: env.HOTCRP_DB_NAME || "hotcrp",
  };
}

export class DockerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DockerError";
  }
}

function run(args: readonly string[], input?: string | Buffer): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (b: Buffer) => out.push(b));
    child.stderr.on("data", (b: Buffer) => err.push(b));
    child.on("error", (e) => reject(new DockerError(`docker: ${e.message}`)));
    child.on("close", (code) => {
      const stdout = Buffer.concat(out).toString("utf8");
      const stderr = Buffer.concat(err).toString("utf8");
      if (code === 0) resolve({ stdout, stderr });
      else {
        const what = args.slice(args.indexOf("exec") >= 0 ? args.indexOf("exec") : 0).slice(0, 6).join(" ");
        reject(new DockerError(`docker ${what} exited ${code}:\n${(stderr || stdout).slice(-4000)}`));
      }
    });
    child.stdin.on("error", () => {
      /* reported via close */
    });
    child.stdin.end(input ?? "");
  });
}

export class Harness {
  constructor(readonly opts: DockerOptions) {}

  private compose(...args: string[]): string[] {
    return ["compose", "-p", this.opts.project, "-f", COMPOSE_FILE, ...args];
  }

  /** `php batch/<script> args...` in the hotcrp container, with optional stdin. */
  async batch(script: string, args: readonly string[] = [], input?: string): Promise<string> {
    const { stdout, stderr } = await run(this.compose("exec", "-T", "hotcrp", "php", `batch/${script}`, ...args), input);
    return stdout + stderr;
  }

  /** A shell command in the hotcrp container. */
  async sh(command: string, input?: string | Buffer): Promise<string> {
    return (await run(this.compose("exec", "-T", "hotcrp", "sh", "-c", command), input)).stdout;
  }

  /** Write a file inside the hotcrp container (via stdin; no docker cp). */
  async writeFile(path: string, content: string): Promise<void> {
    if (!/^\/tmp\/pcs-seed\/[\w.-]+$/.test(path)) throw new Error(`refusing to write ${path} (only /tmp/pcs-seed/*)`);
    await this.sh(`mkdir -p /tmp/pcs-seed && cat > ${path}`, content);
  }

  /** Run SQL in the db container. Returns tab-separated rows (no header). */
  async sql(statements: string): Promise<string[][]> {
    const { stdout } = await run(
      this.compose("exec", "-T", "db", "mariadb", "-uroot", "-proot", "-B", "-N", this.opts.dbName),
      statements,
    );
    return stdout
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => l.split("\t"));
  }

  /** The host address the hotcrp service publishes port 80 on, e.g. "127.0.0.1:18082". */
  async publishedAddress(): Promise<string> {
    return (await run(this.compose("port", "hotcrp", "80"))).stdout.trim();
  }
}

/**
 * Throw unless the compose project's published port is the one in `url`
 * (so batch/SQL writes and API writes hit the same harness).
 */
export async function checkHarnessMatchesUrl(h: Harness, url: string): Promise<void> {
  let addr: string;
  try {
    addr = await h.publishedAddress();
  } catch (e) {
    throw new DockerError(
      `can't find the harness's compose project "${h.opts.project}" (set HOTCRP_COMPOSE_PROJECT, as .env.test does): ${(e as Error).message}`,
    );
  }
  checkPublishedPort(addr, url, h.opts.project);
}

/** SQL string literal (MariaDB, default sql_mode). */
export function sqlString(s: string): string {
  return `'${s.replace(/\\/g, "\\\\").replace(/'/g, "''").replace(/\0/g, "\\0")}'`;
}

export function sqlInt(n: number): string {
  if (!Number.isSafeInteger(n)) throw new RangeError(`not an integer: ${n}`);
  return String(n);
}
