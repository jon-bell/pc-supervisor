// The assignment validator's checks (spec §10.4 C, PLAN M10). Pure functions:
// one per check, each returning findings whose reason carries the numbers
// and the PCS_* setting involved. validate() runs them in order and builds
// the fix-up CSV. See docs/spec.md §10.4 C for the semantics.
//
// Two row sets matter:
// - the *panel*: the proposal minus rows that can't be assignments at all
//   (duplicates, unknown papers, non-PC reviewers). Composition, load bands,
//   and cycles are judged on the panel, i.e. on the assignment as proposed.
// - the *fix-up*: the panel minus rows a check drops (author/affiliation/
//   co-author conflicts, reserve candidates not AC-approved, do-not-invite),
//   with the third slot trimmed to one under PCS_POLICY_THIRD_SLOT=exactly1.
//   What the fix-up then still lacks per paper is reported as `gaps`, not as
//   findings.

import { LOAD_TIERS, type AssignmentPolicy, type LoadTier } from "../../config.js";
import { findCycles } from "./cycles.js";
import type {
  AssignmentReport,
  CurrentAssignment,
  Finding,
  FixupGap,
  FixupLine,
  FixupReport,
  PersonInfo,
  ProposedRow,
  ValidatorInput,
} from "./types.js";

export const RESERVE_TIERS: ReadonlySet<string> = new Set(["reserve-active", "reserve-pool"]);
const LOAD_TIER_NAMES: ReadonlySet<string> = new Set(LOAD_TIERS.map(([t]) => t));
const LOAD_STEM: Readonly<Record<LoadTier, string>> = Object.fromEntries(LOAD_TIERS) as Record<LoadTier, string>;

/** Senior, or a third-slot tier (junior, reserve-*, or any other configured tier). */
export function isSenior(p: PersonInfo): boolean {
  return p.tier === "senior";
}

/** Affiliation for comparison: case, accents, punctuation, and spacing ignored. */
export function normalizeAffiliation(a: string | null | undefined): string {
  return (a ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

// ---------------------------------------------------------------------------
// Input rows

/** Duplicates, unknown papers, non-PC reviewers: never assignments. Returns the panel. */
export function checkInputRows(input: ValidatorInput): { panel: ProposedRow[]; findings: Finding[] } {
  const findings: Finding[] = [];
  const panel: ProposedRow[] = [];
  const seen = new Set<string>();
  const what = input.source === "tpms" ? `TPMS row (import #${input.tpmsRunId ?? "?"})` : "assignment";
  for (const r of input.proposal) {
    const k = `${r.pid}\t${r.email}`;
    if (seen.has(k)) {
      findings.push({ check: "input", code: "DUPLICATE_ROW", pid: r.pid, emails: [r.email], dropped: true, reason: `${what} for #${r.pid} and ${r.email} appears more than once; the first is used` });
      continue;
    }
    seen.add(k);
    if (!input.papers.has(r.pid)) {
      findings.push({ check: "input", code: "UNKNOWN_PAPER", pid: r.pid, emails: [r.email], dropped: true, reason: `${what}: paper #${r.pid} is not a live paper in the store (last sync)` });
      continue;
    }
    const p = input.people.get(r.email);
    if (!p || !p.isPc) {
      findings.push({ check: "input", code: "NOT_PC_MEMBER", pid: r.pid, emails: [r.email], dropped: true, reason: `${what} for #${r.pid}: ${r.email} is not a current PC member (activated reserves must be added to the PC first)` });
      continue;
    }
    panel.push(r);
  }
  return { panel, findings };
}

// ---------------------------------------------------------------------------
// Composition

export function checkComposition(panel: readonly ProposedRow[], input: ValidatorInput, policy: AssignmentPolicy): Finding[] {
  const findings: Finding[] = [];
  const byPid = groupByPid(panel);
  const pids = [...new Set([...input.papers.keys()])].sort((a, b) => a - b);
  // TPMS proposals are judged only on the papers they cover.
  const scope = input.source === "tpms" ? pids.filter((p) => byPid.has(p)) : pids;
  const need = policy.minSenior;
  const slot = `PCS_POLICY_THIRD_SLOT=${policy.thirdSlot}`;
  for (const pid of scope) {
    const rows = byPid.get(pid) ?? [];
    const seniors = rows.filter((r) => isSenior(input.people.get(r.email)!));
    const third = rows.length - seniors.length;
    const emails = rows.map((r) => r.email).sort();
    if (seniors.length === 0 && third > 0) {
      findings.push({ check: "composition", code: "ALL_JUNIOR_PANEL", pid, emails, reason: `#${pid} has 0 senior and ${third} junior/reserve reviewers; PCS_POLICY_MIN_SENIOR=${need}` });
    } else if (seniors.length < need) {
      findings.push({ check: "composition", code: "SENIOR_MISSING", pid, emails, reason: `#${pid} has ${plural(seniors.length, "senior reviewer")}; PCS_POLICY_MIN_SENIOR=${need}` });
    }
    if (third === 0) {
      findings.push({ check: "composition", code: "THIRD_SLOT_MISSING", pid, emails, reason: `#${pid} has 0 junior/reserve reviewers; ${slot} needs 1` });
    } else if (policy.thirdSlot === "exactly1" && third > 1) {
      findings.push({ check: "composition", code: "THIRD_SLOT_EXTRA", pid, emails, reason: `#${pid} has ${third} junior/reserve reviewers; ${slot} allows 1` });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Load bands

export function checkLoad(panel: readonly ProposedRow[], input: ValidatorInput, policy: AssignmentPolicy): Finding[] {
  const load = new Map<string, number>();
  for (const r of panel) load.set(r.email, (load.get(r.email) ?? 0) + 1);
  const findings: Finding[] = [];
  const people = [...input.people.values()].filter((p) => p.isPc && !p.exempt).sort((a, b) => a.email.localeCompare(b.email));
  for (const p of people) {
    if (!LOAD_TIER_NAMES.has(p.tier)) continue;
    const tier = p.tier as LoadTier;
    const band = policy.load[tier];
    const n = load.get(p.email) ?? 0;
    const stem = `PCS_LOAD_${LOAD_STEM[tier]}`;
    if (n > band.max) {
      findings.push({ check: "load", code: "LOAD_OVER", emails: [p.email], reason: `${p.email} (${tier}) has ${plural(n, "review assignment")}; ${stem}_MAX=${band.max}` });
    } else if (n < band.min) {
      // In tpms mode only people the proposal mentions are judged.
      if (input.source === "tpms" && n === 0) continue;
      findings.push({ check: "load", code: "LOAD_UNDER", emails: [p.email], reason: `${p.email} (${tier}) has ${plural(n, "review assignment")}; ${stem}_MIN=${band.min}` });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Conflict sanity (author, same affiliation, optional co-authorship)

export function checkConflicts(panel: readonly ProposedRow[], input: ValidatorInput, policy: AssignmentPolicy): Finding[] {
  const findings: Finding[] = [];
  for (const r of panel) {
    const paper = input.papers.get(r.pid)!;
    const reviewer = input.people.get(r.email)!;
    if (paper.authors.some((a) => a.email === r.email)) {
      findings.push({ check: "conflict", code: "AUTHOR_IS_REVIEWER", pid: r.pid, emails: [r.email], dropped: true, reason: `${r.email} is an author of #${r.pid} and is assigned to review it` });
      continue;
    }
    if (policy.affiliationConflicts) {
      const ra = normalizeAffiliation(reviewer.affiliation);
      if (ra !== "") {
        const hits = paper.authors.filter((a) => normalizeAffiliation(a.affiliation) === ra);
        if (hits.length > 0) {
          findings.push({
            check: "conflict",
            code: "SAME_AFFILIATION",
            pid: r.pid,
            emails: [r.email, ...hits.map((a) => a.email ?? "(no email)")],
            dropped: true,
            reason: `reviewer ${r.email} and ${plural(hits.length, "author")} of #${r.pid} share affiliation "${reviewer.affiliation}" (PCS_CONFLICT_AFFILIATION=true)`,
          });
          continue;
        }
      }
    }
    if (policy.dblpConflicts && input.coauthors) {
      for (const a of paper.authors) {
        if (!a.email) continue;
        const n = input.coauthors.coauthored(r.email, a.email);
        if (n !== undefined && n > 0) {
          findings.push({
            check: "conflict",
            code: "COAUTHOR",
            pid: r.pid,
            emails: [r.email, a.email],
            dropped: true,
            reason: `reviewer ${r.email} co-authored ${plural(n, "paper")} with ${a.email}, an author of #${r.pid} (${input.coauthors.label}; a hint, not a verdict)`,
          });
          break;
        }
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Reserve candidates: AC-approved in the latest invites import, not on do-not-invite

export function checkReserve(panel: readonly ProposedRow[], input: ValidatorInput): Finding[] {
  const findings: Finding[] = [];
  const dni = new Set((input.doNotInvite?.rows ?? []).map((r) => r.email));
  const invites = new Map((input.invites?.rows ?? []).map((r) => [`${r.pid}\t${r.candidate_email}`, r]));
  for (const r of panel) {
    const p = input.people.get(r.email)!;
    if (dni.has(r.email)) {
      findings.push({ check: "reserve", code: "DO_NOT_INVITE", pid: r.pid, emails: [r.email], dropped: true, reason: `${r.email} (${p.tier}) on #${r.pid} is on the do-not-invite list (import #${input.doNotInvite!.runId})` });
    }
    if (!RESERVE_TIERS.has(p.tier)) continue;
    let why: string | undefined;
    if (!input.invites) {
      why = "no invites import yet (pcs import invites <file>)";
    } else {
      const inv = invites.get(`${r.pid}\t${r.email}`);
      const run = `invites import #${input.invites.runId}`;
      if (!inv) why = `${run} has no row for #${r.pid} and this candidate`;
      else if (inv.ac_decision !== "approve") why = `${run} says ac_decision=${inv.ac_decision} for #${r.pid} (needs approve)`;
      else if (inv.response === "decline") why = `${run} says ac_decision=approve but response=decline for #${r.pid}`;
    }
    if (why) {
      findings.push({ check: "reserve", code: "RESERVE_NOT_APPROVED", pid: r.pid, emails: [r.email], dropped: true, reason: `reserve candidate ${r.email} (${p.tier}) on #${r.pid}: ${why}` });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Reciprocal cycles

export function checkCycles(
  panel: readonly ProposedRow[],
  input: ValidatorInput,
  policy: AssignmentPolicy,
): { findings: Finding[]; truncated: boolean; count: number } {
  const edges = [];
  const reviewers = groupByPid(panel);
  for (const [pid, rows] of reviewers) {
    for (const a of input.papers.get(pid)!.authors) {
      if (!a.email) continue;
      for (const r of rows) if (r.email !== a.email) edges.push({ from: a.email, to: r.email, pid });
    }
  }
  const res = findCycles(edges, policy.cycleMaxK, policy.cycleMaxReport);
  const findings = res.cycles.map((c): Finding => {
    const k = c.nodes.length;
    const steps = c.nodes.map((a, i) => `${a} authors ${c.pids[i]!.map((p) => `#${p}`).join("/")}, reviewed by ${c.nodes[(i + 1) % k]}`);
    return {
      check: "cycle",
      code: "RECIPROCAL_CYCLE",
      pid: Math.min(...c.pids.flat()),
      emails: c.nodes,
      cyclePids: c.pids,
      reason: `reciprocal ${k}-cycle (PCS_CYCLE_MAX_K=${policy.cycleMaxK}): ${steps.join("; ")}. For human review only`,
    };
  });
  return { findings, truncated: res.truncated, count: res.cycles.length };
}

// ---------------------------------------------------------------------------
// Fix-up CSV

const ROLE_ACTION: Record<CurrentAssignment["role"], FixupLine["action"]> = {
  primary: "primary",
  secondary: "secondary",
  pc: "pcreview",
};

/** Statuses of a review nobody has started; only those are safe to clear. */
export const CLEARABLE_STATUSES: ReadonlySet<string> = new Set(["empty"]);

function byScore(a: ProposedRow, b: ProposedRow): number {
  return (b.score ?? -Infinity) - (a.score ?? -Infinity) || a.email.localeCompare(b.email);
}

export function buildFixup(
  panel: readonly ProposedRow[],
  dropped: ReadonlySet<string>,
  input: ValidatorInput,
  policy: AssignmentPolicy,
): FixupReport {
  const kept = panel.filter((r) => !dropped.has(`${r.pid}\t${r.email}`));
  const current = new Map(input.current.map((c) => [`${c.pid}\t${c.email}`, c]));
  const currentByPid = new Map<number, CurrentAssignment[]>();
  for (const c of input.current) (currentByPid.get(c.pid) ?? currentByPid.set(c.pid, []).get(c.pid)!).push(c);
  const byPid = groupByPid(kept);
  // Papers in scope: hotcrp mode = every live paper; tpms mode = papers the proposal covers.
  const scope = input.source === "tpms"
    ? [...new Set(input.proposal.map((r) => r.pid))].filter((p) => input.papers.has(p))
    : [...input.papers.keys()];
  scope.sort((a, b) => a - b);

  const lines: FixupLine[] = [];
  const gaps: FixupGap[] = [];
  const keptStarted: FixupReport["keptStarted"] = [];
  for (const pid of scope) {
    const rows = byPid.get(pid) ?? [];
    const seniors = rows.filter((r) => isSenior(input.people.get(r.email)!)).sort(byScore);
    let third = rows.filter((r) => !isSenior(input.people.get(r.email)!)).sort(byScore);
    if (policy.thirdSlot === "exactly1") third = third.slice(0, 1);
    const want = new Set([...seniors, ...third].map((r) => r.email));
    // Remove current assignments the fix-up doesn't keep, if nobody started the review.
    for (const c of (currentByPid.get(pid) ?? []).slice().sort((a, b) => a.email.localeCompare(b.email))) {
      if (want.has(c.email)) continue;
      if (c.status === null || CLEARABLE_STATUSES.has(c.status)) lines.push({ pid, action: "clearreview", email: c.email, slot: "remove" });
      else keptStarted.push({ pid, email: c.email, status: c.status });
    }
    const action = (r: ProposedRow, dflt: FixupLine["action"]) => {
      const c = current.get(`${pid}\t${r.email}`);
      return c ? ROLE_ACTION[c.role] : dflt;
    };
    for (const r of seniors) lines.push({ pid, action: action(r, "primary"), email: r.email, slot: "senior" });
    for (const r of third) lines.push({ pid, action: action(r, "secondary"), email: r.email, slot: "third" });
    const gap = { pid, seniorsMissing: Math.max(0, policy.minSenior - seniors.length), thirdMissing: third.length === 0 ? 1 : 0 };
    if (gap.seniorsMissing > 0 || gap.thirdMissing > 0) gaps.push(gap);
  }
  const csv = ["paper,action,user", ...lines.map((l) => `${l.pid},${l.action},${l.email}`)].join("\n") + "\n";
  return { csv, lines, gaps, keptStarted };
}

// ---------------------------------------------------------------------------

const CHECK_ORDER = ["input", "composition", "load", "conflict", "reserve", "cycle"] as const;

/** Run every check and build the fix-up CSV. */
export function validate(input: ValidatorInput, policy: AssignmentPolicy): AssignmentReport {
  const notes: string[] = [];
  const { panel, findings: inputFindings } = checkInputRows(input);
  const conflicts = checkConflicts(panel, input, policy);
  const reserve = checkReserve(panel, input);
  const cycles = checkCycles(panel, input, policy);
  if (policy.dblpConflicts && !input.coauthors) {
    notes.push("PCS_CONFLICT_DBLP=true, but no co-authorship source is available in this version; that check was skipped");
  }
  if (cycles.truncated) notes.push(`more than PCS_CYCLE_MAX_REPORT=${policy.cycleMaxReport} reciprocal cycles; only the first ${policy.cycleMaxReport} are listed`);
  const findings = [
    ...inputFindings,
    ...checkComposition(panel, input, policy),
    ...checkLoad(panel, input, policy),
    ...conflicts,
    ...reserve,
    ...cycles.findings,
  ];
  findings.sort(
    (a, b) =>
      CHECK_ORDER.indexOf(a.check) - CHECK_ORDER.indexOf(b.check) ||
      (a.pid ?? 0) - (b.pid ?? 0) ||
      (a.emails[0] ?? "").localeCompare(b.emails[0] ?? "") ||
      a.code.localeCompare(b.code),
  );
  const dropped = new Set([...conflicts, ...reserve].filter((f) => f.dropped).map((f) => `${f.pid}\t${f.emails[0]}`));
  const fixup = buildFixup(panel, dropped, input, policy);
  return {
    source: input.source,
    policy,
    imports: {
      invitesRunId: input.invites?.runId ?? null,
      doNotInviteRunId: input.doNotInvite?.runId ?? null,
      tpmsRunId: input.tpmsRunId ?? null,
    },
    counts: {
      papers: input.papers.size,
      rows: input.proposal.length,
      rowsKept: fixup.lines.filter((l) => l.slot !== "remove").length,
      findings: findings.length,
      cycles: cycles.count,
    },
    findings,
    cyclesTruncated: cycles.truncated,
    fixup,
    notes,
  };
}

function groupByPid(rows: readonly ProposedRow[]): Map<number, ProposedRow[]> {
  const m = new Map<number, ProposedRow[]>();
  for (const r of rows) (m.get(r.pid) ?? m.set(r.pid, []).get(r.pid)!).push(r);
  return m;
}
