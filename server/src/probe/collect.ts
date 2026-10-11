// Runs every read the sync uses and reduces the responses to a ProbeReport.
//
// This is the only probe module that sees raw HotCRP responses. It may read
// any field, but what it puts in the report is limited to counts and Safe
// strings drawn from configuration: JSON key names, form UIDs and labels,
// role/status/decision/visibility names, and user-tag NAMES. It never copies
// titles, names, emails, affiliations, text, or tags attached to papers,
// comments, or people.

import type { z } from "zod";
import { HotcrpError } from "../hotcrp/errors.js";
import {
  CommentsSchema,
  PcAssignmentsSchema,
  PcSchema,
  ReviewHistorySchema,
  ReviewRatingSchema,
  ReviewSchema,
  ReviewsSchema,
  RATING_SETTINGS_FILTER,
  RatingSettingsSchema,
  RqcSchema,
  SearchSchema,
  SettingsRfSchema,
  WhoamiSchema,
} from "../hotcrp/schemas.js";
import type { ProbeReader, RateLimitObservation, ReadSpec } from "./readonly.js";
import type { EndpointResult, FormField, ObservedValues, ProbeReport } from "./report.js";
import { ident, isIdent, label, note, ShapeAccumulator, Tally, type Safe } from "./safe.js";

/** The display fields the sync asks /search for (spec §1). */
export const SEARCH_FIELDS = ["title", "status", "decision", "tags", "lead", "shepherd", "manager", "reviewers", "revstat"];

const BUILTIN_USER_TAGS = new Set(["pc", "listedpc", "unlistedpc", "bot"]);
const RTYPE_NAMES: Record<number, string> = { 1: "external", 2: "pc", 3: "secondary", 4: "primary", 5: "meta" };
const REVIEW_SCHEMA_KEYS = new Set(Object.keys(ReviewSchema.shape));

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const objs = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : []);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

class Endpoint {
  readonly r: EndpointResult;
  readonly #issues = new Set<string>();
  constructor(name: string) {
    this.r = { name: name as Safe, reachable: true, requests: 0, schema: "skipped", schemaFailures: 0, schemaIssues: [] };
  }

  async read(reader: ProbeReader, spec: ReadSpec): Promise<unknown> {
    this.r.requests++;
    return reader.read(spec);
  }

  fail(e: unknown): void {
    this.r.reachable = false;
    if (e instanceof HotcrpError) {
      this.r.error = note(`${e.kind}: ${e.message}`);
      if (e.status !== undefined) this.r.status = e.status;
    } else {
      this.r.error = note(e instanceof Error ? `${e.name}: ${e.message}` : "unknown error");
    }
  }

  check(schema: z.ZodType, body: unknown): void {
    const res = schema.safeParse(body);
    if (res.success) {
      if (this.r.schema === "skipped") this.r.schema = "pass";
      return;
    }
    this.r.schema = "fail";
    this.r.schemaFailures++;
    for (const i of res.error.issues) {
      const path = i.path.map((p) => (typeof p === "number" ? "[]" : ident(String(p)))).join(".") || "(root)";
      this.#issues.add(`${path}: ${i.message}`);
    }
    this.r.schemaIssues = [...this.#issues].slice(0, 10).map(note);
  }
}

interface Observing {
  present: number;
  nulls: number;
  numeric: number;
  min?: number;
  max?: number;
  symbols: Tally;
  otherStrings: number;
}

function observe(o: Observing, v: unknown): void {
  o.present++;
  if (v === null) o.nulls++;
  else if (typeof v === "number") {
    o.numeric++;
    o.min = Math.min(o.min ?? v, v);
    o.max = Math.max(o.max ?? v, v);
  } else if (typeof v === "string" && v.length <= 3 && isIdent(v)) o.symbols.add(ident(v));
  else o.otherStrings++;
}

function observed(o: Observing): ObservedValues {
  return { ...o, symbols: o.symbols.result() };
}

export interface ProbeOptions {
  rateLimit: RateLimitObservation;
}

export async function collect(reader: ProbeReader, opts: ProbeOptions): Promise<ProbeReport> {
  const endpoints: Endpoint[] = [];
  const ep = (name: string) => {
    const e = new Endpoint(name);
    endpoints.push(e);
    return e;
  };
  const report: ProbeReport = {
    reportVersion: 1,
    hotcrp: {},
    account: { roles: [], chair: false, forceShow: reader.forceShow },
    endpoints: [],
    shapes: [],
    form: [],
    history: { sampled: false, objects: [], ratingKeys: [] },
    rateLimit: { headers: [], responses: 0, status429: 0 },
    warnings: [],
  };
  const shape = (name: string, items: Iterable<unknown>) => {
    const acc = new ShapeAccumulator();
    for (const it of items) acc.add(it);
    report.shapes.push({ name: label(name), shape: acc.result() });
  };
  const forceShow = reader.forceShow ? 1 : 0;

  // --- whoami ---------------------------------------------------------------
  {
    const e = ep("GET /whoami");
    try {
      const body = await e.read(reader, { path: "whoami" });
      e.check(WhoamiSchema, body);
      if (isObj(body)) {
        const roles = Array.isArray(body.roles) ? body.roles.filter((x) => typeof x === "string") : [];
        report.account.roles = roles.map(ident);
        report.account.chair = roles.includes("chair");
        shape("whoami", [body]);
      }
      if (!report.account.chair) report.warnings.push(note("the token is not a chair token; counts will be partial"));
    } catch (err) {
      e.fail(err);
    }
  }

  // --- /pc --------------------------------------------------------------------
  {
    const e = ep("GET /pc");
    try {
      const body = await e.read(reader, { path: "pc" });
      e.check(PcSchema, body);
      const members = isObj(body) ? objs(body.pc) : [];
      const tags = isObj(body) && Array.isArray(body.tags) ? body.tags.filter((t) => typeof t === "string") : [];
      const colors = new Tally();
      let withColors = 0;
      for (const m of members) {
        const cc = str(m.color_classes);
        if (cc) {
          withColors++;
          for (const c of cc.split(/\s+/).filter(Boolean)) colors.add(ident(c));
        }
      }
      report.pc = {
        size: members.length,
        chairs: members.filter((m) => m.roles === "chair").length,
        userTags: tags.filter((t) => !BUILTIN_USER_TAGS.has(t)).map(ident),
        builtinTags: tags.filter((t) => BUILTIN_USER_TAGS.has(t)).map(ident),
        membersWithTags: members.filter((m) => "tags" in m).length,
        membersWithColorClasses: withColors,
        colorClasses: colors.result(),
      };
      shape("pc", isObj(body) ? [body] : []);
      shape("pc.pc[]", members);
    } catch (err) {
      e.fail(err);
    }
  }

  // --- review form ------------------------------------------------------------
  const form = new Map<string, FormField>();
  {
    const e = ep("GET /searchaction?action=get/jsonrqc");
    try {
      const body = await e.read(reader, { path: "searchaction", params: { action: "get/jsonrqc", q: "NONE" } });
      e.check(RqcSchema, body);
      if (isObj(body)) {
        if (str(body.hotcrp_version)) report.hotcrp.version = ident(str(body.hotcrp_version)!);
        if (str(body.hotcrp_commit)) report.hotcrp.commit = ident(str(body.hotcrp_commit)!);
        const rf = isObj(body.reviewform) ? body.reviewform : {};
        for (const [key, f] of Object.entries(rf)) {
          if (!isObj(f)) continue;
          const uid = str(f.uid) ?? key;
          const values = Array.isArray(f.values) ? f.values.filter((v) => typeof v === "string") : undefined;
          form.set(uid, {
            uid: ident(uid),
            name: label(str(f.name) ?? ""),
            type: ident(str(f.type) ?? "?"),
            ...(num(f.order) !== undefined ? { order: num(f.order)! } : {}),
            ...(typeof f.required === "boolean" ? { required: f.required } : {}),
            ...(str(f.visibility) ? { visibility: ident(str(f.visibility)!) } : {}),
            ...(str(f.scheme) ? { scheme: ident(str(f.scheme)!) } : {}),
            ...(values && values.length > 0 ? { labels: values.map(label) } : {}),
          });
        }
        shape("jsonrqc.reviewform{}", Object.values(rf));
      }
    } catch (err) {
      e.fail(err);
    }
  }
  {
    const e = ep("GET /settings?filter=rf");
    try {
      const body = await e.read(reader, { path: "settings", params: { filter: "rf" } });
      e.check(SettingsRfSchema, body);
      const rf = isObj(body) && isObj(body.settings) ? objs(body.settings.rf) : [];
      for (const s of rf) {
        const match = [...form.values()].find((f) => f.order !== undefined && f.order === num(s.order));
        if (!match) continue;
        if (str(s.id)) match.settingsId = ident(str(s.id)!);
        const vals = objs(s.values);
        if (vals.length > 0) match.symbols = vals.map((v) => ident(String(v.symbol ?? "?")));
      }
      shape("settings.rf[]", rf);
    } catch (err) {
      e.fail(err);
    }
  }
  // Review ratings (spec §1): who may rate and who sees ratings. Values are
  // HotCRP's enum names, never content.
  {
    const e = ep("GET /settings (review ratings)");
    try {
      const body = await e.read(reader, { path: "settings", params: { filter: RATING_SETTINGS_FILTER } });
      e.check(RatingSettingsSchema, body);
      const st = isObj(body) && isObj(body.settings) ? body.settings : {};
      report.ratings = {
        ...report.ratings,
        setting: ident(str(st.review_rating) ?? "(none)"),
        visibility: ident(str(st.review_rating_visibility) ?? "(none)"),
      };
    } catch (err) {
      e.fail(err);
    }
  }

  // --- /search ------------------------------------------------------------------
  let pids: number[] | undefined;
  {
    const e = ep("GET /search (t=all, display fields)");
    try {
      const body = await e.read(reader, {
        path: "search",
        params: { q: "all", t: "all", f: SEARCH_FIELDS.join(" "), format: "csv", forceShow },
      });
      e.check(SearchSchema, body);
      if (isObj(body)) {
        const echoed = new URLSearchParams(str(body.search_params) ?? "").get("t");
        if (echoed !== "all") report.warnings.push(note(`/search asked for t=all but HotCRP searched t=${ident(echoed ?? "none")}`));
        pids = Array.isArray(body.ids) ? body.ids.filter((x): x is number => Number.isInteger(x) && x > 0) : [];
        const papers = objs(body.papers);
        const byStatus = new Tally();
        const byDecision = new Tally();
        const tagNames = new Set<string>();
        let withTags = 0;
        for (const p of papers) {
          byStatus.add(label(str(p.status) ?? "(none)"));
          byDecision.add(label(str(p.decision) ?? "(none)"));
          const tags = str(p.tags)?.split(/\s+/).filter(Boolean) ?? [];
          if (tags.length > 0) withTags++;
          for (const t of tags) tagNames.add(t.replace(/#.*$/, ""));
        }
        report.papers = {
          all: pids.length,
          byStatus: byStatus.result(),
          byDecision: byDecision.result(),
          fieldsReturned: objs(body.fields).map((f) => ident(str(f.name) ?? "?")),
          withTags,
          distinctTags: tagNames.size,
        };
        shape("search", [body]);
        shape("search.papers[]", papers);
      }
    } catch (err) {
      e.fail(err);
    }
  }
  {
    const e = ep("GET /search (t=s)");
    try {
      const body = await e.read(reader, { path: "search", params: { q: "all", t: "s", forceShow } });
      e.check(SearchSchema, body);
      if (isObj(body) && Array.isArray(body.ids) && report.papers) report.papers.submitted = body.ids.length;
    } catch (err) {
      e.fail(err);
    }
  }

  // --- get/pcassignments -----------------------------------------------------------
  {
    const e = ep("GET /searchaction?action=get/pcassignments");
    try {
      const body = await e.read(reader, {
        path: "searchaction",
        params: { action: "get/pcassignments", q: "all", t: "all", forceShow },
        format: "csv",
      });
      e.check(PcAssignmentsSchema, body);
      const rows = objs(body);
      const byAction = new Tally();
      for (const row of rows) byAction.add(ident(str(row.action) ?? "?"));
      report.assignments = {
        rows: rows.length,
        papers: new Set(rows.map((x) => x.paper)).size,
        byAction: byAction.result(),
        withRound: rows.filter((x) => (str(x.round) ?? "") !== "").length,
      };
      shape("pcassignments rows", rows);
    } catch (err) {
      e.fail(err);
    }
  }

  // --- /reviews and /comments (chunked by pid range) --------------------------------
  const chunkedSpec = (path: string) => (q: string) => ({ path, params: { q, forceShow }, postAsGet: true });
  const readBulk = async (e: Endpoint, path: string, each: (body: unknown) => void) => {
    if (pids === undefined || pids.length === 0) {
      e.r.requests++;
      each(await reader.read(chunkedSpec(path)("all")));
    } else {
      e.r.requests += await reader.readChunks(pids, chunkedSpec(path), each);
    }
  };

  let sample: { pid: number; rid: number } | undefined;
  const reviewsTask = (async () => {
    const e = ep("GET /reviews");
    const acc = new ShapeAccumulator();
    const byType = new Tally();
    const byStatus = new Tally();
    const cells = new Tally();
    const obs = new Map<string, Observing>();
    for (const uid of form.keys()) obs.set(uid, { present: 0, nulls: 0, numeric: 0, symbols: new Tally(), otherStrings: 0 });
    let sampleComplete = false;
    let total = 0;
    let rated = 0;
    const flags = new Tally();
    try {
      await readBulk(e, "reviews", (body) => {
        e.check(ReviewsSchema, body);
        for (const rv of isObj(body) ? objs(body.reviews) : []) {
          total++;
          acc.add(rv);
          const t = num(rv.rtype);
          const tname = ident(t === undefined ? "(none)" : (RTYPE_NAMES[t] ?? `rtype${t}`));
          const status = ident(str(rv.status) ?? "(none)");
          byType.add(tname);
          byStatus.add(status);
          cells.add(`${tname} x ${status}` as Safe);
          for (const [uid, o] of obs) if (uid in rv) observe(o, rv[uid]);
          if ("ratings" in rv) {
            rated++;
            const rs = Array.isArray(rv.ratings) ? rv.ratings : [rv.ratings];
            for (const f of rs) flags.add(ident(typeof f === "string" ? f : "?"));
          }
          const pid = num(rv.pid);
          const rid = num(rv.rid);
          if (pid !== undefined && rid !== undefined && !sampleComplete) {
            // Prefer a complete review: it has the most history.
            if (rv.status === "complete") {
              sample = { pid, rid };
              sampleComplete = true;
            } else sample ??= { pid, rid };
          }
        }
      });
    } catch (err) {
      e.fail(err);
    }
    for (const [uid, o] of obs) form.get(uid)!.observed = observed(o);
    const shp = acc.result();
    report.reviews = {
      total,
      byType: byType.result(),
      byStatus: byStatus.result(),
      byTypeStatus: cells.result(),
      modifiedAt: { present: acc.present("modified_at"), total },
      version: { present: acc.present("version"), total },
      reviewerEmail: { present: acc.present("reviewer_email"), total },
      extraKeys: shp.keys.map((k) => k.key).filter((k) => !REVIEW_SCHEMA_KEYS.has(k) && !form.has(k)),
    };
    report.shapes.push({ name: label("reviews[]"), shape: shp });
    report.ratings = { setting: report.ratings?.setting, visibility: report.ratings?.visibility, reviewsRated: rated, flags: flags.result() };
  })();

  const commentsTask = (async () => {
    const e = ep("GET /comments");
    const acc = new ShapeAccumulator();
    const vis = new Tally();
    const topic = new Tally();
    const rounds = new Tally();
    const c = { total: 0, responses: 0, responseDrafts: 0, drafts: 0, byAuthor: 0, withTags: 0, wordCountNonNull: 0 };
    try {
      await readBulk(e, "comments", (body) => {
        e.check(CommentsSchema, body);
        for (const cm of isObj(body) ? objs(body.comments) : []) {
          c.total++;
          acc.add(cm);
          vis.add(ident(str(cm.visibility) ?? "(none)"));
          topic.add(ident(str(cm.topic) ?? "(none)"));
          const draft = cm.draft === true;
          if (draft) c.drafts++;
          if (cm.response !== undefined) {
            c.responses++;
            if (draft) c.responseDrafts++;
            rounds.add(ident(str(cm.response) || "(unnamed)"));
          }
          if (cm.by_author === true) c.byAuthor++;
          if (Array.isArray(cm.tags) && cm.tags.length > 0) c.withTags++;
          if (num(cm.word_count) !== undefined) c.wordCountNonNull++;
        }
      });
    } catch (err) {
      e.fail(err);
    }
    report.comments = {
      ...c,
      byVisibility: vis.result(),
      byTopic: topic.result(),
      responseRounds: rounds.result(),
      modifiedAt: { present: acc.present("modified_at"), total: c.total },
    };
    report.shapes.push({ name: label("comments[]"), shape: acc.result() });
  })();

  await Promise.all([reviewsTask, commentsTask]);

  // --- one review history + rating sample ---------------------------------------------
  const hist = ep("GET /{p}/reviewhistory");
  const rating = ep("GET /{p}/reviewrating");
  if (sample) {
    report.history.sampled = true;
    try {
      const body = await hist.read(reader, { path: `${sample.pid}/reviewhistory`, params: { r: sample.rid } });
      hist.check(ReviewHistorySchema, body);
      const versions = isObj(body) ? objs(body.versions) : [];
      const kinds = new Tally();
      for (const v of versions) kinds.add(ident(str(v.object) ?? "?"));
      report.history.versions = versions.length;
      report.history.objects = kinds.result();
      shape("reviewhistory.versions[]", versions);
    } catch (err) {
      hist.fail(err);
    }
    try {
      const body = await rating.read(reader, { path: `${sample.pid}/reviewrating`, params: { r: sample.rid } });
      rating.check(ReviewRatingSchema, body);
      report.history.ratingKeys = isObj(body) ? Object.keys(body).filter(isIdent).map(ident) : [];
    } catch (err) {
      rating.fail(err);
    }
  }

  report.endpoints = endpoints.map((e) => e.r);
  report.form = [...form.values()].sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
  const rl = opts.rateLimit;
  report.rateLimit = {
    headers: [...rl.headers].sort().map(ident),
    ...(rl.limit !== undefined ? { limit: rl.limit } : {}),
    ...(rl.minRemaining !== undefined ? { minRemaining: rl.minRemaining } : {}),
    responses: rl.responses,
    status429: rl.status429,
  };
  return report;
}
