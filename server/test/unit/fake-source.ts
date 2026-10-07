// An in-memory stand-in for HotCRP implementing SyncSource, for unit tests of
// the sync and backfill. Synthetic data only (example.org).

import type {
  Comment,
  PaperRoleRow,
  PcAssignmentRow,
  PcResponse,
  Review,
  ReviewHistory,
  RqcResponse,
  SearchPaper,
  SearchResponse,
} from "../../src/hotcrp/schemas.js";
import type { SyncSource } from "../../src/sync/source.js";

export interface FakePaper {
  pid: number;
  title: string;
  status?: string;
  decision?: string;
  tags?: string;
  manager?: string; // display name
}

export interface FakePerson {
  name: string;
  email: string;
  tags?: string[];
  chair?: boolean;
  /** Not on the PC: absent from /pc (an external reviewer), but can hold tags. */
  external?: boolean;
}

export const FORM: RqcResponse = {
  hotcrp_version: "3.4",
  reviewform: {
    OveMer: { uid: "OveMer", name: "Overall merit", type: "radio", order: 1, values: ["1", "2", "3", "4", "5"] },
    RevExp: { uid: "RevExp", name: "Reviewer expertise", type: "radio", order: 2, values: ["1", "2", "3", "4"] },
    PapSum: { uid: "PapSum", name: "Paper summary", type: "text", order: 3 },
    ComAut: { uid: "ComAut", name: "Comments for authors", type: "text", order: 4 },
  },
  papers: [],
};

/** Parse a pid search ("3", "1-200", or a list like "3 7-9 40") into a pid test. */
function range(q: string): (pid: number) => boolean {
  const parts = q.trim().split(/\s+/).map((part) => {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) throw new Error(`fake source: unsupported q=${q}`);
    return [Number(m[1]), Number(m[2] ?? m[1])] as const;
  });
  return (pid) => parts.some(([lo, hi]) => pid >= lo && pid <= hi);
}

export class FakeHotcrp implements SyncSource {
  people: FakePerson[] = [];
  papersList: FakePaper[] = [];
  assignmentRows: PcAssignmentRow[] = [];
  leads: PaperRoleRow[] = [];
  shepherds: PaperRoleRow[] = [];
  reviewList: Review[] = [];
  commentList: Comment[] = [];
  histories = new Map<number, ReviewHistory>();
  /** Calls, for asserting request patterns. */
  calls: string[] = [];
  /** Make the n-th call to an endpoint throw (e.g. {"comments": 1}). */
  failOn: Record<string, number> = {};

  private hit(name: string) {
    this.calls.push(name);
    const n = this.calls.filter((c) => c === name).length;
    if (this.failOn[name] === n) throw new Error(`HotCRP GET /${name}: injected failure`);
  }

  async pc(): Promise<PcResponse> {
    this.hit("pc");
    const tags = new Set(["pc"]);
    for (const p of this.people) for (const t of p.tags ?? []) tags.add(t);
    return {
      ok: true,
      pc: this.people.filter((p) => !p.external).map((p) => ({ name: p.name, email: p.email, affiliation: "Example U", ...(p.chair ? { roles: "chair" } : {}) })),
      tags: [...tags].sort(),
    };
  }

  async papers(): Promise<SearchResponse> {
    this.hit("search");
    return {
      ok: true,
      ids: this.papersList.map((p) => p.pid).sort((a, b) => a - b),
      search_params: "q=all&t=all",
      papers: this.papersList.map((p) => {
        // SearchPaper is {pid: number} plus string fields; TS can't express that literally.
        const row = { pid: p.pid } as SearchPaper;
        row.title = p.title;
        row.status = p.status ?? "Submitted";
        row.decision = p.decision ?? "Unspecified";
        if (p.tags) row.tags = p.tags;
        if (p.manager) row.administrator = p.manager;
        return row;
      }),
    };
  }

  async pcAssignments(): Promise<PcAssignmentRow[]> {
    this.hit("pcassignments");
    return this.assignmentRows;
  }

  async paperRoles(kind: "lead" | "shepherd"): Promise<PaperRoleRow[]> {
    this.hit(kind);
    return kind === "lead" ? this.leads : this.shepherds;
  }

  async reviewForm(): Promise<RqcResponse> {
    this.hit("jsonrqc");
    return FORM;
  }

  async reviews(q: string, rq?: string): Promise<Review[]> {
    this.hit(rq ? "reviews-rq" : "reviews");
    const inQ = range(q);
    let rs = this.reviewList.filter((r) => inQ(r.pid));
    if (rq) {
      const m = /^re:#(.+)$/.exec(rq);
      if (!m) throw new Error(`fake source: unsupported rq=${rq}`);
      const holders = new Set(this.people.filter((p) => p.tags?.includes(m[1]!)).map((p) => p.email));
      rs = rs.filter((r) => holders.has(r.reviewer_email ?? ""));
    }
    return structuredClone(rs);
  }

  async comments(q: string): Promise<Comment[]> {
    this.hit("comments");
    const inQ = range(q);
    return structuredClone(this.commentList.filter((c) => inQ(c.pid)));
  }

  async reviewHistory(pid: number, rid: number): Promise<ReviewHistory> {
    this.hit("reviewhistory");
    const h = this.histories.get(rid);
    if (!h || h.pid !== pid) throw new Error(`fake source: no history for ${pid}/${rid}`);
    return structuredClone(h);
  }

  // --- builders ------------------------------------------------------------

  review(r: Partial<Review> & { pid: number; rid: number; reviewer_email: string }): Review {
    const full = { object: "review", rtype: 4, status: "complete", version: 1000 + r.rid, ordinal: "A", ...r } as Review;
    this.reviewList.push(full);
    return full;
  }

  comment(c: Partial<Comment> & { pid: number; cid: number; author_email: string; text: string }): Comment {
    const full = { object: "comment", visibility: "rev", topic: "rev", modified_at: 1_900_000_000, ...c } as Comment;
    this.commentList.push(full);
    return full;
  }
}

/** A small world: 3 papers, 5 PC members, 7 reviews, 3 comments. */
export function smallWorld(): FakeHotcrp {
  const f = new FakeHotcrp();
  f.people = [
    { name: "Ada Chair", email: "ada@example.org", chair: true },
    { name: "Ben Area", email: "ben@example.org" },
    { name: "Cy Junior", email: "cy@example.org", tags: ["junior"] },
    { name: "Dee Recip", email: "dee@example.org", tags: ["reciprocal"] },
    { name: "Eve Senior", email: "eve@example.org" },
  ];
  f.papersList = [
    { pid: 1, title: "Paper One", tags: "#accept-maybe" },
    { pid: 2, title: "Paper Two", manager: "Ada Chair" },
    { pid: 3, title: "Paper Three", decision: "Accepted" },
  ];
  f.assignmentRows = [
    { paper: 1, action: "clearreview", email: "#pc", title: "Paper One" },
    { paper: 1, action: "metareview", email: "ben@example.org" },
    { paper: 1, action: "primaryreview", email: "cy@example.org" },
    { paper: 1, action: "primaryreview", email: "eve@example.org" },
    { paper: 2, action: "clearreview", email: "#pc", title: "Paper Two" },
    { paper: 2, action: "metareview", email: "ben@example.org" },
    { paper: 2, action: "primaryreview", email: "dee@example.org" },
    { paper: 2, action: "secondaryreview", email: "eve@example.org" },
    { paper: 3, action: "clearreview", email: "#pc", title: "Paper Three" },
    { paper: 3, action: "primaryreview", email: "eve@example.org" },
  ];
  f.leads = [{ pid: 1, email: "ben@example.org" }];
  const t0 = 1_890_000_000;
  f.review({ pid: 1, rid: 11, rtype: 5, reviewer_email: "ben@example.org", status: "empty", version: 5011 });
  f.review({ pid: 1, rid: 12, reviewer_email: "cy@example.org", OveMer: 2, RevExp: 3, PapSum: "Short summary here.", ComAut: "Needs more evaluation work.", modified_at: t0 + 12 });
  f.review({ pid: 1, rid: 13, reviewer_email: "eve@example.org", OveMer: 4, RevExp: 4, PapSum: "A solid paper.", ComAut: "I like it.", modified_at: t0 + 13, ratings: "short" });
  f.review({ pid: 2, rid: 21, rtype: 5, reviewer_email: "ben@example.org", status: "empty", version: 5021 });
  f.review({ pid: 2, rid: 22, reviewer_email: "dee@example.org", status: "draft", OveMer: null, RevExp: null, PapSum: null, ComAut: null });
  f.review({ pid: 2, rid: 23, rtype: 3, reviewer_email: "eve@example.org", OveMer: 3, RevExp: 2, PapSum: "Fine.", ComAut: "Okay overall.", modified_at: t0 + 23 });
  f.review({ pid: 3, rid: 31, reviewer_email: "eve@example.org", OveMer: 5, RevExp: 4, PapSum: "Great.", ComAut: "Accept.", modified_at: t0 + 31 });
  f.comment({ pid: 1, cid: 101, author_email: "ben@example.org", text: "@Cy Junior can you say more about the evaluation?", modified_at: t0 + 101 });
  f.comment({ pid: 1, cid: 102, author_email: "cy@example.org", text: "Sure, the baselines are weak.", modified_at: t0 + 102 });
  f.comment({ pid: 2, cid: 201, author_email: "ben@example.org", text: "@dee@example.org and @Eve: thoughts?", modified_at: t0 + 201 });
  return f;
}
