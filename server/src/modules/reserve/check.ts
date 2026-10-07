// Reserve-compliance checks (spec §10.4 A, PLAN M11). Pure functions, one
// per check; each finding's reason carries the numbers and the PCS_* setting
// involved. checkReserve() runs them and assembles the report. See
// docs/spec.md §10.4 A for the semantics.

import type { ReservePolicy } from "../../config.js";
import { HINT_DISCLAIMER, type AuthorHint } from "./dblp.js";
import { normalizeName, normalizeReason, parseDesignee } from "./normalize.js";
import type {
  DesigneeSummary,
  HintSource,
  InputPaper,
  MailDraft,
  PaperCompliance,
  ReserveCode,
  ReserveFinding,
  ReserveInput,
  ReserveReport,
} from "./types.js";

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const sortNum = (xs: Iterable<number>) => [...new Set(xs)].sort((a, b) => a - b);

/** A resolved designation: paper `pid` names `email`. */
export interface Designation {
  pid: number;
  email: string;
  /** The name to group by: from "Name <email>", the paper's author record, or the store. */
  name: string | null;
  identifiedBy: "email" | "name";
}

const asText = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

/** Per paper: the designee (if any) and its per-paper findings. */
export function checkDesignee(
  p: InputPaper,
  input: Pick<ReserveInput, "names">,
  policy: ReservePolicy,
): { designation: Designation | null; findings: ReserveFinding[] } {
  const field = `"${policy.designeeField}" (PCS_RESERVE_DESIGNEE_FIELD)`;
  const v = parseDesignee(p.designee);
  const f = (code: ReserveCode, reason: string, emails: string[] = []): ReserveFinding => ({
    code,
    severity: "noncompliant",
    pids: [p.pid],
    emails,
    reason,
  });
  if (v.kind === "empty") return { designation: null, findings: [] };
  if (v.kind === "invalid") {
    return { designation: null, findings: [f("DESIGNEE_UNRESOLVED", `#${p.pid}: ${field} is ${v.why}; it names nobody`)] };
  }
  if (v.kind === "name") {
    const want = normalizeName(v.name);
    const hits = p.authors.filter((a) => a.email && normalizeName(a.name) === want);
    if (hits.length !== 1) {
      return {
        designation: null,
        findings: [
          f(
            "DESIGNEE_UNRESOLVED",
            `#${p.pid}: ${field} holds a name, not an email, and it matches ${hits.length} of the paper's ${plural(p.authors.length, "author")} with an email (need exactly 1)`,
          ),
        ],
      };
    }
    const email = hits[0]!.email!;
    return { designation: { pid: p.pid, email, name: hits[0]!.name, identifiedBy: "name" }, findings: [] };
  }
  const author = p.authors.find((a) => a.email === v.email);
  const designation: Designation = {
    pid: p.pid,
    email: v.email,
    name: v.name ?? author?.name ?? input.names.get(v.email) ?? null,
    identifiedBy: "email",
  };
  if (!author) {
    return {
      designation,
      findings: [
        f(
          "DESIGNEE_NOT_AUTHOR",
          `#${p.pid}: designee ${v.email} is not among the paper's ${plural(p.authors.length, "author")}; the designee must be an author`,
          [v.email],
        ),
      ],
    };
  }
  return { designation, findings: [] };
}

/** Per paper without a designee: is there a valid exemption claim? */
export function checkExemption(p: InputPaper, pc: ReadonlySet<string>, policy: ReservePolicy): ReserveFinding[] {
  const claim = asText(p.exemption);
  const f = (code: ReserveCode, reason: string): ReserveFinding => ({ code, severity: "noncompliant", pids: [p.pid], emails: [], reason });
  if (claim === null) {
    return [
      f(
        "DESIGNEE_MISSING",
        `#${p.pid}: no reserve designee ("${policy.designeeField}") and no exemption ("${policy.exemptionField}") among ${plural(p.authors.length, "author")}`,
      ),
    ];
  }
  const allowed = new Map(policy.exemptions.map((e) => [normalizeReason(e), e]));
  if (!allowed.has(normalizeReason(claim))) {
    return [
      f(
        "EXEMPTION_NOT_ALLOWED",
        `#${p.pid}: exemption "${claim}" is not one of the ${policy.exemptions.length} reasons in PCS_RESERVE_EXEMPTIONS (${policy.exemptions.join(", ")})`,
      ),
    ];
  }
  if (policy.exemptionAllPc !== "" && normalizeReason(claim) === normalizeReason(policy.exemptionAllPc)) {
    const off = p.authors.filter((a) => !a.email || !pc.has(a.email));
    if (off.length > 0) {
      return [
        f(
          "EXEMPTION_CONTRADICTED",
          `#${p.pid}: exemption "${claim}" (PCS_RESERVE_EXEMPTION_ALL_PC) but ${off.length} of ${plural(p.authors.length, "author")} ${off.length === 1 ? "is" : "are"} not on the PC`,
        ),
      ];
    }
  }
  return [];
}

/** Per person: the same normalized name designated under more than one email. */
export function checkConsistency(ds: readonly Designation[]): ReserveFinding[] {
  const byName = new Map<string, Designation[]>();
  for (const d of ds) {
    const k = normalizeName(d.name);
    if (k === "") continue;
    let list = byName.get(k);
    if (!list) byName.set(k, (list = []));
    list.push(d);
  }
  const out: ReserveFinding[] = [];
  for (const list of byName.values()) {
    const emails = [...new Set(list.map((d) => d.email))].sort();
    if (emails.length < 2) continue;
    const per = emails.map((e) => `${e} on ${sortNum(list.filter((d) => d.email === e).map((d) => d.pid)).map((x) => `#${x}`).join(", ")}`);
    out.push({
      code: "DESIGNEE_INCONSISTENT",
      severity: "warning",
      pids: sortNum(list.map((d) => d.pid)),
      emails,
      reason: `"${list[0]!.name}" is designated under ${emails.length} different emails across ${plural(new Set(list.map((d) => d.pid)).size, "paper")}: ${per.join("; ")}`,
    });
  }
  return out;
}

/** Per person: designated by more than PCS_RESERVE_MAX_COVER papers. */
export function checkCoverage(ds: readonly Designation[], policy: ReservePolicy): ReserveFinding[] {
  const byEmail = new Map<string, number[]>();
  for (const d of ds) byEmail.set(d.email, [...(byEmail.get(d.email) ?? []), d.pid]);
  const out: ReserveFinding[] = [];
  for (const [email, pids] of [...byEmail].sort((a, b) => a[0].localeCompare(b[0]))) {
    const n = new Set(pids).size;
    if (n <= policy.maxCover) continue;
    out.push({
      code: "OVER_COVERED",
      severity: "warning",
      pids: sortNum(pids),
      emails: [email],
      reason: `${email} is the designee of ${n} papers, more than PCS_RESERVE_MAX_COVER=${policy.maxCover} (coverage does not scale the obligation)`,
    });
  }
  return out;
}

/** Per person, with a tpms-registrations import: registered, and enough papers uploaded. */
export function checkTpms(
  ds: readonly Designation[],
  tpms: ReserveInput["tpms"],
  policy: ReservePolicy,
): ReserveFinding[] {
  if (!tpms) return [];
  const rows = new Map(tpms.rows.map((r) => [r.email.toLowerCase(), r]));
  const emails = [...new Set(ds.map((d) => d.email))].sort();
  const out: ReserveFinding[] = [];
  for (const email of emails) {
    const pids = sortNum(ds.filter((d) => d.email === email).map((d) => d.pid));
    const r = rows.get(email);
    if (!r || !r.registered) {
      out.push({
        code: "TPMS_NOT_REGISTERED",
        severity: "warning",
        pids,
        emails: [email],
        reason: `${email} (designee of ${plural(pids.length, "paper")}) is ${r ? "listed as not registered in" : "not in"} the tpms-registrations import #${tpms.runId}`,
      });
    } else if (r.papers_uploaded !== null && r.papers_uploaded < policy.tpmsMinPapers) {
      out.push({
        code: "TPMS_FEW_PAPERS",
        severity: "warning",
        pids,
        emails: [email],
        reason: `${email} is registered with TPMS but uploaded ${r.papers_uploaded} papers, fewer than PCS_RESERVE_TPMS_MIN_PAPERS=${policy.tpmsMinPapers} (import #${tpms.runId})`,
      });
    }
  }
  return out;
}

const DRAFTS: Partial<Record<ReserveCode, { label: string; recipients: string }>> = {
  DESIGNEE_MISSING: { label: "Name a reserve designee or claim an exemption", recipients: "Contact authors" },
  DESIGNEE_UNRESOLVED: { label: "The reserve designee field doesn't name an author; please give their email", recipients: "Contact authors" },
  DESIGNEE_NOT_AUTHOR: { label: "The reserve designee must be an author of the paper", recipients: "Contact authors" },
  EXEMPTION_NOT_ALLOWED: { label: "The exemption reason isn't one of the allowed reasons", recipients: "Contact authors" },
  EXEMPTION_CONTRADICTED: { label: "The exemption says every author is on the PC, but some aren't", recipients: "Contact authors" },
  DESIGNEE_INCONSISTENT: { label: "The same designee is named with different emails; please use one", recipients: "Contact authors" },
  OVER_COVERED: { label: "The designee is named by many papers; please confirm or name another author", recipients: "Contact authors" },
  TPMS_NOT_REGISTERED: { label: "The designee must register with TPMS using their HotCRP email", recipients: "Contact authors" },
  TPMS_FEW_PAPERS: { label: "The designee should upload papers to their TPMS profile", recipients: "Contact authors" },
};

/** One HotCRP Mail-tool search per finding code: the paper numbers involved. */
export function mailDrafts(findings: readonly ReserveFinding[]): MailDraft[] {
  const byCode = new Map<ReserveCode, Set<number>>();
  for (const f of findings) {
    let s = byCode.get(f.code);
    if (!s) byCode.set(f.code, (s = new Set()));
    for (const p of f.pids) s.add(p);
  }
  return [...byCode].map(([code, pids]) => {
    const d = DRAFTS[code] ?? { label: code, recipients: "Contact authors" };
    const list = sortNum(pids);
    return { code, label: d.label, recipients: d.recipients, search: list.join(" "), papers: list.length };
  });
}

/** Names worth a DBLP hint: designees, and the authors of papers that claim an exemption. */
export function hintNames(input: ReserveInput, policy: ReservePolicy): string[] {
  const names = new Set<string>();
  for (const p of input.papers) {
    const { designation } = checkDesignee(p, input, policy);
    if (designation?.name) names.add(designation.name);
    else if (!designation && asText(p.exemption) !== null) for (const a of p.authors) if (a.name) names.add(a.name);
  }
  return [...names].sort();
}

const CODE_ORDER: readonly ReserveCode[] = [
  "DESIGNEE_MISSING",
  "DESIGNEE_UNRESOLVED",
  "DESIGNEE_NOT_AUTHOR",
  "EXEMPTION_NOT_ALLOWED",
  "EXEMPTION_CONTRADICTED",
  "DESIGNEE_INCONSISTENT",
  "OVER_COVERED",
  "TPMS_NOT_REGISTERED",
  "TPMS_FEW_PAPERS",
];

export function checkReserve(input: ReserveInput, policy: ReservePolicy, hints?: HintSource): ReserveReport {
  const notes: string[] = [];
  const designeeDefined = input.fields.designee !== undefined;
  const exemptionDefined = input.fields.exemption !== undefined;
  if (!designeeDefined) notes.push(`HotCRP has no submission option "${policy.designeeField}" (PCS_RESERVE_DESIGNEE_FIELD) at the last sync`);
  if (!exemptionDefined) notes.push(`HotCRP has no submission option "${policy.exemptionField}" (PCS_RESERVE_EXEMPTION_FIELD) at the last sync`);
  if (designeeDefined && input.fields.designee !== "text") {
    notes.push(`"${policy.designeeField}" is a ${input.fields.designee ?? "untyped"} option; a text option holding the designee's email is expected`);
  }
  const active = designeeDefined || exemptionDefined;
  if (!active) notes.push("Neither option exists, so no paper was checked");
  if (!input.tpms) notes.push("No tpms-registrations import yet, so TPMS registration was not checked (pcs import tpms-registrations <file>)");

  const findings: ReserveFinding[] = [];
  const rows: PaperCompliance[] = [];
  const designations: Designation[] = [];
  const hint = (name: string | null | undefined): AuthorHint | undefined => (name && hints ? hints(name) : undefined);

  for (const p of [...input.papers].sort((a, b) => a.pid - b.pid)) {
    const own: ReserveFinding[] = [];
    let d: Designation | null = null;
    if (active) {
      const r = checkDesignee(p, input, policy);
      d = r.designation;
      own.push(...r.findings);
      if (d) designations.push(d);
      else if (r.findings.length === 0) own.push(...checkExemption(p, input.pc, policy));
    }
    findings.push(...own);
    const claim = asText(p.exemption);
    const exempt = !d && own.length === 0 && claim !== null;
    rows.push({
      pid: p.pid,
      title: p.title,
      state: !active ? "unchecked" : own.length > 0 ? "noncompliant" : d ? "designee" : exempt ? "exempt" : "noncompliant",
      designee: d?.email ?? null,
      identifiedBy: d?.identifiedBy ?? null,
      exemption: claim,
      seniorityNote: asText(p.seniority),
      codes: own.map((f) => f.code),
      hints: exempt ? p.authors.flatMap((a) => hint(a.name) ?? []) : [],
    });
  }

  const personFindings = [...checkConsistency(designations), ...checkCoverage(designations, policy), ...checkTpms(designations, input.tpms, policy)];
  findings.push(...personFindings);
  findings.sort((a, b) => CODE_ORDER.indexOf(a.code) - CODE_ORDER.indexOf(b.code) || (a.pids[0] ?? 0) - (b.pids[0] ?? 0) || a.emails.join().localeCompare(b.emails.join()));

  const tpmsRows = new Map((input.tpms?.rows ?? []).map((r) => [r.email.toLowerCase(), r]));
  const byEmail = new Map<string, Designation[]>();
  for (const d of designations) byEmail.set(d.email, [...(byEmail.get(d.email) ?? []), d]);
  const designees: DesigneeSummary[] = [...byEmail]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([email, ds]) => {
      const name = ds.find((d) => d.name)?.name ?? null;
      const mine = personFindings.filter((f) => f.emails.includes(email));
      const aliases = mine.filter((f) => f.code === "DESIGNEE_INCONSISTENT").flatMap((f) => f.emails.filter((e) => e !== email));
      const t = tpmsRows.get(email);
      return {
        email,
        name,
        pids: sortNum(ds.map((d) => d.pid)),
        cover: new Set(ds.map((d) => d.pid)).size,
        aliases: [...new Set(aliases)].sort(),
        tpms: t ? { registered: t.registered, papersUploaded: t.papers_uploaded } : null,
        codes: [...new Set(mine.map((f) => f.code))],
        hint: hint(name) ?? null,
      };
    });

  return {
    policy,
    imports: { tpmsRegistrationsRunId: input.tpms?.runId ?? null },
    counts: {
      papers: rows.length,
      designee: rows.filter((r) => r.state === "designee").length,
      exempt: rows.filter((r) => r.state === "exempt").length,
      noncompliant: rows.filter((r) => r.state === "noncompliant").length,
      designees: designees.length,
      warnings: personFindings.length,
    },
    papers: rows,
    designees,
    findings,
    mailDrafts: mailDrafts(findings),
    dblp: { enabled: policy.dblp.enabled, source: null, looked: 0, pending: 0, failed: 0 },
    notes: policy.dblp.enabled ? [...notes, `DBLP results are hints: ${HINT_DISCLAIMER}`] : notes,
  };
}

