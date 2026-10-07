// A minimal, self-contained seeding helper for M3 integration tests: batch
// scripts via `docker compose exec` for structure, the API for reviews and
// comments (same method as scripts/harness-smoke.sh). The full seeder (M2)
// replaces this for scenario tests.
//
// Isolation: each MiniSeed picks fresh pids (above every existing paper) and
// run-unique emails/names, so suites can share one harness and be re-run.
// Synthetic data only: invented names at example.org.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { assertHarnessUrl, harnessProject } from "../../src/hotcrp/harness-guard.js";
import { verifyHarnessOnce } from "../../src/hotcrp/harness-verify.js";

const COMPOSE_FILE = fileURLToPath(new URL("../../../hotcrp/compose.yaml", import.meta.url));

export interface SeedUser {
  key: string;
  first: string;
  last: string;
  tags?: string[];
}

const RatingResponse = z.looseObject({ ok: z.boolean(), message_list: z.array(z.unknown()).optional() });

export class MiniSeed {
  readonly url: string;
  readonly run: string;
  readonly #token: string;
  readonly project: string;

  /** Verifies the disposable harness (harness-verify.ts) before any write. */
  static async create(run?: string): Promise<MiniSeed> {
    await verifyHarnessOnce();
    return new MiniSeed(run);
  }

  private constructor(run: string = Date.now().toString(36)) {
    this.url = assertHarnessUrl();
    const token = process.env.PCS_HOTCRP_TOKEN;
    if (!token) throw new Error("PCS_HOTCRP_TOKEN is not set; load .env.test");
    this.#token = token;
    this.project = harnessProject();
    this.run = run;
  }

  email(key: string): string {
    return `m3-${this.run}-${key}@example.org`;
  }

  // --- plumbing --------------------------------------------------------------

  dc(args: string[], input?: string): string {
    const r = spawnSync("docker", ["compose", "-p", this.project, "-f", COMPOSE_FILE, ...args], {
      input,
      encoding: "utf8",
      maxBuffer: 64 << 20,
    });
    if (r.status !== 0) throw new Error(`docker compose ${args.slice(0, 4).join(" ")} failed: ${r.stderr || r.stdout}`);
    return r.stdout;
  }

  php(script: string, args: string[], input?: string): string {
    return this.dc(["exec", "-T", "hotcrp", "php", script, ...args], input);
  }

  sql(stmt: string): string {
    return this.dc(["exec", "-T", "db", "mariadb", "-uroot", "-proot", process.env.HOTCRP_DB_NAME ?? "hotcrp", "-N", "-e", stmt]);
  }

  async api(method: "GET" | "POST", path: string, params: Record<string, string | number> = {}, body?: unknown): Promise<Record<string, unknown>> {
    const u = new URL(`${this.url}/api/${path}`);
    for (const [k, v] of Object.entries({ pretty: 0, ...params })) u.searchParams.set(k, String(v));
    const res = await fetch(u, {
      method,
      headers: { Authorization: `Bearer ${this.#token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const j = (await res.json()) as Record<string, unknown>;
    if (!res.ok || j.ok !== true) throw new Error(`${method} /${path}: HTTP ${res.status} ${JSON.stringify(j.message_list ?? j)}`);
    return j;
  }

  // --- structure ---------------------------------------------------------------

  openReviewing(): void {
    this.php("batch/settings.php", [
      "save",
      "-e",
      JSON.stringify({ review_open: true, review: [{ id: 1, name: "", soft: "2099-01-01", done: "2099-01-02" }], comment_allow_always: true }),
    ]);
  }

  saveUsers(users: SeedUser[]): void {
    const json = users.map((u) => ({
      email: this.email(u.key),
      firstName: u.first,
      lastName: u.last,
      roles: "pc",
      ...(u.tags ? { tags: u.tags.join(" ") } : {}),
    }));
    this.php("batch/saveusers.php", ["-e", JSON.stringify(json)]);
  }

  /** Smallest pid above every existing paper. */
  async nextPid(): Promise<number> {
    const r = await this.api("GET", "search", { q: "all", t: "all" });
    const ids = r.ids as number[];
    return ids.length === 0 ? 1 : Math.max(...ids) + 1;
  }

  savePapers(papers: { pid: number; title: string }[]): void {
    const dir = `/tmp/m3-${this.run}`;
    this.dc(["exec", "-T", "hotcrp", "sh", "-c", `mkdir -p ${dir} && cp test/sample50pg.pdf ${dir}/paper.pdf`]);
    const json = papers.map((p) => ({
      pid: p.pid,
      title: p.title,
      abstract: "Synthetic abstract.",
      authors: [{ email: this.email(`author${p.pid}`) }],
      status: "submitted",
      submission: { content_file: "paper.pdf", mimetype: "application/pdf" },
    }));
    this.dc(["exec", "-T", "hotcrp", "sh", "-c", `cat > ${dir}/papers.json`], JSON.stringify(json));
    this.php("batch/savepapers.php", [`${dir}/papers.json`]);
  }

  /** CSV rows `paper,action,user[,tag]`, e.g. [pid, "primary", "r1"]. User keys are expanded to emails. */
  assign(rows: [number, string, string][]): void {
    const csv = ["paper,action,user", ...rows.map(([p, a, u]) => `${p},${a},${u.includes("@") ? u : this.email(u)}`)].join("\n");
    this.php("batch/assign.php", [], `${csv}\n`);
  }

  tagPapers(rows: [number, string][]): void {
    const csv = ["paper,action,tag", ...rows.map(([p, t]) => `${p},tag,${t}`)].join("\n");
    this.php("batch/assign.php", [], `${csv}\n`);
  }

  /** Shift request times back so HotCRP reports modified_at (AGENTS.md gotcha). */
  backdateRequests(pids: number[], days = 7): void {
    this.sql(`update PaperReview set timeRequested = timeRequested - ${days}*86400 where paperId in (${pids.join(",")})`);
  }

  // --- activity --------------------------------------------------------------------

  async rid(pid: number, userKey: string): Promise<number> {
    const r = await this.api("GET", "reviews", { p: pid });
    const rev = (r.reviews as { rid: number; reviewer_email: string }[]).find((x) => x.reviewer_email === this.email(userKey));
    if (!rev) throw new Error(`no review by ${userKey} on #${pid}`);
    return rev.rid;
  }

  async submitReview(pid: number, userKey: string, fields: Record<string, string | number>): Promise<number> {
    const rid = await this.rid(pid, userKey);
    const r = await this.api("POST", "reviews", { notify: 0 }, [{ pid, rid, ...fields, submitted: true }]);
    const st = r.status_list as { valid: boolean }[];
    if (!st.every((s) => s.valid)) throw new Error(`review #${pid}/${rid} not valid: ${JSON.stringify(r.status_list)}`);
    return rid;
  }

  async rate(pid: number, rid: number, raterKey: string, rating: string): Promise<void> {
    const u = new URL(`${this.url}/api/${pid}/reviewrating`);
    u.search = new URLSearchParams({ r: String(rid), actas: this.email(raterKey), pretty: "0" }).toString();
    const res = await fetch(u, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.#token}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ user_rating: rating }),
    });
    const j = RatingResponse.safeParse(await res.json());
    if (!j.success || !j.data.ok) throw new Error(`rating failed: HTTP ${res.status} ${JSON.stringify(j.success ? j.data : j.error.issues)}`);
  }

  async comment(pid: number, authorKey: string, text: string): Promise<number> {
    const r = await this.api("POST", `${pid}/comment`, { actas: this.email(authorKey), notify: 0 }, { text, visibility: "rev" });
    return r.cid as number;
  }

  async editComment(pid: number, cid: number, authorKey: string, text: string): Promise<void> {
    await this.api("POST", `${pid}/comment`, { c: cid, actas: this.email(authorKey), notify: 0 }, { text, visibility: "rev" });
  }

  async deleteComment(pid: number, cid: number): Promise<void> {
    await this.api("POST", `${pid}/comment`, { c: cid, notify: 0 }, { delete: true });
  }
}
