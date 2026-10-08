// The seeder's HotCRP write calls (POST /reviews, POST /comments). The app's
// client in server/src/hotcrp/ only writes tags, behind dry-run + confirm
// (PLAN M8), so the seeder keeps its own writes here, harness-only: the constructor re-checks
// assertHarnessUrl(). Every response is validated with a Zod schema; any
// item HotCRP rejects fails the seed loudly.

import { assertHarnessUrl } from "@pcs/server/hotcrp/harness-guard";
import { redact } from "@pcs/server/redact";
import { z } from "zod";

const Message = z.looseObject({ status: z.number(), message: z.string().optional(), field: z.string().optional() });

const ItemStatus = z.looseObject({
  valid: z.boolean(),
  pid: z.number().optional(),
  change_list: z.array(z.string()).optional(),
});

export const ReviewsPostSchema = z.looseObject({
  ok: z.boolean(),
  message_list: z.array(Message).optional(),
  status_list: z.array(ItemStatus.extend({ rid: z.union([z.number(), z.string()]).optional() })),
});

export const CommentsPostSchema = z.looseObject({
  ok: z.boolean(),
  message_list: z.array(Message).optional(),
  status_list: z.array(ItemStatus.extend({ cid: z.number().optional() })),
});

export const RatingPostSchema = z.looseObject({
  ok: z.boolean(),
  ratings: z.union([z.string(), z.array(z.string())]).optional(),
  user_rating: z.union([z.string(), z.array(z.string())]).optional(),
  message_list: z.array(Message).optional(),
});

export class SeedApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeedApiError";
  }
}

export interface ReviewPost {
  pid: number;
  rid: number;
  submitted?: boolean;
  [field: string]: unknown;
}

export interface CommentPost {
  pid: number;
  cid?: number;
  text?: string;
  response?: string;
  visibility?: string;
  delete?: boolean;
}

export class SeedWriter {
  readonly #base: string;
  readonly #token: string;
  requests = 0;

  constructor(baseUrl: string, token: string) {
    assertHarnessUrl({ PCS_HOTCRP_URL: baseUrl });
    this.#base = baseUrl.replace(/\/+$/, "");
    this.#token = token;
  }

  private async post<S extends z.ZodType>(path: string, params: Record<string, string>, body: unknown, schema: S): Promise<z.output<S>> {
    const url = new URL(`${this.#base}/api/${path}`);
    for (const [k, v] of Object.entries({ ...params, pretty: "0" })) url.searchParams.set(k, v);
    for (let attempt = 0; ; attempt++) {
      this.requests++;
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.#token}`, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
        redirect: "manual",
      });
      if ((res.status === 429 || res.status >= 502) && attempt < 8) {
        await res.body?.cancel();
        const ra = Number(res.headers.get("retry-after") ?? "");
        await new Promise((r) => setTimeout(r, Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1000 * 2 ** attempt));
        continue;
      }
      const text = await res.text();
      const clean = (s: string) => redact(s, [this.#token]);
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        throw new SeedApiError(`POST /${path}: HTTP ${res.status}, not JSON: ${clean(text.slice(0, 300))}`);
      }
      const parsed = schema.safeParse(data);
      if (!parsed.success) {
        throw new SeedApiError(`POST /${path}: HTTP ${res.status}, unexpected response: ${clean(JSON.stringify(data).slice(0, 600))}`);
      }
      const out = parsed.data as { ok: boolean; status_list: { valid: boolean }[]; message_list?: unknown[] };
      const bad = out.status_list.map((s, i) => [s, i] as const).filter(([s]) => !s.valid);
      if (!out.ok || bad.length > 0) {
        throw new SeedApiError(
          `POST /${path} rejected ${bad.length || "the"} item(s) [${bad.map(([, i]) => i).join(",")}]: ${clean(JSON.stringify(out.message_list ?? []).slice(0, 1200))}`,
        );
      }
      return parsed.data;
    }
  }

  /** POST /reviews (array) as the token's user (a chair may write anyone's review). */
  async reviews(items: readonly ReviewPost[]) {
    if (items.length === 0) return;
    const res = await this.post("reviews", { notify: "0" }, items, ReviewsPostSchema);
    if (res.status_list.length !== items.length) throw new SeedApiError(`POST /reviews: ${res.status_list.length} statuses for ${items.length} items`);
  }

  /**
   * POST /{pid}/reviewrating?r=<rid>&actas=<rater>: the rater's flags on one
   * review, form-encoded (`user_rating=short vague`), as harness-smoke.sh
   * does. Checks that HotCRP recorded exactly those flags for the rater.
   */
  async rate(pid: number, rid: number, actas: string, flags: readonly string[]): Promise<void> {
    const url = new URL(`${this.#base}/api/${pid}/reviewrating`);
    for (const [k, v] of Object.entries({ r: String(rid), actas, pretty: "0" })) url.searchParams.set(k, v);
    this.requests++;
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.#token}`, Accept: "application/json" },
      body: new URLSearchParams({ user_rating: flags.join(" ") }),
      redirect: "manual",
    });
    const text = await res.text();
    const clean = (s: string) => redact(s, [this.#token]);
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new SeedApiError(`POST /${pid}/reviewrating: HTTP ${res.status}, not JSON: ${clean(text.slice(0, 300))}`);
    }
    const p = RatingPostSchema.safeParse(data);
    if (!p.success || !p.data.ok) throw new SeedApiError(`POST /${pid}/reviewrating rejected (rid ${rid}, as ${actas}): ${clean(JSON.stringify(data).slice(0, 600))}`);
    const got = [p.data.user_rating ?? []].flat().sort().join(" ");
    const want = [...flags].sort().join(" ");
    if (got !== want) throw new SeedApiError(`POST /${pid}/reviewrating: recorded "${got}" for ${actas}, expected "${want}"`);
  }

  /** POST /comments (array) acting as `actas`. Returns the cid of each item (undefined for deletions). */
  async comments(actas: string, items: readonly CommentPost[]): Promise<(number | undefined)[]> {
    if (items.length === 0) return [];
    const res = await this.post("comments", { actas, notify: "0" }, items, CommentsPostSchema);
    if (res.status_list.length !== items.length) throw new SeedApiError(`POST /comments: ${res.status_list.length} statuses for ${items.length} items`);
    return res.status_list.map((s) => s.cid);
  }
}
