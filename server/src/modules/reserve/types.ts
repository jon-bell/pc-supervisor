// Types of the reserve-compliance module (spec §10.4 A, PLAN M11). The check
// is pure: checkReserve() takes a ReserveInput (built from the store and the
// imports by load.ts), a ReservePolicy (PCS_RESERVE_*), and optional DBLP
// hints, and returns a ReserveReport. Nothing here calls HotCRP.

import type { ReservePolicy } from "../../config.js";
import type { TpmsRegistrationRow } from "../../imports/kinds.js";
import type { AuthorHint } from "./dblp.js";

export type ReserveCode =
  // per paper (non-compliance)
  | "DESIGNEE_MISSING"
  | "DESIGNEE_UNRESOLVED"
  | "DESIGNEE_NOT_AUTHOR"
  | "EXEMPTION_NOT_ALLOWED"
  | "EXEMPTION_CONTRADICTED"
  // per designee (warnings)
  | "DESIGNEE_INCONSISTENT"
  | "OVER_COVERED"
  | "TPMS_NOT_REGISTERED"
  | "TPMS_FEW_PAPERS";

export type Severity = "noncompliant" | "warning";

export interface ReserveFinding {
  code: ReserveCode;
  severity: Severity;
  /** Papers involved, ascending. */
  pids: number[];
  /** People involved (designee emails), sorted. */
  emails: string[];
  /** With the actual numbers and the PCS_* setting involved. */
  reason: string;
}

export interface InputAuthor {
  email: string | null;
  name: string | null;
}

export interface InputPaper {
  pid: number;
  title: string;
  authors: readonly InputAuthor[];
  /** Raw option values (undefined = unset). */
  designee: unknown;
  exemption: unknown;
  seniority: unknown;
}

export interface ReserveInput {
  /** Live, non-withdrawn papers. */
  papers: readonly InputPaper[];
  /** Which of the configured options exist in HotCRP (from the last sync), with their type. */
  fields: { designee: string | null | undefined; exemption: string | null | undefined; seniority: string | null | undefined };
  /** Current PC members (lowercased emails). */
  pc: ReadonlySet<string>;
  /** Names the store knows, by email (for designees not in an author list). */
  names: ReadonlyMap<string, string>;
  /** Latest tpms-registrations import as of now; undefined = none. */
  tpms: { runId: number; rows: readonly TpmsRegistrationRow[] } | undefined;
}

/** "unchecked": neither option exists in HotCRP, so nothing could be checked. */
export type PaperState = "designee" | "exempt" | "noncompliant" | "unchecked";

export interface PaperCompliance {
  pid: number;
  title: string;
  state: PaperState;
  /** The resolved designee email, if any. */
  designee: string | null;
  /** How the designee was identified: from an email in the field, or by matching a name to an author. */
  identifiedBy: "email" | "name" | null;
  /** The exemption reason claimed, if any (as entered). */
  exemption: string | null;
  /** The self-declared seniority note (PCS_RESERVE_SENIORITY_FIELD), if any. Author-provided, not review text. */
  seniorityNote: string | null;
  /** Codes of the per-paper findings. */
  codes: ReserveCode[];
  /** DBLP hints for the authors of an exempted paper (hints, never verdicts). */
  hints: AuthorHint[];
}

export interface DesigneeSummary {
  email: string;
  name: string | null;
  /** Papers that name this email, ascending. */
  pids: number[];
  cover: number;
  /** Other emails designated for the same normalized name (the inconsistency check). */
  aliases: string[];
  /** From the tpms-registrations import; null = no import, or no row. */
  tpms: { registered: boolean; papersUploaded: number | null } | null;
  codes: ReserveCode[];
  hint: AuthorHint | null;
}

export interface MailDraft {
  code: ReserveCode;
  /** What the mail is about. */
  label: string;
  /** A HotCRP search (paper numbers) for the Mail tool. */
  search: string;
  /** Which recipients to pick in HotCRP's Mail tool. */
  recipients: string;
  papers: number;
}

export interface ReserveReport {
  policy: ReservePolicy;
  imports: { tpmsRegistrationsRunId: number | null };
  counts: {
    papers: number;
    designee: number;
    exempt: number;
    noncompliant: number;
    designees: number;
    warnings: number;
  };
  papers: PaperCompliance[];
  designees: DesigneeSummary[];
  /** Ordered: per-paper codes by pid, then per-designee codes by email. */
  findings: ReserveFinding[];
  mailDrafts: MailDraft[];
  dblp: { enabled: boolean; source: string | null; looked: number; pending: number; failed: number };
  notes: string[];
}

/** DBLP hints by name, as known when the report is built. */
export type HintSource = (name: string) => AuthorHint | undefined;
