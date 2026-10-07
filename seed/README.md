# seed: scenarios and the harness seeder (PLAN M2)

Seeds the disposable HotCRP harness (`scripts/hotcrp-up.sh`) with synthetic
scenarios. **Harness only**: it refuses unless `PCS_HOTCRP_URL` is
`127.0.0.1`/`localhost` *and* the compose project (`HOTCRP_COMPOSE_PROJECT`,
written to `.env.test`) publishes that same port.

```bash
scripts/hotcrp-up.sh
set -a; . ./.env.test; set +a
# Phase dates: the seeder places every event relative to them (the ci.yml values):
export PCS_TZ=America/New_York PCS_PHASE_REVIEW_DUE=2030-02-01T23:59 \
  PCS_PHASE_RESPONSE_OPEN=2030-02-08T00:00 PCS_PHASE_RESPONSE_CLOSE=2030-02-11T23:59 \
  PCS_PHASE_DISCUSSION_OPEN=2030-02-12T00:00 PCS_PHASE_DISCUSSION_CLOSE=2030-03-01T23:59 \
  PCS_PHASE_DECISIONS_DUE=2030-03-03T23:59

npm run seed -- golden            # fresh harness only
npm run seed -- golden --reset    # empty the harness first
npm run seed -- verify golden     # check the API shows exactly the scenario
npm run seed -- multistage --reset --stage 1   # ... sync ...
npm run seed -- multistage --stage 2           # ... sync with PCS_NOW advanced
npm run seed -- reset | status | list
```

`seed list` prints each stage's intended `PCS_NOW`. Library use (tests):
`import { seedScenario, resetHarness } from "@pcs/seed/driver"`,
`import { verifyScenario } from "@pcs/seed/verify"`, scenarios from
`@pcs/seed/scenarios/<name>/scenario`.

## Fresh harness, reset, idempotence

The seeder expects an empty harness. It records `scenario` and `stage` in a
`Settings` row named `__pcs_seed`, and:

- refuses stage 1 if the harness has any paper or marker (use `--reset`, or
  `--force` to seed on top at your own risk);
- refuses stage N > 1 unless stage N-1 of the *same* scenario was seeded last.

`seed reset` (or `--reset`) truncates every content table (papers, reviews,
history, comments, conflicts, tags, logs, documents) and deletes every account
except sysadmins. The chair account and its token in `.env.test` survive, so a
reset takes about a second instead of a harness rebuild. Integration tests that
seed must reset first; they run serially.

A reset also re-inserts `PaperStorage` row 1, HotCRP's "empty document"
placeholder. Without it, the first PDF stored after the truncate gets id 1 and
that paper silently stays a draft ("Submission: Entry required"). This was fixed in M10.
Settings survive a reset, so review rounds and submission options defined by an
earlier scenario stay defined (with no values).

## Scenario format (`src/format.ts`)

A scenario is typed TS data:

- `people`: `{ email (@example.org), first, last, affiliation, roles: ["pc"], tags }`;
- `papers`: `{ pid, title, authors: [{ email, first, last }] }` (authors become HotCRP placeholder contacts);
- `assignments`: `{ pid, email, role: metareview | primary | secondary | pcreview, requestedAt? }`
  (`metareview` = the paper's AC; requests default to review deadline −28 d);
- `stages`: `[{ name, now?, events }]`.

Phase-2 additions (PLAN Phase 2 intro, M10; all optional, additive):

- **Authors with affiliations.** `Author.affiliation` goes to savepapers, and
  `Person.affiliation` to saveusers (so `/pc` has it). A PC member may now also
  be a paper author, as reciprocal reviewers are. HotCRP then records an
  `author` conflict, and `replay` rejects assigning an author to their own paper.
- **Submission options.** `Scenario.submissionFields: SubmissionField[]`
  (`{ name, type: "text" | "dropdown", values?, visibility? }`, default
  visibility `admin`) is saved through `batch/settings.php` as `sf` entries
  matched by **name**, so re-seeding is idempotent. Re-saving dropdown choices adds missing
  ones and keeps the rest. `Paper.options: { [fieldName]: value }` goes into the
  savepapers JSON under the option's name, and `GET /papers` returns it under
  the same name. Ready-made: `RESERVE_DESIGNEE_FIELD` ("Reserve designee", text:
  the designee's email) and `RESERVE_EXEMPTION_FIELD` ("Reserve exemption",
  dropdown `no-eligible-author | all-authors-on-pc | other`).
- **Review rounds.** `Scenario.reviewRounds` names extra rounds, saved as
  settings `review` entries by name. `QUICKREJECT_ROUND = "quickreject"`.
  `Assignment.round` puts an assignment in one; batch/assign.php gets a `round`
  column. `/reviews` and `get/pcassignments` report the round name.
- **Tiers.** `TIER_TAGS` = `junior`, `reserveactive`, `reservepool` as user
  tags; untagged PC members are senior. Use `PCS_TIER_TAGS=TIER_TAGS_ENV`
  (`junior=junior,reserve-active=reserveactive,reserve-pool=reservepool`). A
  non-PC `Person` with `roles: []` is saved as a user only if it has tags (a
  reserve-pool designee). Its tag can't be read back through the API (§1),
  and `verify` skips it.

- **Paper tags** (M11). `Paper.tags` (no leading `#`) are set in stage 1 through
  `batch/assign.php` `paper,tag,<tag>` lines, as a chair would set them.

`verify` also checks authors (email and affiliation, in order), option values,
named rounds, and paper tags (when a scenario has any).

Every time is a `When` = `{ phase, day, time? }`: the phase date's local
calendar date (in `PCS_TZ`) plus `day` days, at local `time` "HH:MM" (default:
the phase's own time). Phases: `reviewDue`, `responseOpen`, `responseClose`,
`discussionOpen`, `discussionClose`, `decisionsDue`. No scenario hard-codes a date.

Events:

| type | effect in HotCRP |
|---|---|
| `review` | `POST /reviews` (submitted) with scores and `words` words of filler split over `PapSum`/`ComAut` |
| `scoreChange` | `POST /reviews` with new scores; HotCRP keeps the old version in `PaperReviewHistory` |
| `comment` | `POST /comments?actas=<email>`; `mentions` are written as `@First Last` at the start |
| `commentEdit` | same endpoint with the `cid`; keeps the mentions, new filler |
| `commentDelete` | same endpoint, `delete: true` (the row is gone from `/comments`) |
| `response` | `POST /comments?actas=<author>` with `response: "1"` (response round 1) |
| `decision` | `batch/assign.php` CSV `paper,action,decision` |
| `unassign` | `batch/assign.php` CSV `paper,clearreview,user` (unsubmitted reviews only) |
| `assign` | `batch/assign.php` CSV `paper,action,user` mid-scenario (M12), e.g. a replacement reviewer; `timeRequested` is warped to the event time. Checked like a stage-1 assignment (PC member, not an author, not already assigned) |

Review and comment text is invented filler (`src/text.ts`) with exact word
counts as HotCRP counts them; it is deterministic, so `verify` recomputes it.
Generated scenarios use a fixed-seed RNG (`src/rng.ts`).

## How the driver works (`src/driver.ts`)

1. **Structure (stage 1)**: `batch/settings.php` (open review deadlines in
   2099, since `POST /reviews` ignores `override` for JSON; comments always
   allowed; one response round open 2020-2099 on HotCRP's wall clock),
   `batch/saveusers.php`, `batch/savepapers.php` (PDF `content_file` relative
   to the JSON file), `batch/assign.php`. Then SQL backdates `timeRequested`
   and paper submission times.
2. **Activity**: through the API with a dedicated `seeder@example.org`
   sysadmin token (minted per run, not on the PC) whose per-user rate limits
   are raised in `ContactCounter`. The chair token's 250/min and 5000/h budget
   is untouched, so a timed sync right after seeding isn't throttled. The
   harness's default limits are unchanged.
3. **Time-warp**: events run in *waves* (wave k = every object's k-th event,
   in time order). After each wave one SQL transaction sets each touched
   object's times to the intended instant:
   - review submitted: `reviewSubmitted = reviewModified = timeDisplayed = t`
     (`timeRequested` stays earlier, or HotCRP hides `modified_at`);
   - score change: `reviewModified = t`. Because the earlier version was
     already backdated, the history row HotCRP writes carries the earlier
     version with its earlier time;
   - comment / response: `timeModified = timeNotified = timeDisplayed = t`;
     edit: `timeModified = t` only.
   Decisions and unassignments have no API-visible timestamp; they happen
   at seed time. `ActionLog` timestamps are not warped.

## Scenarios

### `golden` (`scenarios/golden/`)

The PLAN.md table. `expected.ts` is the rules oracle (fired rules per pid at
both instants, merits, score changes, people facts). People, emails and
schedule match M4's fixture `server/test/fixtures/golden.ts`.

- Reviews submitted 2030-01-(20 + (pid + slot) % 10) at 10:00; slot 0 is
  `primary` (rtype 4), slots 1-2 `secondary` (rtype 3); 250 words unless noted.
- Reviewer comments at 12:00 on discussion days +3/+8/+13 by slot; AC
  comments at 09:00. ACs hold empty metareviews, except pid 1 (complete, no
  scores, day +10 09:00).

| pid | AC | slot 0 | slot 1 | slot 2 | other |
|---|---|---|---|---|---|
| 1 | ac-busy | ana 3/3 (+3) | ben 3/4 (+8) | cal 4/3 (+9) | AC +1; metareview + decision Accepted day +10 |
| 2 | ac-normal | recip *empty* | ana 3/4 (+8) | dee 4/3 (+13) | AC +1 |
| 3 | ac-busy | silent 1→2 day +6 12:00 (never) | ben 4/4 (+8) | eli 4/3 (+13) | AC +1 |
| 4 | ac-busy | silent 2/3 (never) | pinged 4/4 (never) | cal 4/3 (+13) | AC +1, +3 `@Pat Pingleton` |
| 5 | ac-idle | dee 2/3 | fay 2/4 | gus 2/3 | no comments at all |
| 6 | ac-normal | eli 4/3 (+2) | fay 4/4 (+2) | hal 4/3 (+2) | AC +1 |
| 7 | ac-idle | ana 3/3 (+3) | gus 3/4 (+8) | hal 4/3 (+13) | no AC comment |
| 8 | ac-busy | champ 5/3 (never) | ben 4/4 (+8) | dee 4/3 (+13) | AC +1 |
| 9 | ac-busy | cal 3/2 (+3) | eli 3/2 (+8) | fay 4/1 (+13) | AC +1 |
| 10 | ac-busy | gus 3/3 (+3) | hal 3/4, **35 words** (+8) | ana 4/3 (+13) | AC +1 |
| 11 | ac-normal | ben 2/3 | cal 2/4 | dee 2/3 | reviewers never; AC +1, +12; response by author11 2030-02-09 12:00 |
| 12 | ac-normal | silent 1→2 day +5 12:00 (never) | eli 4/4 (+8) | hal 4/3 (+13) | AC +1 |

Scores are merit/expertise (`OveMer`/`RevExp`). Names: `r-<name>@example.org`
(`r-silent` is tagged `junior`, `r-recip` `reciprocal`), ACs
`ac-busy|ac-idle|ac-normal@example.org`.

### `multistage` (`scenarios/multistage/`), for M3's diff test

PC: `ms-ac` (AC on all), `ms-ana` (tag `junior`), `ms-bo`, `ms-cy`, `ms-dee`
(tag `reciprocal`), all `@example.org`. Papers 1-3. Reviews are 240 words.

**Stage 1** (observe at `PCS_NOW=2030-02-15T12:00`, discussion day +3):

- pid 1: AC ms-ac; ms-ana 2/3 (01-27), ms-bo 4/3 (01-28), ms-cy 4/4 (01-29); all 10:00.
- pid 2: AC ms-ac; ms-ana 3/3 (01-27), ms-bo 3/4 (01-28), ms-cy 4/3 (01-30);
  **ms-dee assigned (pcreview), never submits**.
- pid 3: AC ms-ac; ms-bo 4/3 (01-26), ms-cy 3/3 (01-29), ms-dee 3/4 (01-31).
- comments: `ms-c1` ms-ac on 1, day +1 09:00, `@Ana Twostep`; `ms-c2` ms-ana
  on 1, day +2 10:00; `ms-c3` ms-ac on 2, day +1 11:00; `ms-c4` ms-bo on 2,
  day +2 15:00; `ms-c5` ms-cy on 3, day +2 16:00. 13 review rows, 5 comments.

**Stage 2** (observe at `PCS_NOW=2030-02-19T12:00`, discussion day +7):

- **score change**: ms-ana on pid 1, merit 2 → 3, day +4 10:00 (02-16):
  same rid, new `version`, `modified_at` 02-16 10:00; `/reviewhistory`
  holds the old version (merit 2).
- **new comment** `ms-c6`: ms-bo on pid 1, day +4 14:00, `@Ana Twostep`.
- **edited comment** `ms-c2`: same cid, new text (55 filler words, so no
  mention), `modified_at` day +5 09:00 (02-17).
- **deleted comment** `ms-c5` (ms-cy, pid 3), day +5 10:00: gone from `/comments`.
- **unassigned review**: ms-dee's empty review on pid 2, day +5 11:00: gone
  from `/reviews` and `get/pcassignments`.
- **new comment** `ms-c7`: ms-ac on pid 3, day +6 10:00.

After stage 2: 12 review rows, 6 comments (c1, c2 edited, c3, c4, c6, c7).

### `shadow` and `scale` (`src/generate.ts`)

Generated with a fixed seed. Per paper: one AC metareview, 2 senior reviews,
1 junior-or-reciprocal (`pcreview`). Latent paper quality with scattered merits;
~5-10% of reviews late (up to 6 days), some never arrive; ~6% thin; 40% of
split papers see one extreme reviewer move inward during discussion;
reviewers and ACs have varied comment rates and occasionally `@mention`;
~45% of papers get a response; ~20% of unsplit papers get early decisions.
Observe at `PCS_NOW=2030-02-26T12:00`.

- `shadow`: 150 papers, 10 ACs, 45 senior + 15 junior + 10 reciprocal.
- `scale`: 2,400 papers, 40 ACs, 400 senior + 120 junior + 120 reciprocal;
  9,600 review rows, 6,594 comments, 1,068 responses. Seeds in about 2 min on a
  9-core dev machine (35 s of it is savepapers.php); `verify scale` takes about 70 s.

### `assignment` (`scenarios/assignment/`), for M10's validator

An assignment-phase state with 8 papers, 2 ACs, 8 seniors, 3 juniors, and 3
reserve-active reviewers. Observe at `reviewDue −21 d` (`PCS_NOW=2030-01-11T12:00`).
It needs `ASSIGNMENT_ENV` (tiers, plus load bands sized for 8 papers: senior 1–3,
junior 1–3, reserve-active 1–1). `fixtures/` holds `invites.csv`,
`do-not-invite.csv`, and `tpms-assignments.csv` for `pcs import`. Planted in
the HotCRP assignment:

- #5 is an all-junior panel (3 juniors);
- `sofia.lund` (senior) reviews 4 papers;
- `sofia.lund` shares an affiliation with the author of #4;
- reserve `nora.quist` on #3 is `pending` in the invites fixture;
- reserve `greta.holm` on #6 is approved, but on the do-not-invite fixture;
- a reciprocal 2-cycle: `omar.reyes` authors #1, which `lena.brandt` reviews,
  and she authors #2, which he reviews;
- a 3-cycle: `kwame.osei` (#6) → `ingrid.falk` (#7) → `tariq.nasser` (#8) → back.

The TPMS fixture adds an unknown paper (#99), a non-PC email, an author
assigned to their own paper, and an extra third slot. `expected.ts` lists
every expected finding for both modes and the exact TPMS fix-up CSV.
`seed/test/unit/assignment.test.ts` checks it without a harness, and
`seed/test/integration/assignment.test.ts` checks it through seed, sync,
import, validate, and the `POST /assign?dry_run=1` dry run. #1–#4 and #6–#8
name their first author as reserve designee; #5 claims the exemption
`no-eligible-author`. #1's metareview is in the `quickreject` round.
`amara.diallo` (non-PC author of #3) is tagged `reservepool`.

### `registration` (`scenarios/registration/`), for M11's reserve and quick-reject modules

There are 21 papers, 2 ACs (metareviewers on every paper), 2 quick-reject reviewers, and 2 more PC members. Observe at `reviewDue −33 d 12:00` (`PCS_NOW=2029-12-30T12:00` under the ci.yml dates). It needs `registrationEnv(ctx)`, which sets `PCS_PHASE_QUICKREJECT_DUE` to `reviewDue −35 d 23:59` and `PCS_PHASE_ASSIGNMENT_DONE` to `reviewDue −21 d 23:59`. Both are derived from the phase dates, never hard-coded, and put now in the assignment phase. The submission fields are the designee option, the exemption dropdown with an extra non-allowed choice `on-sabbatical`, and a `Reserve seniority` text option. `fixtures/` holds `tpms-registrations.csv` and `refcheck.csv`.

Reserve compliance (#1–#12):
- #1 is the clean control.
- #2 has neither a designee nor an exemption.
- Kim Park is designated as `kim.park@` on #3 and as `K.Park@Example.ORG` on #4. That is inconsistent, and only `kim.park@` is TPMS-registered.
- #5 claims `on-sabbatical`.
- #6 claims `all-authors-on-pc`, but one author isn't on the PC.
- `victor.okafor` is the designee of #7–#10, more than `PCS_RESERVE_MAX_COVER=3`.
- #11 has a valid `no-eligible-author` claim. The mocked DBLP table (`DBLP_MOCK`) makes one of its authors "possibly senior", which is a hint, not a finding.
- #12 names its designee by name.

Quick-reject queue (#13–#21, tags from the `PCS_QR_TAGS` defaults):
- #13 has a refcheck hit and an overdue quick-reject review.
- #14 is flagged, has a reject verdict, and is awaiting the chair.
- #15 has a refcheck hit and was desk-rejected (decision Rejected).
- #16 has an appeal requested.
- #17 has an overturned appeal.
- #18 was flagged and the AC kept it.
- #19 was desk-rejected, but the decision was never entered (`DECISION_MISSING`).
- #20 is the clean control: a keep verdict and a clean refcheck row.
- #21 has an upheld appeal.

`expected.ts` lists every finding and queue item. `seed/test/unit/registration.test.ts` checks it without a harness. `seed/test/integration/registration.test.ts` checks it through seed, verify, sync, import, both modules (DBLP mocked), and `GET /search` for each drafted Mail-tool search.
### `earlyreject` (`scenarios/earlyreject/`), for M12's tier progress and early reject

Two stages around the early-reject window. `earlyRejectEnv(ctx)` gives the
module env on top of the ci.yml dates: `PCS_TIER_TAGS=TIER_TAGS_ENV`, the
window review due +2 d 09:00 .. +4 d 09:00 (`2030-02-03T09:00` ..
`2030-02-05T09:00`), `PCS_POLICY_EARLYREJECT=include_weak_reject`, and
`PCS_POLICY_WITHHOLD_REVIEWS=true`. Eight papers, ACs `wren.halloway` (#1-#4)
and `tobias.ferrante` (#5-#8), six seniors, two juniors (`kit.ramsden`,
`noor.elzein`), and three reserve-active reviewers who also author papers:
`hedda.vang` (#3), `bruno.salcedo` (#1), and `yuki.tamsin` (#2, #8). Reviews
are 250 words unless noted.

**Stage 1** (observe at window open, `PCS_NOW=2030-02-03T09:00`):

| pid | reviews (merit) | notes |
|---|---|---|
| 1 | okafor 1, brandvold 1, ramsden 2 (120 words) | candidate (weak); brandvold comments at due +1 d |
| 2 | castellanos 1, iverholt 1, vang 1 | candidate (both policies); AC comment at due +1 d |
| 3 | quillfeather 2, ambroise 2, elzein 2 | candidate (weak) |
| 4 | okafor 1, castellanos 4, salcedo 2 (80 words) | not a candidate |
| 5 | brandvold 2, iverholt 2; tamsin **late** | 2 reviews only; the AC @mentions tamsin at due +1 d |
| 6 | ambroise 3, brandvold 4; salcedo **late** | |
| 7 | iverholt 3, okafor 3; vang **late** | |
| 8 | castellanos 4, quillfeather 3, elzein 3 (60 words); ramsden (4th) **late** | |

**Stage 2** (during the window; observe at close, `PCS_NOW=2030-02-05T09:00`):
okafor raises #1 1→3; castellanos comments on #2; quillfeather is **assigned**
to #6 (replacing salcedo); ramsden comments on #1; quillfeather lowers #3 2→1;
elzein comments on #3; vang submits #7 (merit 3); castellanos comments on #4.

`expected.ts` holds the outputs at both instants: candidates per policy;
bumped `[1]`, not bumped `[2, 3]`, no response `brandvold@1 iverholt@2
vang@2 ambroise@3`; late by tier; dropout states (open: tamsin@5 pinged,
salcedo@6 and vang@7 late; close: tamsin@5 replacement-needed, salcedo@6
replaced); accountability, coaching queue, withheld papers, and participation.
`seed/test/integration/earlyreject.test.ts` checks them through seed, sync,
and the modules.

## Import fixtures (`fixtures/imports/`, PLAN M9)

These are synthetic CSVs for `pcs import` (spec §10.3). They are plain files, not harness seeding, and are used by `server/test/unit/imports.test.ts` and `cli-import.test.ts`. All names are invented, at `example.org`.

- `<kind>.csv` for each of `invites`, `tpms-assignments`, `tpms-registrations`, `refcheck`, and `do-not-invite`. These are valid files that exercise the tolerant header matching: shuffled column order, Title Case headers, aliases (`Paper ID`, `Reviewer Email`, `Affinity`), an extra column, uppercase emails, quoted commas, and date-only and date-time values.
- `invites.v2.csv` is a later version of the sheet. Against `invites.csv` it has 1 row added, 1 removed, and 1 changed (pid 2 goes from pending to approved and invited), for the versioning and diff tests.
- `<kind>.malformed.csv`, plus `invites.bad-quote.csv`, are deliberately broken files. Each must import nothing and give the row-level report asserted in the tests.
- TPMS file exchange (`server/test/unit/tpms.test.ts`): `tpms-scores.csv` (a small `paper,email,score` matrix) and `affinity-local.csv` (header-less, like openreview-expertise output); `tpms-assignments.mapped.csv`, an "unpublished" layout that needs `--map paper=Submission #,email=Assigned Reviewer,score=Match Quality,round=Phase`, and its `.mapped.malformed.csv`; `tpms-registrations.full.csv` (`email,registered,n_papers,last_updated`), `.list.csv` (a plain list of emails, no header), `.email-only.csv` (one email column), and `.list.malformed.csv`. The malformed score files cover out-of-range, non-numeric, and blank scores, bad pids and emails, duplicate keys, and long rows.

## Reading user tags back (for M3)

`/pc` has no per-user tags, and pages (`/users?…getfn=pcinfo`) don't accept
bearer tokens. The API way is the **review search filter**:

    GET /api/reviews?q=<pids>&rq=re:%23junior

`rq` filters *reviews* by a review search term (`Review_API::run_get_multi`);
`re:#<tag>` matches reviews whose reviewer has user tag `<tag>`. The
`reviewer_email`s returned are exactly the tagged reviewers (with at least one
review on the searched papers). One call per tier tag; untagged = senior.
