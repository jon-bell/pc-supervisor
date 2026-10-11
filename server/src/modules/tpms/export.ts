// The file bundle for the TPMS operator (spec §10.3, `pcs export tpms <dir>`).
// TPMS has no API and no HotCRP integration; the chair sends these files:
//
//   pc.csv                       the PC: email,name,affiliation,tier,role,load_group
//   conflicts.csv                HotCRP's own "PC conflicts" CSV (get/pcconf)
//   load-<tier>.csv              one load group per tier, with its band:
//                                email,min_papers,max_papers
//   reviews-per-paper.csv        the per-paper target and its tier composition
//   README.txt                   what each file is, and how to get the PDFs
//
// The bundle holds reviewer emails and names by necessity (TPMS matches
// reviewers by email) and paper titles in conflicts.csv (HotCRP's format; the
// operator gets the PDFs anyway). It never holds review or comment text.
//
// Pure: buildTpmsBundle() takes the people, ACs, conflicts, and policy, so it
// is unit-testable with an in-memory store; the CLI fetches the conflicts.

import { LOAD_TIERS, type AssignmentPolicy, type LoadTier } from "../../config.js";
import type { PcConflictRow } from "../../hotcrp/schemas.js";
import type { PersonRow } from "../../store/store.js";

export interface TpmsBundleInput {
  people: readonly PersonRow[];
  /** Area chairs (PCS_AC_ROLE): exempt from load bands, like chairs. */
  acs: ReadonlySet<string>;
  conflicts: readonly PcConflictRow[];
  policy: Pick<AssignmentPolicy, "minSenior" | "thirdSlot" | "load">;
}

export interface TpmsFile {
  name: string;
  content: string;
  /** Data rows (CSV files), null for README.txt. */
  rows: number | null;
  /** One line for the CLI output. */
  about: string;
}

export interface TpmsBundle {
  files: TpmsFile[];
  counts: { pc: number; assignable: number; exempt: number; conflicts: number; loadGroups: number };
}

const csvCell = (v: string | number | null): string => {
  if (v === null) return "";
  const s = String(v);
  return /[",\r\n]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
};
const csv = (header: readonly string[], rows: readonly (readonly (string | number | null)[])[]): string =>
  [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\n") + "\n";

const LOAD_BANDS = new Set<string>(LOAD_TIERS.map(([t]) => t));
const STEM: Record<string, string> = Object.fromEntries(LOAD_TIERS);

/** File-name-safe tier name ("reserve-active" stays as is). */
const groupFile = (tier: string) => `load-${tier.replace(/[^a-z0-9_-]+/gi, "_")}.csv`;

export function buildTpmsBundle(input: TpmsBundleInput): TpmsBundle {
  const { policy } = input;
  const pc = input.people
    .filter((p) => p.isPc && p.removedSeenAt === null)
    .slice()
    .sort((a, b) => a.email.localeCompare(b.email));
  const role = (p: PersonRow) => (p.roles.includes("chair") ? "chair" : input.acs.has(p.email) ? "ac" : "reviewer");

  // Load groups: every non-exempt PC member, by tier.
  const groups = new Map<string, PersonRow[]>();
  for (const p of pc) {
    if (role(p) !== "reviewer") continue;
    groups.set(p.tier, [...(groups.get(p.tier) ?? []), p]);
  }
  const tiers = [...groups.keys()].sort((a, b) => {
    const ia = LOAD_TIERS.findIndex(([t]) => t === a);
    const ib = LOAD_TIERS.findIndex(([t]) => t === b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
  const band = (tier: string) => (LOAD_BANDS.has(tier) ? policy.load[tier as LoadTier] : null);

  const files: TpmsFile[] = [];
  files.push({
    name: "pc.csv",
    content: csv(
      ["email", "name", "affiliation", "tier", "role", "load_group"],
      pc.map((p) => [p.email, p.name, p.affiliation, p.tier, role(p), role(p) === "reviewer" ? groupFile(p.tier) : null]),
    ),
    rows: pc.length,
    about: "the PC with emails, tiers, and roles (chairs and ACs get no load group: don't assign them)",
  });

  const conflicts = input.conflicts.slice().sort((a, b) => a.pid - b.pid || a.email.localeCompare(b.email));
  files.push({
    name: "conflicts.csv",
    content: csv(
      ["paper", "title", "given_name", "family_name", "email", "conflicttype"],
      conflicts.map((c) => [c.pid, c.title, c.givenName, c.familyName, c.email, c.conflictType]),
    ),
    rows: conflicts.length,
    about: "HotCRP's PC conflicts (author conflicts included): never assign these pairs",
  });

  for (const tier of tiers) {
    const b = band(tier);
    const members = groups.get(tier)!;
    files.push({
      name: groupFile(tier),
      content: csv(["email", "min_papers", "max_papers"], members.map((p) => [p.email, b?.min ?? null, b?.max ?? null])),
      rows: members.length,
      about: b
        ? `${tier}: ${members.length} reviewer(s), ${b.min}-${b.max} papers each (PCS_LOAD_${STEM[tier]}_MIN/_MAX)`
        : `${tier}: ${members.length} reviewer(s), no load band configured for this tier (blank min/max)`,
    });
  }

  const third = policy.thirdSlot === "exactly1" ? { min: 1, max: 1 } : { min: 1, max: null };
  const perPaper = policy.minSenior + third.min;
  const thirdTiers = tiers.filter((t) => t !== "senior");
  files.push({
    name: "reviews-per-paper.csv",
    content: csv(
      ["reviews_per_paper", "senior_min", "third_slot_min", "third_slot_max", "third_slot_tiers"],
      [[perPaper, policy.minSenior, third.min, third.max, thirdTiers.join(";")]],
    ),
    rows: 1,
    about: `${perPaper} reviews per paper: at least ${policy.minSenior} senior (PCS_POLICY_MIN_SENIOR) + ${policy.thirdSlot === "exactly1" ? "exactly" : "at least"} 1 from ${thirdTiers.join(", ") || "(no third-slot tier)"} (PCS_POLICY_THIRD_SLOT=${policy.thirdSlot})`,
  });

  const loadLines = tiers.map((t) => {
    const b = band(t);
    return `  ${groupFile(t)}: ${groups.get(t)!.length} ${t} reviewer(s), ${b ? `${b.min}-${b.max} papers each` : "no band configured"}`;
  });
  files.push({
    name: "README.txt",
    content: [
      "Files for the TPMS operator, prepared by pc-supervisor (pcs export tpms).",
      "",
      "CONFIDENTIAL: these files contain reviewer emails and names, which TPMS needs to",
      "match reviewers to their profiles. They contain no reviews or comments. Send them",
      "only to the TPMS operator, over a private channel, and delete local copies after.",
      "",
      "pc.csv: email,name,affiliation,tier,role,load_group. One row per PC member. Only",
      "  role=reviewer rows are to be assigned; chairs and ACs are listed for completeness.",
      "conflicts.csv: HotCRP's PC conflicts download, unchanged in format:",
      "  paper,title,given_name,family_name,email,conflicttype. Never assign these pairs.",
      "load-<tier>.csv: one load group per tier: email,min_papers,max_papers.",
      ...loadLines,
      "reviews-per-paper.csv: reviews_per_paper,senior_min,third_slot_min,third_slot_max,third_slot_tiers.",
      `  Each paper needs ${perPaper} reviews: at least ${policy.minSenior} from load-senior.csv and ${policy.thirdSlot === "exactly1" ? "exactly" : "at least"} 1 from`,
      `  ${thirdTiers.map(groupFile).join(", ") || "(no third-slot group)"}. TPMS balances load only, so the chair checks`,
      "  this composition after import (pcs validate-assignments --tpms).",
      "",
      "Paper PDFs: download them from HotCRP itself (Search > Submitted > select all >",
      "Download > Documents: Submissions, a ZIP). Files are named by paper number.",
      "",
      "Please return the assignment as CSV with one row per (paper, reviewer email) pair,",
      "and, if possible, the full affinity matrix as paper,email,score with scores in 0-1.",
      "",
    ].join("\n"),
    rows: null,
    about: "what each file is, the confidentiality note, and how to get the PDFs",
  });

  const assignable = pc.filter((p) => role(p) === "reviewer").length;
  return {
    files,
    counts: { pc: pc.length, assignable, exempt: pc.length - assignable, conflicts: conflicts.length, loadGroups: tiers.length },
  };
}
