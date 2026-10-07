// What the reserve-compliance and quick-reject modules must report for the
// `registration` scenario at OBSERVE_AT, under registrationEnv() and the
// default PCS_RESERVE_* / PCS_QR_* settings, after `pcs import` of the two
// fixtures. The integration test compares the full lists, so anything extra
// fails.

import { R } from "./scenario.js";

/** Reserve findings as `CODE pids emails` (pids and emails as in the finding). */
const f = (code: string, pids: number[], ...emails: string[]) => `${code} ${pids.join(",")} ${emails.join(" ")}`.trim();

export const EXPECTED_RESERVE_FINDINGS: readonly string[] = [
  f("DESIGNEE_MISSING", [2]),
  f("EXEMPTION_NOT_ALLOWED", [5]),
  f("EXEMPTION_CONTRADICTED", [6]),
  f("DESIGNEE_INCONSISTENT", [3, 4], R.kim2, R.kim),
  f("OVER_COVERED", [7, 8, 9, 10], R.victor),
  f("TPMS_NOT_REGISTERED", [4], R.kim2),
];

/** Paper states: everything not listed is "designee". */
export const EXPECTED_RESERVE_STATES: Readonly<Record<number, "exempt" | "noncompliant">> = {
  2: "noncompliant",
  5: "noncompliant",
  6: "noncompliant",
  11: "exempt",
};

/** #12 names its designee by name; it resolves to this author. */
export const EXPECTED_BY_NAME = { pid: 12, email: R.sana } as const;

/** Mail-tool searches per code (HotCRP paper-number searches). */
export const EXPECTED_RESERVE_MAIL: Readonly<Record<string, string>> = {
  DESIGNEE_MISSING: "2",
  EXEMPTION_NOT_ALLOWED: "5",
  EXEMPTION_CONTRADICTED: "6",
  DESIGNEE_INCONSISTENT: "3 4",
  OVER_COVERED: "7 8 9 10",
  TPMS_NOT_REGISTERED: "4",
};

/** With the mocked DBLP table: who gets a hint, and whether it says "possibly senior". */
export const EXPECTED_HINTS = {
  /** On exempted paper #11's authors. */
  paper11: [{ name: "Owen Pratt", atVenues: 7, possiblySenior: true }],
  /** On designees. */
  designees: [{ email: R.victor, atVenues: 2, possiblySenior: false }],
} as const;

/** Quick-reject queue items as `pid stage ac chair appeal signals warnings`. */
const q = (pid: number, stage: string, ac: string, chair: string, appeal: string, signals: string[], warnings: string[] = []) =>
  `${pid} ${stage} ac:${ac} chair:${chair} appeal:${appeal} signals:${signals.join(",") || "-"} warnings:${warnings.join(",") || "-"}`;

export const EXPECTED_QR_ITEMS: readonly string[] = [
  q(13, "ac-decision", "none", "none", "none", ["refcheck"]),
  q(14, "chair-action", "reject", "none", "none", ["ac-flag", "qr-verdict"]),
  q(15, "done", "reject", "desk-reject", "none", ["refcheck"]),
  q(16, "appeal", "reject", "desk-reject", "requested", ["qr-verdict"]),
  q(17, "done", "reject", "desk-reject", "overturned", ["ac-flag"]),
  q(18, "done", "keep", "none", "none", ["ac-flag"]),
  q(19, "done", "reject", "desk-reject", "none", [], ["DECISION_MISSING"]),
  q(21, "done", "reject", "desk-reject", "upheld", []),
];

/** Overdue quick-reject reviews as `pid email`. */
export const EXPECTED_QR_OVERDUE: readonly string[] = [`13 ${R.qr1}`];

/** Quick-reject mail drafts as `search -> recipients`. */
export const EXPECTED_QR_MAIL: readonly string[] = ["13 -> Reviewers with incomplete reviews", "13 -> Area chairs (metareviewers) of these papers"];

// Summaries in the formats above (shared by the unit and integration tests).

interface ReserveLike {
  findings: readonly { code: string; pids: readonly number[]; emails: readonly string[] }[];
}
interface QrLike {
  items: readonly {
    pid: number;
    stage: string;
    acDecision: string;
    chairAction: string;
    appealState: string;
    signals: readonly { kind: string }[];
    warnings: readonly { code: string }[];
  }[];
  overdueReviews: readonly { pid: number; email: string }[];
  mailDrafts: readonly { search: string; recipients: string }[];
}

export const summarizeReserve = (r: ReserveLike): string[] => r.findings.map((x) => f(x.code, [...x.pids], ...x.emails)).sort();

export const summarizeQr = (r: QrLike) => ({
  items: r.items.map((i) =>
    q(i.pid, i.stage, i.acDecision, i.chairAction, i.appealState, i.signals.map((s) => s.kind), i.warnings.map((w) => w.code)),
  ),
  overdue: r.overdueReviews.map((o) => `${o.pid} ${o.email}`),
  mail: r.mailDrafts.map((d) => `${d.search} -> ${d.recipients}`),
});
