// The PLAN.md golden scenario as an in-memory SnapshotView (no harness).
// M2 builds the same scenario in HotCRP independently; this file is M4's
// reading of the table. All names are invented, all emails @example.org.
//
// Time: phase dates from ci.yml (America/New_York). "Day +d" is
// DISCUSSION_OPEN (2030-02-12T00:00) + d days, at 12:00 local unless noted.
// Reviews are submitted 2030-01-20..29 at 10:00, before REVIEW_DUE.
//
// People (tier):
//   ac-busy@example.org     AC of 1, 3, 4, 8, 9, 10 (comments on all, day +1)
//   ac-idle@example.org     AC of 5, 7 (never comments)
//   ac-normal@example.org   AC of 2, 6, 11, 12
//   r-silent@example.org    junior; low scorer on 3, 4, 12; never comments
//   r-pinged@example.org    senior; a 4 on pid 4; @mentioned by AC day +3; never replies
//   r-recip@example.org     reciprocal; pid 2 laggard (review still empty)
//   r-champ@example.org     senior; the 5 on pid 8; never comments
//   r-ana, r-ben, r-cal, r-dee, r-eli, r-fay, r-gus, r-hal @example.org: senior
//   author11@example.org    contact author of pid 11 (posts the response)
//
// Per paper: [reviewer merit (comment days)], AC comment days. Slots comment
// on days +3, +8, +13 by default; "-" = never.
//   1  ana 3 (3), ben 3 (8), cal 4 (9); AC +1; decision "Accept" day +10
//   2  recip empty (-), ana 3 (8), dee 4 (13); AC +1
//   3  silent 1->2 day +6 (-), ben 4 (8), eli 4 (13); AC +1
//   4  silent 2 (-), pinged 4 (-), cal 4 (13); AC +1, +3 (@r-pinged)
//   5  dee 2, fay 2, gus 2 (all -); no AC comment
//   6  eli 4, fay 4, hal 4 (all day +2); AC +1
//   7  ana 3 (3), gus 3 (8), hal 4 (13); no AC comment
//   8  champ 5 (-), ben 4 (8), dee 4 (13); AC +1
//   9  cal 3/exp 2 (3), eli 3/exp 2 (8), fay 4/exp 1 (13); AC +1
//  10  gus 3 (3), hal 3 with 35 words (8), ana 4 (13); AC +1
//  11  ben 2, cal 2, dee 2 (all -); AC +1, +12; response 2030-02-09T12:00
//  12  silent 1->2 day +5 (-), eli 4 (8), hal 4 (13); AC +1
// Default expertise is 3/4/3; default length 250 words.

import type { AcView, CommentView, PersonView, ReviewView, SnapshotView } from "../../src/rules/model.js";
import { at, comment, day, paper, review } from "./builder.js";

export const GOLDEN_NOW = "2030-02-26T12:00";
export const GOLDEN_NOW_LATE = "2030-03-01T12:00";

export const E = {
  acBusy: "ac-busy@example.org",
  acIdle: "ac-idle@example.org",
  acNormal: "ac-normal@example.org",
  silent: "r-silent@example.org",
  pinged: "r-pinged@example.org",
  recip: "r-recip@example.org",
  champ: "r-champ@example.org",
  ana: "r-ana@example.org",
  ben: "r-ben@example.org",
  cal: "r-cal@example.org",
  dee: "r-dee@example.org",
  eli: "r-eli@example.org",
  fay: "r-fay@example.org",
  gus: "r-gus@example.org",
  hal: "r-hal@example.org",
  author11: "author11@example.org",
} as const;

/** Expected rules per pid at GOLDEN_NOW (PLAN.md table, exactly). */
export const GOLDEN_EXPECTED: Readonly<Record<number, readonly string[]>> = {
  1: [],
  2: ["MISSING_REVIEWS"],
  3: ["SPLIT"],
  4: ["SPLIT", "UNRESOLVED_SPLIT"],
  5: ["SILENT_DISCUSSION", "GONE_QUIET", "AC_ABSENT"],
  6: ["GONE_QUIET"],
  7: ["AC_ABSENT"],
  8: ["CHAMPION_MISSING"],
  9: ["LOW_EXPERTISE"],
  10: ["THIN_REVIEWS"],
  11: ["RESPONSE_UNADDRESSED"],
  12: ["SPLIT"],
};

const NAMES: Record<string, [string, string]> = {
  [E.acBusy]: ["Avery Busyfield", "senior"],
  [E.acIdle]: ["Indra Idleworth", "senior"],
  [E.acNormal]: ["Noor Normandy", "senior"],
  [E.silent]: ["Sam Silvermoon", "junior"],
  [E.pinged]: ["Pat Pingleton", "senior"],
  [E.recip]: ["Remy Reciprocca", "reciprocal"],
  [E.champ]: ["Charlie Champlain", "senior"],
  [E.ana]: ["Ana Arbortown", "senior"],
  [E.ben]: ["Ben Brookvale", "senior"],
  [E.cal]: ["Cal Cedarholm", "senior"],
  [E.dee]: ["Dee Dunmore", "senior"],
  [E.eli]: ["Eli Elmsworth", "senior"],
  [E.fay]: ["Fay Fernhill", "senior"],
  [E.gus]: ["Gus Glenrock", "senior"],
  [E.hal]: ["Hal Hollowmere", "senior"],
};

interface Slot {
  email: string;
  merit?: number;
  expertise?: number;
  words?: number;
  empty?: boolean;
  move?: { day: number; to: number };
  /** Comment days; default by slot index (+3, +8, +13). [] = never. */
  comments?: number[];
}

interface PaperSpec {
  pid: number;
  ac: string;
  slots: [Slot, Slot, Slot];
  acComments: { day: number; mentions?: string[] }[];
  decisionDay?: number;
  responseAt?: string;
}

const DEFAULT_COMMENT_DAYS = [3, 8, 13];
const DEFAULT_EXPERTISE = [3, 4, 3];

const SPECS: PaperSpec[] = [
  {
    pid: 1,
    ac: E.acBusy,
    slots: [{ email: E.ana }, { email: E.ben }, { email: E.cal, merit: 4, comments: [9] }],
    acComments: [{ day: 1 }],
    decisionDay: 10,
  },
  {
    pid: 2,
    ac: E.acNormal,
    slots: [{ email: E.recip, empty: true, comments: [] }, { email: E.ana }, { email: E.dee, merit: 4 }],
    acComments: [{ day: 1 }],
  },
  {
    pid: 3,
    ac: E.acBusy,
    slots: [
      { email: E.silent, merit: 1, move: { day: 6, to: 2 }, comments: [] },
      { email: E.ben, merit: 4 },
      { email: E.eli, merit: 4 },
    ],
    acComments: [{ day: 1 }],
  },
  {
    pid: 4,
    ac: E.acBusy,
    slots: [
      { email: E.silent, merit: 2, comments: [] },
      { email: E.pinged, merit: 4, comments: [] },
      { email: E.cal, merit: 4 },
    ],
    acComments: [{ day: 1 }, { day: 3, mentions: [E.pinged] }],
  },
  {
    pid: 5,
    ac: E.acIdle,
    slots: [
      { email: E.dee, merit: 2, comments: [] },
      { email: E.fay, merit: 2, comments: [] },
      { email: E.gus, merit: 2, comments: [] },
    ],
    acComments: [],
  },
  {
    pid: 6,
    ac: E.acNormal,
    slots: [
      { email: E.eli, merit: 4, comments: [2] },
      { email: E.fay, merit: 4, comments: [2] },
      { email: E.hal, merit: 4, comments: [2] },
    ],
    acComments: [{ day: 1 }],
  },
  {
    pid: 7,
    ac: E.acIdle,
    slots: [{ email: E.ana }, { email: E.gus }, { email: E.hal, merit: 4 }],
    acComments: [],
  },
  {
    pid: 8,
    ac: E.acBusy,
    slots: [{ email: E.champ, merit: 5, comments: [] }, { email: E.ben, merit: 4 }, { email: E.dee, merit: 4 }],
    acComments: [{ day: 1 }],
  },
  {
    pid: 9,
    ac: E.acBusy,
    slots: [
      { email: E.cal, expertise: 2 },
      { email: E.eli, expertise: 2 },
      { email: E.fay, merit: 4, expertise: 1 },
    ],
    acComments: [{ day: 1 }],
  },
  {
    pid: 10,
    ac: E.acBusy,
    slots: [{ email: E.gus }, { email: E.hal, words: 35 }, { email: E.ana, merit: 4 }],
    acComments: [{ day: 1 }],
  },
  {
    pid: 11,
    ac: E.acNormal,
    slots: [
      { email: E.ben, merit: 2, comments: [] },
      { email: E.cal, merit: 2, comments: [] },
      { email: E.dee, merit: 2, comments: [] },
    ],
    acComments: [{ day: 1 }, { day: 12 }],
    responseAt: "2030-02-09T12:00",
  },
  {
    pid: 12,
    ac: E.acNormal,
    slots: [
      { email: E.silent, merit: 1, move: { day: 5, to: 2 }, comments: [] },
      { email: E.eli, merit: 4 },
      { email: E.hal, merit: 4 },
    ],
    acComments: [{ day: 1 }],
  },
];

/** Build a fresh copy of the golden snapshot. */
export function goldenSnapshot(): SnapshotView {
  const reviews: ReviewView[] = [];
  const comments: CommentView[] = [];
  const acs: AcView[] = [];
  let cid = 1;
  const papers = SPECS.map((s) =>
    paper(s.pid, s.decisionDay === undefined ? {} : { decision: "Accept", decisionSeenAt: day(s.decisionDay) }),
  );
  for (const s of SPECS) {
    acs.push({ pid: s.pid, email: s.ac });
    // The AC's metareview (rtype 5): complete on the decided paper, else empty.
    reviews.push(
      review({
        rid: 1000 + s.pid,
        pid: s.pid,
        email: s.ac,
        rtype: 5,
        status: s.decisionDay === undefined ? "empty" : "complete",
        merit: null,
        expertise: null,
        words: 120,
        ordinal: null,
        submittedAt: s.decisionDay === undefined ? undefined : day(s.decisionDay, 9),
      }),
    );
    s.slots.forEach((slot, i) => {
      const submittedAt = at(`2030-01-${String(20 + ((s.pid + i) % 10)).padStart(2, "0")}T10:00`);
      reviews.push(
        review({
          rid: s.pid * 10 + i,
          pid: s.pid,
          email: slot.email,
          rtype: i === 0 ? 4 : 3,
          status: slot.empty ? "empty" : "complete",
          merit: slot.merit ?? 3,
          expertise: slot.expertise ?? DEFAULT_EXPERTISE[i]!,
          words: slot.words ?? 250,
          ordinal: slot.empty ? null : String.fromCharCode(65 + i),
          submittedAt,
          moves: slot.move ? [{ at: day(slot.move.day), merit: slot.move.to }] : [],
        }),
      );
      for (const d of slot.comments ?? [DEFAULT_COMMENT_DAYS[i]!]) {
        comments.push(comment({ cid: cid++, pid: s.pid, email: slot.email, time: day(d) }));
      }
    });
    for (const c of s.acComments) {
      comments.push(comment({ cid: cid++, pid: s.pid, email: s.ac, time: day(c.day, 9), mentions: c.mentions ?? [] }));
    }
    if (s.responseAt) {
      comments.push(comment({ cid: cid++, pid: s.pid, email: E.author11, time: at(s.responseAt), isResponse: true, words: 400 }));
    }
  }
  const people: PersonView[] = Object.entries(NAMES).map(([email, [name, tier]]) => ({
    email,
    name,
    tier,
    roles: ["pc"],
  }));
  return { papers, people, acs, reviews, comments };
}
