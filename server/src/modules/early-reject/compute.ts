// Early reject (spec §10.4 E, PLAN M12). Pure: (snapshot index, settings,
// window, now) -> report. O(rows). Everything "as of" an instant comes from
// the store's snapshot history (review_version), so the report is the same
// at any PCS_NOW, whenever the syncs ran, as long as one saw each version.
//
// Definitions (spec §10.4 E repeats them):
// - Review state as of T: the review's latest observed version with time <= T
//   (version time = HotCRP modified_at, else when a sync first saw it; see
//   views/snapshot.ts). A review with no version by T did not exist yet.
// - Reviewer review: not a metareview and not by one of the paper's ACs.
//   "Merits as of T": the merits of reviewer reviews submitted as of T.
// - Band: reject_only -> merit <= PCS_MERIT_REJECT_MAX (default 1);
//   include_weak_reject -> merit <= PCS_MERIT_WEAK_REJECT_MAX (default
//   PCS_MERIT_ACCEPT_MIN - 1).
// - Candidate as of T: undecided as of T (no decision, or one the sync first
//   saw after T), at least PCS_EARLYREJECT_MIN_REVIEWS (default
//   PCS_REVIEWS_REQUIRED) merits as of T, every one of them in the band.
// - Window: OPEN = PCS_PHASE_EARLYREJECT_OPEN; CLOSE = PCS_PHASE_EARLYREJECT_CLOSE,
//   or OPEN + PCS_EARLYREJECT_WINDOW_H when only OPEN is set (config.ts).
//   Before OPEN, candidates are provisional, as of now, and there are no
//   outcomes. From OPEN on, candidates are as of OPEN and outcomes as of
//   E = min(now, CLOSE): "so far" while the window is open, final after it.
// - Bumped: at least one reviewer's merit as of E is higher than as of OPEN
//   (any raise, even one that stays in the band; stillInBand says whether it
//   left). Lowered merits and reviews submitted during the window are not bumps.
// - Responded (per reviewer with a merit as of OPEN on a candidate): a merit
//   change, either way, in a version with time in (OPEN, E], or a published
//   non-response comment by them on the paper with time in [OPEN, E].
//   Never responded = neither. Comment time is the earliest known (snapshot.ts).

import type { EarlyRejectSettings } from "../../config.js";
import { isSubmitted, type SnapshotIndex } from "../../rules/facts.js";
import { DEFAULT_TIER, type Millis, type ReviewVersionView, type ReviewView } from "../../rules/model.js";
import type { Candidate, CandidateReview, EarlyRejectReport, ErPerson, MailDraft, NoResponseRow, WindowStatus } from "./types.js";

export interface EarlyRejectWindow {
  open: Millis | null;
  close: Millis | null;
  closeSource: "env" | "window-hours" | null;
}

/** The review's latest observed version at or before t (versions are oldest first). */
export function versionAt(r: ReviewView, t: Millis): ReviewVersionView | null {
  let out: ReviewVersionView | null = null;
  for (const v of r.versions) {
    if (v.seenAt <= t) out = v;
    else break;
  }
  if (out === null && r.versions.length === 0 && (r.modifiedAt ?? r.firstSeenAt) <= t) {
    return { seenAt: r.modifiedAt ?? r.firstSeenAt, merit: r.merit, expertise: r.expertise, status: r.status };
  }
  return out;
}

const meritAt = (r: ReviewView, t: Millis): number | null => {
  const v = versionAt(r, t);
  return v && isSubmitted(v) ? v.merit : null;
};

export function bandMax(s: EarlyRejectSettings): number {
  return s.policy === "reject_only" ? s.rejectMax : s.weakRejectMax;
}

export interface EarlyRejectOptions {
  tz: string;
  /** Formats an instant for reasons and the mail draft (tz.ts formatInZone in production). */
  fmt: (t: Millis) => string;
  /** Latest successful sync at or before OPEN (epoch ms), for the report's note. */
  syncAtOpen?: Millis | null;
}

export function computeEarlyReject(
  index: SnapshotIndex,
  settings: EarlyRejectSettings,
  win: EarlyRejectWindow,
  now: Millis,
  o: EarlyRejectOptions,
): EarlyRejectReport {
  const max = bandMax(settings);
  const definition =
    `${settings.policy}: every submitted reviewer merit <= ${max}` +
    ` (${settings.policy === "reject_only" ? "PCS_MERIT_REJECT_MAX" : "PCS_MERIT_WEAK_REJECT_MAX"}),` +
    ` with at least ${settings.minReviews} submitted (PCS_EARLYREJECT_MIN_REVIEWS); bumped = any merit raised during the window`;
  const base = {
    now,
    open: win.open,
    close: win.close,
    closeSource: win.closeSource,
    policy: settings.policy,
    bandMax: max,
    minReviews: settings.minReviews,
    definition,
    syncAtOpen: o.syncAtOpen ?? null,
  };
  if (win.open === null || win.close === null) {
    return {
      ...base,
      status: "unconfigured",
      candidatesAt: null,
      outcomeAt: null,
      candidates: [],
      bumped: [],
      notBumped: [],
      noResponse: [],
      mail: null,
      notes: ["PCS_PHASE_EARLYREJECT_OPEN is not set, so there is no early-reject window."],
    };
  }

  const status: WindowStatus = now < win.open ? "before" : now <= win.close ? "open" : "closed";
  const t0 = status === "before" ? now : win.open;
  const e: Millis | null = status === "before" ? null : Math.min(now, win.close);
  const person = (email: string): ErPerson => {
    const p = index.people.get(email);
    return { email, name: p?.name ?? email, tier: p?.tier ?? DEFAULT_TIER };
  };

  const candidates: Candidate[] = [];
  const noResponse: NoResponseRow[] = [];
  for (const b of index.bundles) {
    const p = b.paper;
    const decidedBy = (t: Millis) => p.decision !== null && (p.decisionSeenAt === null || p.decisionSeenAt <= t);
    if (decidedBy(t0)) continue;
    const acs = new Set(b.acs);
    const reviewerReviews = b.reviews.filter((r) => r.rtype !== 5 && !acs.has(r.email));
    const atOpen = reviewerReviews.map((r) => ({ r, merit: meritAt(r, t0), v: versionAt(r, t0) }));
    const merits = atOpen.filter((x) => x.merit !== null);
    if (merits.length < settings.minReviews || merits.some((x) => x.merit! > max)) continue;

    const published = b.comments.filter((c) => !c.draft && !c.isResponse);
    const upTo = e ?? now;
    const visible = published.filter((c) => c.time <= upTo);
    const inWindow = e === null ? [] : visible.filter((c) => c.time >= t0);
    const reviews: CandidateReview[] = merits.map(({ r, merit, v }) => {
      const meritNow = e === null ? null : meritAt(r, e);
      const changed =
        e !== null &&
        r.versions.some((ver, i) => {
          if (i === 0 || ver.seenAt <= t0 || ver.seenAt > e) return false;
          const prev = r.versions[i - 1]!.merit;
          return prev !== null && ver.merit !== null && prev !== ver.merit;
        });
      const windowComments = inWindow.filter((c) => c.email === r.email).length;
      return {
        rid: r.rid,
        person: person(r.email),
        meritAtOpen: merit!,
        expertiseAtOpen: v?.expertise ?? null,
        meritNow,
        raised: meritNow !== null && meritNow > merit!,
        changed,
        windowComments,
        noResponse: e !== null && !changed && windowComments === 0,
      };
    });
    const meritsNow = e === null ? null : reviewerReviews.map((r) => meritAt(r, e)).filter((m): m is number => m !== null);
    const bumped = reviews.some((r) => r.raised);
    const newReviewsInWindow =
      e === null ? 0 : reviewerReviews.filter((r) => meritAt(r, t0) === null && meritAt(r, e) !== null).length;
    const signals = {
      comments: visible.length,
      windowComments: inWindow.length,
      acComments: visible.filter((c) => acs.has(c.email)).length,
      lastCommentAt: visible.length > 0 ? visible[visible.length - 1]!.time : null,
      outstandingReviews: atOpen.filter((x) => x.merit === null).length,
      newReviewsInWindow,
    };
    const meritsTxt = merits.map((x) => x.merit).join("/");
    const at0 = status === "before" ? `as of now (${o.fmt(t0)}; provisional, the window opens ${o.fmt(win.open)})` : `as of window open (${o.fmt(t0)})`;
    let reason = `merits ${meritsTxt} ${at0}: all <= ${max}, ${merits.length} submitted (>= ${settings.minReviews})`;
    if (e !== null) {
      const raised = reviews.filter((r) => r.raised);
      reason +=
        `; ${e === win.close ? "by close" : "so far"}: ` +
        (bumped ? `${raised.length} raised (${raised.map((r) => `${r.meritAtOpen}->${r.meritNow}`).join(", ")})` : "no merit raised") +
        `, ${signals.windowComments} comments in the window, ${reviews.filter((r) => r.noResponse).length} of ${reviews.length} reviewers with no response`;
    }
    candidates.push({
      pid: p.pid,
      title: p.title,
      acs: [...b.acs],
      meritsAtOpen: merits.map((x) => x.merit!),
      meritsNow,
      reviews,
      signals,
      bumped,
      stillInBand: meritsNow === null ? null : meritsNow.every((m) => m <= max),
      decision: e !== null && decidedBy(e) ? p.decision : null,
      reason,
    });
    for (const r of reviews) {
      if (!r.noResponse) continue;
      noResponse.push({
        pid: p.pid,
        rid: r.rid,
        person: r.person,
        reason: `merit ${r.meritAtOpen} unchanged and no comment on #${p.pid} between ${o.fmt(t0)} and ${o.fmt(e!)}`,
      });
    }
  }

  const pids = candidates.map((c) => c.pid);
  const notes: string[] = [];
  if (status !== "before" && (o.syncAtOpen ?? null) === null) {
    notes.push(
      "No successful sync ran at or before the window opened. Reviews whose earlier versions were never observed (no sync and no pcs backfill before OPEN) are judged by their first observed version.",
    );
  }
  if (status === "before") notes.push("The window has not opened: candidates are provisional, computed as of now.");
  return {
    ...base,
    status,
    candidatesAt: t0,
    outcomeAt: e,
    candidates,
    bumped: e === null ? [] : candidates.filter((c) => c.bumped).map((c) => c.pid),
    notBumped: e === null ? [] : candidates.filter((c) => !c.bumped).map((c) => c.pid),
    noResponse: noResponse.sort((a, b) => a.pid - b.pid || a.person.email.localeCompare(b.person.email)),
    mail: pids.length > 0 ? mailDraft(pids, settings, win.close, o) : null,
    notes,
  };
}

/** The drafted HotCRP Mail-tool search and text (the chair sends it; the app never sends mail). */
export function mailDraft(pids: readonly number[], s: EarlyRejectSettings, close: Millis, o: Pick<EarlyRejectOptions, "fmt">): MailDraft {
  const search = pids.join(" ");
  const q = encodeURIComponent(search);
  return {
    search,
    searchPath: `/search?q=${q}&t=s`,
    mailPath: `/mail?to=crev&t=s&q=${q}`,
    hours: s.windowHours,
    subject: `[{{CONFSHORTNAME}}] Early reject: please re-read #{{NUMBER}} within ${s.windowHours} hours`,
    body: [
      "Dear {{NAME}},",
      "",
      `Every submitted review of paper #{{NUMBER}} "{{TITLE}}" currently scores it in the reject band, so it is a candidate for early rejection.`,
      "",
      `Please re-read the paper and the other reviews within ${s.windowHours} hours (by ${o.fmt(close)}). If you think it deserves discussion, raise your overall merit or leave a comment for the PC. If you agree with early rejection, please say so in a short comment.`,
      "",
      "Thank you,",
      "The program chairs",
    ].join("\n"),
  };
}
