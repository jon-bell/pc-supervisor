// What the sync needs from HotCRP, as an interface so unit tests can supply a
// fake. The real implementation is a thin wrapper over the M1 client; every
// response is Zod-validated there.

import type { HotcrpClient } from "../hotcrp/client.js";
import type {
  Comment,
  Paper,
  PaperRoleRow,
  PcAssignmentRow,
  PcResponse,
  Review,
  ReviewHistory,
  RqcResponse,
  SearchResponse,
  SettingsSfResponse,
} from "../hotcrp/schemas.js";

/** /search display fields the sync reads (`manager` comes back as `administrator`). */
export const SEARCH_FIELDS = ["title", "status", "decision", "tags", "manager"] as const;

export interface SyncSource {
  pc(): Promise<PcResponse>;
  /** All papers (t=all) with SEARCH_FIELDS. */
  papers(): Promise<SearchResponse>;
  pcAssignments(): Promise<PcAssignmentRow[]>;
  paperRoles(kind: "lead" | "shepherd"): Promise<PaperRoleRow[]>;
  reviewForm(): Promise<RqcResponse>;
  /** Reviews for one pid-range search `q`, optionally filtered by review search `rq`. */
  reviews(q: string, rq?: string): Promise<Review[]>;
  /** Comments for one pid-range search `q`. */
  comments(q: string): Promise<Comment[]>;
  /** Expanded history of one review (newest first). */
  reviewHistory(pid: number, rid: number): Promise<ReviewHistory>;
  /**
   * Paper objects (authors with affiliations, submission-option values) for
   * one pid-range search `q` (PLAN M10). Optional: without it (older fakes)
   * the sync skips authors and options.
   */
  paperDetails?(q: string): Promise<Paper[]>;
  /** Submission fields (settings sf), to tell option keys from intrinsic ones (PLAN M10). */
  submissionFields?(): Promise<SettingsSfResponse>;
}

export function clientSource(client: HotcrpClient): SyncSource {
  return {
    pc: () => client.pc(),
    papers: () => client.search({ t: "all", fields: SEARCH_FIELDS }),
    pcAssignments: () => client.pcAssignments({ t: "all" }),
    paperRoles: (kind) => client.paperRoles(kind, { t: "all" }),
    reviewForm: () => client.reviewForm(),
    reviews: (q, rq) => client.reviews({ q, t: "all", rq }),
    comments: (q) => client.comments({ q, t: "all" }),
    reviewHistory: (pid, rid) => client.reviewHistory(pid, rid, { expand: true }),
    paperDetails: (q) => client.papers({ q, t: "all" }),
    submissionFields: () => client.submissionFields(),
  };
}
