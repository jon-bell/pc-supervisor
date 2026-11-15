# The review process: conceptual design (HUSL)

This file specifies, in the HUSL style, the review process of a large conference that uses a blended senior/junior PC, reciprocal reviewers nominated by each submission, solver-based assignment, screening before review, and early reject. It also specifies PC Supervisor's place in that process: what it reads from HotCRP, what it keeps that HotCRP can't, and how it changes HotCRP.

The specification has six parts:
- **concepts:** the state and actions, with the synchronizations between them;
- **rules:** what is computed;
- **policy:** who may see and do what;
- **properties:** what must hold;
- **examples:** confirmed cases, which double as oracles;
- **scenarios, assumptions, and accountability.**

The chairs sign the *views* of these parts: tables, one-sentence rules, and example cards. They never sign prompts or code.

The implementation designs are [spec.md](spec.md) (architecture, sync, modules, solver, HotCRP conventions) and [agent.md](agent.md) (the screening agent). Where they disagree with this file, this file wins and they get fixed.

Everything here is generic. A venue's choices among the open readings (§1) are **rulings** (concept 2), kept with the instance, not in the repo.

> **Status:** design, 2026-11-12. Nothing in this file has been executed. The next step (§6) is an executable model of the concepts and rules, against which the examples and properties are checked.

---

## 1. The case

A steering committee approves a review process in a few sentences:

> *Each submission nominates one qualified potential reviewer; area chairs decide whether each nominee is accepted and whether they serve as senior or junior PC, and accepted nominees augment the PC. Each paper is reviewed by at least two senior PC members and one or two junior PC members when appropriate. Assignment is automatic, from expertise, subject areas, and conflicts, with no bidding, and is checked by the chairs. Papers that clearly do not merit review are desk rejected, with evidence, by more than one person. Papers whose initial reviews are all negative are rejected without rebuttal.*

(This paraphrases the wording a venue sends to its area chairs. The readings below are what that wording leaves open.)

Each sentence leaves questions open. Q1–Q6 concern screening. Q7–Q12 and Q18–Q19 concern reciprocal nominees, Q20–Q21 accountability for reviews, Q13–Q14 assignment, Q15–Q16 early reject, and Q17 submission limits.

| #   | Phase        | Open question                                                                                         | Readings                                                                                                                                                                                  |
| --- | ------------ | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | screening    | Double-anonymity violation                                                                            | reject at once; fix window, then reject if uncured; the AC decides                                                                                                                        |
| Q2  | screening    | Who must agree to a desk reject                                                                       | AC alone; AC triage, then one senior PC member agrees; AC + a second AC; a vote of two senior and one junior PC member                                                                    |
| Q3  | screening    | Until when a desk reject is possible                                                                  | before assignment only; anonymity only, until reviews are released; any ground, until reviews are released; anonymity at any stage; any ground at any stage (the call reserves the right) |
| Q4  | screening    | Reviewers see the screening record                                                                    | never; after their own review, with a feedback form on the triage; always                                                                                                                 |
| Q5  | screening    | The second-opinion member reviews the paper if it stays in                                            | yes; no                                                                                                                                                                                   |
| Q6  | screening    | A fabricated reference is grounds on its own                                                          | yes; no, it's evidence for the AC                                                                                                                                                         |
| Q7  | reciprocal   | What an accepted nominee commits to                                                                   | may be assigned, up to a stated maximum; a stated expected load of *k* reviews                                                                                                            |
| Q8  | reciprocal   | Nominees per paper                                                                                    | one; up to *n*, chosen by the authors; at least one, no upper limit; several slots, at least one senior (juniors fill the rest) *Ruling (2026-11-15): "up to *n*" takes *n* from the venue (`PCS_NOMINEES_MAX`, default 3).* |
| Q9  | reciprocal   | Who may be nominated, and what "equitable" nomination means                                           | any co-author the AC finds qualified, with patterns (senior authors always nominating juniors) flagged to the PC chairs; a senior author must nominate themself; no constraint *Ruling (2026-11-15): repeats count: each nomination counts toward the pattern threshold, even when it names the same junior again; the threshold is the venue's (`PCS_PATTERN_MIN`, default 3).* |
| Q10 | reciprocal   | Consequence of non-compliance (no nominee, or a nominee who never registers with the matching system) | desk reject; warning, then desk reject; warning only                                                                                                                                      |
| Q11 | reciprocal   | Consequence of a failed review by an accepted nominee (absent, or grossly inadequate)                 | desk reject the nominee's own submissions; recorded for the PC chairs only; none                                                                                                                       |
| Q12 | reciprocal   | Withhold an author's own reviews until their reviews as a nominee are in                              | yes; no (revisit in a later year)                                                                                                                                                         |
| Q13 | assignment   | The slots beyond the two senior ones                                                                  | exactly one junior; one or two juniors; zero to two juniors ("when appropriate"); exactly one, filled by a junior or a nominee *Ruling (2026-11-15): under "zero to two juniors", juniors may fill seats in the first pass beside the seniors, or come in as reciprocal reviewers; both count toward the cap of two.* |
| Q14 | assignment   | Does a nominee the AC classifies as senior count toward the two senior slots                          | yes, tier alone decides; no, nominees fill only the non-senior slot, and their tier is kept for evaluation and expectations only                                                          |
| Q15 | early reject | What counts as a negative initial review                                                              | reject only; reject or weak reject; anything below the accept side of the scale                                                                                                           |
| Q16 | early reject | Do reviewers get a last word before an automatic early reject                                         | no, scores decide (reviewers are told up front to lean positive when borderline); a bump window of 24–72 h                                                                                |
| Q17 | submission   | A cap on submissions per author                                                                       | none; 9; another number                                                                                                                                                                   |
| Q18 | reciprocal | How a nominee's obligation adds up across the papers that nominate them | once, however many papers (a person owes *k* whether nominated by 1 paper or 9); cumulative, *k* per nominating paper; cumulative up to their tier's band; cumulative over their share of each paper (Q19) |
| Q19 | reciprocal | How a paper's obligation is split when it has several nominees | equally; as the authors allocate at submission; by the solver, wherever expertise fits; and if the AC declines one nominee, the rest absorb the share, or the paper is short |
| Q20 | reviewing | Does a consequence for review quality (Q11) require an earlier accountability request that the reviewer declined or left unanswered | yes; no |
| Q21 | reviewing | Who sees a reviewer's engagement record, and does it outlast the conference | the AC who sent each request, the junior PC chair for junior reviewers, and the PC chairs, for this conference only; the same, plus a summary handed to the next year's chairs |

Even this short list multiplies into millions of readings. The design keeps them apart by making each question a ruling with one owner, and by splitting the readings with example cards (§5.2).

**Choices fixed by design, not by ruling:**
- **The list of grounds is closed** (concept `Ground`). "Appears AI-written" is not on it, and no ruling can add it.
- **Silence never removes a paper.** A paper leaves review only through an explicit chain of actions (S8).
- **HotCRP is the system of record.** PC Supervisor never changes HotCRP by itself. Every change is an artifact a chair applies, and the next sync confirms it (H1–H3).

---

## 2. The parts, and who reads them

| Part | View the signer reads | Signer |
|---|---|---|
| Concepts (§3) | A purpose and a principle per concept | Process chairs |
| Rules (§3.7) | One sentence per rule | PC chairs, plus process chairs for routing and the solver |
| Policy (§3.8) | The role × permission table | PC chairs |
| Properties (§3.9) | One sentence each, with its kind of evidence | Process chairs, plus PC chairs for those marked ◆ |
| Examples (§3.10) | One outcome card per case | PC chairs |
| Scenarios, assumptions, accountability (§3.11) | One sentence each | Both |

---

## 3. The specification

### 3.0 Inventory and ownership

Each concept owns its state and refers to others only through type parameters. The **Owner** column says where the state lives:
- **HotCRP:** system of record; mirrored read-only;
- **PCS:** PC Supervisor's encrypted store;
- **sheet:** a shared sheet, imported;
- **TPMS:** files exchanged with the operator, imported.

| #                                          | Concept             | Purpose                                                                                                                                                  | Owner                               |
| ------------------------------------------ | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| **Frame**                                  |                     |                                                                                                                                                          |                                     |
| 1                                          | **Phase**           | Move the process through its stages on schedule, so that what is allowed changes with the date                                                           | PCS (dates in settings)             |
| 2                                          | **Ruling**          | Make every policy choice explicit, owned, and revisable                                                                                                  | PCS                                 |
| **HotCRP, mirrored**                       |                     |                                                                                                                                                          |                                     |
| 3                                          | **Person**          | Identify a person, with roles (chair, PC, AC, external) and user tags                                                                                    | HotCRP                              |
| 4                                          | **Tier**            | Say which kind of reviewer someone is (senior or junior, as the AC classified them) and how they joined (invited, self-nominated, or reciprocal nominee) | HotCRP tags; PCS rule               |
| 5                                          | **Submission**      | A paper, its versions, its authors, its artifact, its nominee field                                                                                      | HotCRP                              |
| 6                                          | **Conflict**        | Who must not judge, or see the judging of, which paper                                                                                                   | HotCRP                              |
| 7                                          | **Assignment**      | Who reviews which paper, in which role and round                                                                                                         | HotCRP                              |
| 8                                          | **Review**          | A reviewer's judgment: scores, text, status, ratings                                                                                                     | HotCRP                              |
| 9                                          | **Comment**         | Discussion and author responses                                                                                                                          | HotCRP                              |
| 10                                         | **Outcome**         | The decision on a paper, and its release                                                                                                                 | HotCRP                              |
| 11                                         | **Tag**             | Labels on papers, used for bookkeeping and as a handoff channel                                                                                          | HotCRP                              |
| **The HotCRP interface**                   |                     |                                                                                                                                                          |                                     |
| 12                                         | **Mirror**          | Know what HotCRP said, and when, including what it no longer says                                                                                        | PCS                                 |
| 13                                         | **Writeback**       | Change HotCRP only through artifacts a chair reviews, applies, and sees confirmed                                                                        | PCS → HotCRP                        |
| 14                                         | **Import**          | Bring in what HotCRP doesn't hold (TPMS files, sheets, lists), versioned                                                                                 | PCS                                 |
| **Reciprocal nominees and PC recruitment** |                     |                                                                                                                                                          |                                     |
| 15                                         | **Nomination**      | Make each submission put forward reviewers from its authors to pay back its reviewing, and watch who gets nominated                                              | HotCRP fields; PCS rule             |
| 16                                         | **Appointment**     | Put a nominee or self-nominee on the PC only with the AC's approval and tier classification, and the person's consent                                    | sheet (source of truth); PCS mirror |
| **Screening** (detail in §3.4)             |                     |                                                                                                                                                          |                                     |
| 18                                         | **Extraction**      | Turn a PDF into quotable text, and expose what a reader wouldn't see                                                                                     | PCS                                 |
| 19                                         | **Check**           | Look for one kind of ground and report evidence, never a verdict                                                                                         | PCS                                 |
| 20                                         | **Finding**         | One piece of evidence, located in the paper                                                                                                              | PCS                                 |
| 21                                         | **Ground**          | Name the reasons a paper may leave review early, and no others                                                                                           | spec (closed)                       |
| 22                                         | **Triage**          | The AC's verdict on a screened paper: keep, or refer                                                                                                     | PCS (HotCRP tag as handoff)         |
| 23                                         | **SecondOpinion**   | No paper leaves review on one person's word                                                                                                              | PCS                                 |
| 24                                         | **Remedy**          | A chance to cure a curable defect, where a ruling grants one                                                                                             | PCS                                 |
| 25                                         | **Disposition**     | Whether a paper is in review or removed, why, and when                                                                                                   | PCS; outcome written to HotCRP      |
| 26                                         | **Notice**          | Tell authors the outcome and its grounds, in words rendered from the findings                                                                            | PCS draft → HotCRP mail             |
| 27                                         | **Engine**          | Run model calls somewhere, and say what data that place may receive                                                                                      | PCS                                 |
| 28                                         | **Qualification**   | Evidence that a check version on an engine is good enough to show                                                                                        | PCS                                 |
| **Assignment**                             |                     |                                                                                                                                                          |                                     |
| 29                                         | **Affinity**        | Say how well a reviewer matches a paper, from sources we can name                                                                                        | PCS (from TPMS and local imports)   |
| 30                                         | **Plan**            | A proposed full assignment that meets composition and load, or says where it can't                                                                       | PCS → Writeback                     |
| **Reviewing and decisions**                |                     |                                                                                                                                                          |                                     |
| 31                                         | **Attention**       | Surface the papers, reviewers, and ACs that need a chair, with the reason                                                                                | PCS (rules over Mirror)             |
| 32                                         | **EarlyReject**     | Reject unanimous-reject papers before response, after reviewers get a last word                                                                          | PCS → Writeback                     |
| 33 | **Criterion** | Name what a good review does, so a request can point at specific criteria | PC chairs (a ruling) |
| 33b | **AccountabilityRequest** | Ask a reviewer to revisit a review against named criteria, and record how they engaged | PCS suggests; the AC or junior PC chair sends and disposes |
| 33c | **Accountability** | Hold accepted nominees to their commitment, with evidence a human weighs | PCS opens; PC chairs decide |
| 33a                                        | **SubmissionLimit** | Cap how many papers one author may submit, where a ruling sets a cap                                                                                     | PCS rule over HotCRP authors        |
| **Afterwards**                             |                     |                                                                                                                                                          |                                     |
| 34                                         | **Pseudonym**       | Let process data join a future cross-conference baseline without identities                                                                              | PCS                                 |

### 3.1 Frame

```
concept Phase
purpose    move the process through its stages on schedule
state      stages: registration < submission < screening < assignment < review
                   < early-reject < response < discussion < decision < notification
           deadline: Stage -> Time          -- settings; one function reads the clock (PCS_NOW)
actions    tick (t)                         -- time arrives as an action
```

```
concept Ruling [Person]
purpose    make every policy choice explicit, owned, and revisable
principle  a rule that depends on a choice reads it from a ruling. An unresolved
           ruling blocks whatever depends on it until its owner settles it
state
  rulings: Id -> { question: Q, reading, owner: Role,
                   status: settled | provisional | assumed | unresolved | referred,
                   since: Time, supersedes: lone Id }
actions
  propose (by, q, reading)    -> assumed
  settle  (by, id, reading)   requires by holds q's owner role
  revise  (by, id, reading)   requires as for settle; keeps the old ruling as superseded
  refer   (by, id, to)        requires q is outside by's authority
```

### 3.2 HotCRP and the interface to it

The HotCRP concepts (3, 5–11) are HotCRP's, and their visibility rules are HotCRP's `canSee`. PC Supervisor depends on them only through Mirror.

`Tier` is a PCS rule over HotCRP user tags (`PCS_TIER_TAGS`).

```
concept Mirror [Item]                      -- Item ranges over Person, Submission, Assignment,
                                            -- Review, Comment, Outcome, Tag
purpose    know what HotCRP said, and when, including what it no longer says
principle  every fact PCS shows came from a sync at a recorded time. A change is
           known no earlier than the sync that saw it. Something that disappears
           is recorded as gone, never silently dropped
state
  syncs:    seq { at: Time, counts, errors }
  seen:     Item -> { first_seen: Time, last_seen: Time, versions: seq (vtag, at),
                      gone_at: lone Time }
actions
  sync (at)                                 -- a full read through the API (spec §4)
```

```
concept Writeback [Change]
purpose    change HotCRP only through artifacts a chair reviews, applies, and sees confirmed
principle  PCS drafts a change set in HotCRP's own formats. A chair sees HotCRP's
           dry-run diff and confirms it. The change is applied, by the chair in HotCRP
           or by PCS through the API with that confirmation. The next sync must show
           the effect, or the artifact is flagged
state
  artifacts: Id -> { kind: assignment-csv | tags | comments | mail-search | settings-note,
                     body, purpose: Concept@id, drafted: Time,
                     dry_run: lone Diff, confirmed: lone (Person, Time),
                     applied: lone Time, observed: lone Time, mismatch: lone Diff }
actions
  draft    (sys, kind, body, purpose)
  dry-run  (sys, a)                         -- HotCRP's dry_run, never a write
  confirm  (chair, a)                       requires a.dry_run exists and is current
  apply    (chair | sys, a)                 requires a.confirmed
  observe  (sys, a)                         on the next sync: compare the intended and seen state
```

```
concept Import [Source]
purpose    bring in what HotCRP doesn't hold, versioned
state      imports: Source -> seq { at, file_hash, rows, row_errors }
           -- sources: tpms-scores, tpms-assignments, tpms-registrations, invites,
           --          refcheck (legacy)
actions    import (chair, source, file)     -- all rows or none; row-level errors reported
```

### 3.3 Reciprocal nominees and PC recruitment

```
concept Nomination [Paper, Person]
purpose    make each submission put forward qualified reviewers from among its authors,
           so that the reviewing a paper consumes is paid back, and watch the pattern
           of who gets nominated
principle  at submission, the authors of each paper name its nominees: one co-author,
           or as many as Q8 allows (up to the venue's n, default 3), chosen by the authors, optionally with each one's
           share of the paper's obligation (Q19). Each paper owes an obligation of k
           reviews (Q7). A person nominated by several papers owes what Q18 says:
           once, or the sum of their shares, capped or not. When the AC declines a
           nominee, that share moves to the paper's other nominees or is left unmet (Q19);
           it never moves to someone the authors didn't name. Where Q9 asks for
           equitable nomination, the pattern across an author's papers (who is
           nominated, who never is) is shown to the PC chairs as a signal, never as a
           sanction. Every nomination counts toward the signal's threshold (the
           venue's, default 3), so one junior nominated from several papers counts
           once for each
state
  nominees: Paper -> set Person          -- size 1 under Q8's "one" reading; at most n otherwise
  share:    (Paper, Person) -> lone Fraction   -- set by authors under Q19's "authors allocate";
                                               -- shares of one paper sum to 1
  pattern: Person -> { papers_authored: set Paper, times_nominated: Nat,
                       coauthors_nominated_instead: set Person }
actions    (written by authors in HotCRP; mirrored)
derived
  owed (p)  = k                                            -- Q7
  owes (u)  = combine over { p | u in nominees(p), u accepted } of share(p, u) × owed(p)
              -- combine is Q18: once → k if any; sum; min(sum, band(tier(u)).max)
```

```
concept Appointment [Person]
purpose    put a nominee or self-nominee on the PC only with the AC's approval and
           tier classification, and the person's consent
principle  every candidate (an invited reviewer, a self-nominee for senior or junior
           PC, or a reciprocal nominee) is assessed by an AC. The AC accepts or
           declines and, if accepting, classifies them as senior or junior. The person
           is then on the PC with that tier, whatever their origin
state      (the appointments sheet is the source of truth; PCS mirrors it through Import)
  candidates: Person -> { origin: invited | self-nominated | nominee (by: set Paper),
                          area, ac, decision: accept | decline | pending,
                          tier: lone (senior | junior), consent: lone Bool, on_pc_at: lone Time }
actions    (all in the sheet; PCS reads them)
sync       accepted with tier and consent, not yet on the PC
             => Writeback.draft (PC membership and tier tag)
```

```
concept SubmissionLimit [Person, Paper]
purpose    cap how many papers one author may submit, where a ruling sets a cap (Q17)
principle  authors are matched across papers by HotCRP account. Over-cap papers are
           reported to the PC chairs with the list, never withdrawn by the tool
state      count: Person -> Nat
```

### 3.4 Screening

The screening concepts are as designed earlier and are summarized here. The full text of Finding, Triage, SecondOpinion, and Engine is in [agent.md](agent.md) §3–§5 and must match the principles below.

```
concept Ground
state  Ground = format | scope | anonymity | fabricated-reference | misused-citation
              | no-contribution | nomination-noncompliance | prompt-injection
       -- closed: no ruling, check, or action adds a constructor.
       -- nomination-noncompliance is usable only if Q10 or Q11 admits it
```

- **Extraction:** text with page anchors, parsed references, layout facts, and hidden text. Principle: a quotation shown to anyone is one that Extraction can find.
- **Check:** a versioned specification. It *proposes* findings, never verdicts.
- **Finding:** `{ check@version, kind: Ground, anchors, depends: set Ruling, engine, status: unverified | verified }`. The agent's only action is to propose one. The harness verifies it.
- **Triage:** the AC keeps or refers. Keeping needs nobody else. A referral names grounds, each backed by an upheld, usable finding.
- **TriageFeedback:** under Q4's "after their own review" reading, each reviewer gets the paper's screening record once their review is submitted, with a short form: was the flag right, was anything missed, would you have referred it. The answers are the field evaluation of the screening (agent.md §8), and they never feed back into that paper's outcome.
- **SecondOpinion:** one unconflicted PC member who isn't the AC agrees or disagrees: keep or remove, recorded in the `Triage` field of their own screen-round review (the same field as the AC's) and mirrored by a chair like the AC's. The answer never changes that member's review load. Load is capped.
- **Remedy:** `{ ground, notified, due, cured }`, for curable grounds where a ruling grants it.
- **Disposition:** `in-review | removed { grounds, path: desk-reject | early-reject, by: chair, at }`, initially in-review. The outcome is written to HotCRP through Writeback.
- **Notice:** a template rendered from grounds and upheld findings. It never names an engine or asserts how a paper was written.
- **Engine and Qualification:** content goes only to engines cleared for its data class. Only qualified (check, engine) pairs are shown.

### 3.5 Assignment

```
concept Affinity [Paper, Person]
purpose    say how well a reviewer matches a paper, from sources we can name
principle  every score has a source and an import version. Missing scores are
           missing, not zero, and a paper whose best candidates are weak is reported
state
  score: (Paper, Person) -> lone { value: 0..1, source: tpms | local-specter | hotcrp-pref,
                                   import: Import@version }
```

```
concept Plan [Paper, Person]
purpose    propose a full assignment that meets composition and load, or say where it can't
principle  the solver proposes an assignment from affinity, under the hard exclusions
           (conflicts, authors, people not on the PC) and the composition
           and load rules. It reports every requirement it couldn't meet and every
           repair it made. A plan reaches HotCRP only as a Writeback artifact
state
  plans: Id -> { inputs: (Affinity@v, Conflict@sync, Appointment@v, Rulings@v),
                 edges: set (Paper, Person, slot: senior | junior, pinned: Bool),
                 unmet: Paper -> set Requirement, repairs: seq Repair, objective }
actions
  solve   (chair, inputs)                    -- spec §10.5
  repair  (sys, plan)                        -- break reciprocal cycles; re-solve warm
  export  (chair, plan) => Writeback.draft (assignment-csv, seniors first, then junior slots)
           -- checked by the PC chairs and process chairs before it is applied
```

### 3.6 Reviewing, early reject, and accountability

- **Attention:** the dashboard's rules (spec §5) over Mirror. These are signals with reasons: late reviews by tier, silent discussions, split papers, thin or flagged reviews, AC activity, and suggested accountability requests (below). Its actions are Writeback drafts: nudge comments, tags, and mail searches. It never contacts anyone itself.

```
concept EarlyReject [Paper, Person]
purpose    reject unanimous-reject papers before author response, after reviewers get a last word
principle  when initial reviews are in, the papers whose reviews are all negative
           (Q15) become candidates. Under Q16's bump reading, their reviewers are asked
           to re-read and may bump within the window. A candidate is early rejected
           only if it still meets the criterion when the window closes (or at once,
           without a bump window), its AC didn't object, and a chair confirms
state
  window:     lone { opened: Time, closes: Time, snapshot: Mirror@sync }
  candidates: Paper -> { reviewers: set Person, bumped_by: set Person, ac_objects: Bool }
actions
  open    (chair)          => Writeback.draft (mail-search: the candidates' reviewers)
  close   (sys)            -- at closes, from the next sync's scores
  confirm (chair, p)       requires p is a candidate, bumped_by is empty, not ac_objects,
                           the window has closed
                           => Disposition.remove (p, path: early-reject)
```

```
concept Criterion
purpose    name what a good review does, in the venue's own reviewer guidelines, so that
           a request to a reviewer points at specific criteria rather than a feeling
principle  the PC chairs keep a short numbered list taken from the reviewer guidelines
           (for example: summarizes the contribution in the reviewer's own words;
           judges the paper against its own claims; backs each weakness with evidence;
           tells the authors what would change the reviewer's mind; score consistent
           with the text; professional tone; on time). A request cites criteria from
           this list and nothing else
state      criteria: seq { id, text, guideline_ref }      -- a ruling (PC chairs)
```

```
concept AccountabilityRequest [Person, Review]
purpose    let an AC (or the junior PC chair) ask a reviewer to revisit a review against
           named criteria, and record how the reviewer engaged, so that reviewers who
           take up mentorship and improve can be told apart from those who don't
principle  a signal suggests that "the AC should probably reach out to reviewer r about
           review v, and remind them of criteria X, Y, Z". The suggestion is only a
           suggestion: the AC sends it as is, edits the criteria, or dismisses it, and a
           dismissed suggestion leaves no trace on the reviewer. A sent request goes to
           the reviewer in HotCRP, with the criteria's text and the AC's own words. When
           the reviewer replies, or the due date passes after one reminder, the AC
           records a disposition. The disposition, never the signal, is what counts.
           For junior reviewers the junior PC chair sees every request and can take over
state
  suggestions: set { reviewer, review, criteria: set Criterion,
                     source: heuristic | ac | junior-pc-chair, reasons: seq Text,
                     status: open | sent | dismissed }
  requests:    set { reviewer, review, criteria: set Criterion, by: Person,
                     sent_at: Time, due: Time, reminded_at: lone Time,
                     reply: lone { at: Time, review_revised: Bool },     -- from Mirror
                     disposition: lone ( revised          -- engaged; the review changed
                                       | explained        -- engaged; the AC agrees it stands
                                       | declined         -- replied, won't engage
                                       | no-reply         -- nothing by due, after a reminder
                                       | disputed ),      -- contests the criteria; escalated
                     disposed_by: lone Person, note: lone Text }
  engagement:  Person -> { engaged: Nat, declined: Nat, no_reply: Nat, open: Nat }
               -- derived from dispositions only
actions
  suggest  (sys | ac | jpc, reviewer, review, criteria, reasons)
  dismiss  (ac | jpc, s)
  send     (ac | jpc, s, criteria', words)
           => PCS renders the message from the criteria' text plus the AC's words; the
              AC posts it as a HotCRP comment to the reviewer (or Writeback.draft of a
              mail); the request counts as sent when Mirror observes it
  remind   (ac | jpc, r)                  requires now > due, no reply
  dispose  (ac | jpc, r, d, note)         requires a reply was observed, or (d = no-reply
                                          and reminded_at and now > due + grace)
                                          -- grace is the venue's (PCS_ACC_GRACE_H, default 48 h)
  escalate (ac, r)                        => junior PC chair for junior reviewers,
                                             otherwise the PC chairs; they dispose
```

The heuristic signals are deterministic and read review metadata and structure only: length, empty required fields, a negative score with no weakness given, a score far from the other reviews with no justification, lateness. No model reads review text (AR3). Most suggestions are expected to come from ACs and the junior PC chair reading reviews themselves; PCS's job is to make sending, tracking, and disposing cheap and consistent.

```
concept Accountability [Person, Paper]
purpose    hold accepted nominees to their commitment, with evidence a human weighs
principle  for each accepted nominee, their reviewing record (late, missing,
           rated inadequate) sits next to the submissions that nominated them. Where
           a paper has several nominees, a shortfall is attributed to the nominee who
           owed it, and through them to the papers whose share it was. A consequence under
           Q11 is a case that goes through the same SecondOpinion and chair path as a
           desk reject. It is never automatic
state
  cases: Person -> lone { record: evidence, requests: set AccountabilityRequest,
                          own_papers: set Paper, proposed: Q11 reading,
                          status: open | dismissed | upheld }
  -- under Q20's "yes", a case about review quality (as opposed to a missing review)
  -- needs at least one request disposed declined or no-reply
```

**Pseudonym:** `pid(email) = HMAC(key, email)`, where the key is held by the chairs. It is used on every exported row, and a given key always yields the same ID.

### 3.7 Synchronizations across the process

```
sync  Submission.submit (p)            => Nomination is checked: compliance (p); SubmissionLimit counted
sync  Submission.submit (p)            => Extraction; Checks; Findings          (screening)
sync  Triage.refer / SecondOpinion / Remedy  as in §3.4                          (screening)
sync  Phase reaches assignment         => only papers with disposition in-review enter Plan
sync  Plan.export confirmed + applied  => Mirror.sync must observe it (Writeback.observe)
sync  Appointment accepted + consented => Writeback (tier tag, PC membership); conflicts re-read before Plan
sync  Phase reaches early-reject       => EarlyReject.open
sync  Review missing/late by an accepted nominee past the escalation steps
                                       => Accountability case opened (never a consequence)
sync  Attention signal on a review     => AccountabilityRequest.suggest (heuristic); never sent by itself
sync  Mirror observes the AC's request comment => AccountabilityRequest marked sent; due date set
sync  Mirror observes a reply or a revised review => AC asked to dispose
sync  Request disposed declined or no-reply, reviewer is an accepted nominee
                                       => Accountability case may be opened (Q20)
sync  Ruling.revise (r)                => everything depending on r is recomputed;
                                          never removes a paper (S7)
sync  Mirror.sync sees an item gone    => recorded; Attention reports it if it mattered
```

### 3.8 Rules

```
rule tier (u) -> senior | junior
  the tier the AC assigned in Appointment, as carried by u's HotCRP tier tag

rule compliance (p) -> ok | missing-nominee | unregistered | flagged-pattern
  ok if p names the nominee(s) Q8 requires (under "up to n", at most the venue's n, default 3), each registered with the matching system under
  their HotCRP account; flagged-pattern is a signal for the PC chairs (Q9), not
  non-compliance

rule eligible (u, p) -> Bool
  u is on the PC (accepted, classified, consented), not an author of p,
  and not conflicted with p

rule composition (p) -> Requirement
  two senior slots, plus Q13's remaining slots. Under "zero to two juniors" the
  remaining slots are optional: up to two juniors may sit beside the seniors in the
  first pass, or arrive as reciprocal reviewers working off owes(u), and both kinds
  count toward the two. Who may fill which slot is Q14:
  under "tier alone decides", a nominee fills the slot of their tier; under
  "nominees fill only the non-senior slot", a senior slot needs a senior who is
  not there as a nominee, and the nominee's tier is recorded but not used here

rule load (u) -> band
  per tier, from the load-band rulings. For an accepted nominee, also owes(u) from
  Nomination, under Q18 and Q19: as a target the solver aims for, and never more
  than the tier's band. Whether nominations can raise a nominee's load is exactly Q18

rule cycle-free (plan) -> Bool
  no author of paper A reviews paper B while an author of B reviews A
  (and no such cycle up to length PCS_CYCLE_MAX_K)

rule may-remove (p, now) -> Bool                              -- the screening rule, generalized
  desk-reject:  as in agent.md (grounds, refer, second opinion, remedy, timing per Q3)
  early-reject: p is an EarlyReject candidate, the window has closed, no bumps, no AC objection

rule disposition (p) -> in-review | removed
  removed only by a chair's action when may-remove (p, now); otherwise in-review
```

The PC chairs' view of `eligible` and `composition`, rendered from the rules:

> *Each paper gets two senior PC reviewers and a third reviewer who is junior PC or a reciprocal nominee (the reading below Q13/Q14 under consideration; render from the rulings). Only people an area chair accepted onto the PC review, in the tier the area chair gave them. Nobody reviews a paper they wrote or is conflicted with.*

### 3.9 Policy

Y means granted. N means denied, and confirmed on a forbidden example. A dot means denied and not yet examined. † marks a cell set by a ruling. "PCS" is the tool acting on its own; every chair-facing action in PCS is taken by a person.

| Permission | Process chair | PC chair | AC (own paper) | Junior PC chair | Senior / junior PC | Accepted nominee | Author | PCS | Screening agent |
|---|---|---|---|---|---|---|---|---|---|
| Read HotCRP via the chair token | Y | . | N | N | N | N | N | Y (read) | N |
| Write to HotCRP directly | N | Y (in HotCRP) | Y (in HotCRP, own papers) | Y (comments) | Y (own reviews) | Y (own reviews) | Y (own paper) | N | N |
| Confirm and apply a Writeback | Y | Y | N | N | N | N | N | N | N |
| See the screening findings and summary | Y | Y | Y | N | †Q4 | †Q4 | N | Y | N |
| Keep or refer (triage) | . | . | Y | N | N | N | N | N | N |
| Give a second opinion | . | . | N | N | Y (requested) | N | N | N | N |
| Remove a paper (desk or early reject) | . | Y | N | N | N | N | N | N | N |
| Accept a PC candidate and classify their tier | . | Y (in the sheet, any candidate) | Y (in the sheet, own area) | N | N | N | N | N | N |
| See nomination patterns across an author's papers | Y | Y | N | N | N | N | N | Y | N |
| Solve and export a Plan | Y | . | N | N | N | N | N | N | N |
| See affinity scores and plan reports | Y | Y | Y (own papers) | N | N | N | N | Y | N |
| See reviewer identities | Y | Y | Y | Y (junior reviews) | † | † | N | Y | N |
| See review text | Y | Y | Y | Y (junior reviews) | † (HotCRP) | † (HotCRP) | after release | Y (local, encrypted) | **N** |
| Coach a junior review (HotCRP comment) | . | . | Y | Y | N | N | N | N | N |
| Set the review criteria | . | Y | N | N | N | N | N | N | N |
| Suggest an accountability request | . | . | Y (own papers) | Y (junior reviews) | N | N | N | Y (heuristics) | N |
| Send a request, remind, and record its disposition | . | . | Y (own papers) | Y (junior reviews; escalations) | N | N | N | N | N |
| See a reviewer's engagement record | . | †Q21 | †Q21 (own requests) | †Q21 (junior reviewers) | own only | own only | N | Y (local, encrypted) | N |
| Open or uphold an Accountability case | Y (open) | Y (uphold) | N | N | N | N | N | Y (open) | N |
| Settle a ruling | Y (process) | Y (policy) | N | N | N | N | N | N | N |
| Route checks to engines; record qualifications | Y | . | N | N | N | N | N | N | N |
| See per-AC consistency views | Y | Y | N | N | N | N | N | Y | N |
| Send anything outside the system | N | N | N | N | N | N | N | N (HotCRP, engines, resolver only) | N |

### 3.10 Properties

| ID | Property | Form | Evidence |
|---|---|---|---|
| **HotCRP interface** ||||
| H1 | PCS never changes HotCRP except by applying a confirmed Writeback whose dry run is current | safety | proved on the model; the client has no write method outside Writeback; E2E-tested |
| H2 | Every applied Writeback is observed on the next sync, or flagged with the mismatch | liveness / escalation | tested on the harness |
| H3 | Every fact PCS shows traces to a sync, and its time is shown when it is approximate | provenance | tested |
| H4 | Tests and scripts never reach a non-harness HotCRP | safety | the test helper refuses; CI only |
| H5 | The API token never reaches the browser, a log, or an error message | information flow | lint and test |
| **Reciprocal nominees and the PC** ||||
| V1 ◆ | Only people an AC accepted and classified, who consented, are assigned anything, and in the tier the AC gave them | safety | proved; the Plan excludes the rest |
| V2 ◆ | A nominee is never assigned more than their tier's band, and never more than owes(u) under Q18 and Q19; a paper's obligation is only ever met by the people its authors named | safety | proved for the solver |
| V5 | Under every Q18 reading, a nominee's planned load is within one review of owes(u), or the plan reports why | report | property tests on the solver |
| **Accountability requests** ||||
| AR1 ◆ | Every request cites only criteria on the list, and the reviewer sees which criteria and the AC's words | safety | proved |
| AR2 ◆ | Nothing reaches a reviewer without a person's send action, and only a person records a disposition | safety | proved |
| AR3 | Heuristic suggestions read review metadata and structure only; no model or third party receives review text | information flow | proved over the signal inputs; lint |
| AR4 ◆ | A reviewer's engagement record is built from dispositions only; a dismissed suggestion leaves no trace | safety | proved |
| AR5 | No-reply is recorded only after the due date, one reminder, and the grace period | safety | proved |
| AR6 ◆ | Under Q20's "yes", no Q11 consequence for review quality without an earlier request disposed declined or no-reply | safety | proved |
| V3 | A nomination pattern is only ever shown to the PC chairs, never used as a ground | safety | proved; `Ground` has no such case |
| V4 ◆ | No consequence under Q10 or Q11 without the same two-person path as a desk reject | safety | proved |
| **Assignment** ||||
| A1 ◆ | Every paper in review meets its composition, or appears in the plan report with the reason | safety + report | property tests on the solver |
| A2 ◆ | No plan contains a conflicted, authored, or not-on-the-PC edge | safety | property tests; differential against HotCRP's own checks |
| A3 | No reciprocal 2-cycle survives repair, and longer cycles up to K are reported | safety | property tests |
| A4 | Load stays within each tier's band, or the violation is reported | safety | property tests |
| A5 | The solver's flow matches HotCRP's MinCostMaxFlow on instances without tiers | differential | PLAN M14 |
| **Screening** (detail in the earlier design, unchanged) ||||
| S1 ◆ | No single person removes a paper: an AC referral plus agreement from a different, unconflicted person, then a chair's action | safety | proved |
| S2 ◆ | Every removal names grounds, each backed by an upheld, usable finding (desk) or by unanimous scores with no bump (early) | safety | proved |
| S3 ◆ | No notice, finding, or ground asserts how a paper was written | by construction | `Ground` is closed; template lint |
| S4 | Every quotation shown to a person appears at its anchor | safety | runtime check |
| S5 | Submission content reaches only engines cleared for its data class | information flow | the dispatcher; tests |
| S6 | The screening agent cannot change Triage, SecondOpinion, Disposition, or HotCRP | safety (propose-only) | no write scope; proved on the model |
| S7 ◆ | Revising a ruling never removes a paper. It may reopen removed papers for reinstatement | relates two runs | proved |
| S8 ◆ | Silence keeps: with no verdict, a keep, a disagree, an unanswered request, a bump, or an AC objection, the paper stays in review | safety | proved |
| S9 | After screening, a desk reject uses only the grounds and stages Q3 allows (under "until reviews are released", none after release) | safety | proved |
| S10 | Remedies are honored before a removal on that ground | safety | proved |
| S11 | A member's review load is the same whatever they answered in second opinions | relates two runs | proved for Plan |
| S12 | Under Q4's "after their own review" reading, a reviewer sees a paper's screening record only once their review of it is submitted, and is then asked for feedback on the triage | safety | proved over the reveal rule; feedback rate monitored |
| **Early reject** ||||
| E-1 ◆ | Early reject only if every initial review is negative under Q15 at the time of removal, after any Q16 window has closed, with no AC objection, and by a chair | safety | proved |
| E-2 | Every candidate's reviewers are included in the window's mail search | coverage | tested |
| **Confidentiality** ||||
| C1 | Review and comment text never reaches an LLM or any third party | information flow | spec §7; no engine accepts the type |
| C2 | Authors never learn who gave a second opinion, which engine produced a finding, or who bumped a score | relates two runs | proved; template lint |
| C3 | Exports carry pseudonyms only, and the same key always yields the same pseudonym | safety | test (PLAN M20) |
| **Monitors and scenarios** ||||
| M1 | PC chairs are notified when an AC's referral or removal rate falls outside the band in their area | escalation | monitor |
| M2 | Process chairs are notified of route gaps, stale imports, and Writeback mismatches | escalation | monitor |
| M3 | **Conflict engineering.** PC chairs are notified when a paper's declared conflicts exclude an unusual share of the qualified reviewers in its area | escalation | monitor (collusion signal; never a ground) |
| M4 | PC chairs are notified of authors over Q17's cap, and of nomination patterns under Q9 | escalation | monitor |
| Q1 | 4,000 submissions: all checks within 72 h; a full solve in under 30 s; a sync in under N minutes | scenario | measured |
| **Not vacuous** ||||
| L1 | Each check flags a planted defect of its kind. Each Y in the policy is exercised by some trace | existence | mutation corpus; model search |
| L2 ◆ | Each admitted ground, early reject, and appointment of a nominee can happen in some trace | existence | model search |

### 3.11 Examples

These are synthetic cases with the outcome a signer confirms. Each card shows the inputs, what PCS shows, and what changes in HotCRP (as a Writeback).

| # | Case | Expected outcome | Settles / exercises |
|---|---|---|---|
| **Reciprocal nominees** ||||
| X1 | A paper names no nominee | Non-compliant; per Q10 | **Q10**; compliance |
| X2 | One person is nominated by 9 papers; k = 3 | Owes 3 (once), 27 (cumulative), or their tier's band maximum (capped). One PC appointment in every case | **Q18**; V2 |
| X3 | A senior author with 6 papers always nominates a different student co-author | Shown to the PC chairs as a pattern; no consequence by itself | **Q9**; V3, M4 |
| X3b | A senior author nominates the same student from 3 papers | Shown to the PC chairs as a pattern: every nomination counts, repeats included | **Q9** (threshold: venue); V3, M4 |
| X4 | The AC accepts a nominee and classifies them senior | Eligible for a senior slot, or only the non-senior slot (tier recorded for evaluation) | **Q14** |
| X5 | The AC declines a nominee who is otherwise the best match | Never assigned | V1 |
| X6 | An accepted nominee never submits; escalation exhausted | An Accountability case. Consequence only through two people | **Q11**; V4 |
| X7 | An author is on 11 submissions | Reported to the PC chairs | **Q17**; M4 |
| X8 | A paper names two nominees and allocates two-thirds and one-third of k = 3 | Owes 2 and 1 respectively under "authors allocate"; 1.5 each (rounded by the solver) under "equally" | **Q8**, **Q19** |
| X9 | A paper names two nominees; the AC declines one | The other owes the paper's whole obligation, or the paper is short and appears in the plan report | **Q19**; V2 |
| X11 | A paper names four nominees | Too many under "one" and, with the venue's n at its default of 3, under "up to n"; reported, and Q10's consequence applies | **Q8** (n: venue) |
| X12 | A PC chair records an accept for a candidate whom no AC of a nominating paper has decided on; a PC member who is neither the paper's AC nor a chair does the same | The chair's decision counts; the other is never acted on | policy cell `classify` |
| X10 | An author is the sole nominee on 4 papers and misses all their reviews | One Accountability case, listing the 4 papers whose obligation went unmet | **Q11**, **Q18**; V4 |
| **Accountability requests** ||||
| C1 | A junior's review gives weak reject with no weakness listed | Suggested: criteria "backs each weakness with evidence" and "tells the authors what would change their mind". The AC sends it; the reviewer revises: disposition revised, counted as engaged | AR1, AR2, AR4 |
| C2 | The reviewer replies that the review stands, with reasons the AC accepts | Disposition explained; counted as engaged | AR4 |
| C3 | No reply by the due date; a reminder; still nothing after the grace period (the venue's, default 48 h) | Disposition no-reply; the junior PC chair sees it | AR5 |
| C4 | The AC dismisses a heuristic suggestion | Nothing on the reviewer's record | AR4 |
| C5 | The reviewer contests the criteria themselves | Escalated to the junior PC chair (junior) or the PC chairs; they dispose | escalate |
| C6 | An accepted nominee has two no-reply requests on thin reviews | An Accountability case may be opened under Q20's "yes"; never under it without them | **Q20**; AR6, V4 |
| C7 | The conference ends | Engagement records kept for this conference only, or summarized for the next chairs | **Q21** |
| **Assignment** ||||
| P1 | The solver's first pass gives a paper three juniors | Repaired to two seniors plus Q13's remaining slot(s), or reported. Under "zero to two juniors", two juniors are fine and a third is not, reciprocal nominees counting | A1; **Q13** |
| P2 | A senior would get 17 papers with a band of 10–15 | Load spread, or reported | A4 |
| P3 | The authors of A and B are each the best match for the other's paper | The cycle is broken at its weakest edge; reported | A3 |
| P4 | A junior with no TPMS profile | Local affinity used and labeled; weak-match report if needed | Affinity |
| P5 | A plan exported, confirmed, applied; the next sync shows one assignment missing | Writeback mismatch, flagged | H2 |
| P6 | A paper declares conflicts with 80% of the senior PC in its area | M3 notice; plan reports a weak match if needed | M3 |
| **Screening** (from the earlier design) ||||
| E1 | Clean paper; the AC never opens it | In review | S8 |
| E3 | The artifact README names the authors' lab | Per Q1 | **Q1** |
| E4 | Self-reveal found in review, before release | Late desk reject, if Q3 allows | **Q3**; S9 |
| E4b | Self-reveal found after reviews are released | Desk reject only under Q3's "any stage" reading | **Q3**; S9 |
| E6 | Two references exist in no index | Grounds or evidence | **Q6** |
| E8 | AC refers; second opinion disagrees | In review; the member reviews it or not | **Q5**; S11 |
| E9 | Hidden instructions in white text | A finding on ground `prompt-injection`, for the AC's triage; the text is stripped and the summary unchanged | S4 |
| E10 | The model quotes a sentence that isn't in the paper | Never shown | S4 |
| E11 | Q6 revised after the screening deadline | No paper in review is removed | S7 |
| E12 | The dev engine is asked to run on a real submission | Refused | S5 |
| **Early reject** ||||
| R1 | Three rejects; one reviewer bumps within the window | In review, under a bump-window reading | **Q16**; E-1 |
| R2 | Three rejects | Early reject, confirmed by a chair | E-1 |
| R3 | Reject, reject, weak reject | Candidate only under Q15's wider reading | **Q15** |
| **Interface** ||||
| I1 | A review is deleted in HotCRP between syncs | Recorded as gone; Attention reports it if the paper is short | Mirror |
| I2 | A chair edits an assignment directly in HotCRP | Mirror shows it; the plan is marked stale | Mirror; Plan |
| I3 | An accepted nominee was added as an external reviewer, not to the PC | Writeback draft moves them to PC membership (rounds can't change for externals) | Appointment sync |

### 3.12 Scenarios, assumptions, and accountability

```
scenario Q1  ~4,000 submissions, ~40 ACs, ~500 senior + junior PC plus accepted nominees:
             screening within 72 h; triage + second opinions within the screening window;
             a full solve under 30 s; a sync under the interval

assume A1    HotCRP's records (authorship, conflicts, roles, reviews) are correct -- system of record
assume A2    HotCRP's API returns what its UI shows a chair (checked by the M0 probe and contract tests)
assume A3    TPMS files are what the operator sent; scores, where provided, mean affinity
assume A4    the appointments sheet records the ACs' real decisions -- PCS reads it, never edits it
assume A5    extracted text matches what a reader sees, except hidden text, which is flagged
assume A6    public indexes are right about which works exist (missing ≠ fabricated: Q6)
assume A7    each engine's provider honors its recorded agreement
assume A8    ACs, second-opinion members, and reviewers read before they decide
             -- not provable; bounded by two-person paths and watched by M1

accountable  PC chairs: rulings on policy questions, admitted grounds, the policy table,
               the examples, every removal they apply
             process chairs: Mirror, Writeback, Plans they export, checks, engines,
               qualifications, the manifest
             ACs: triage verdicts, PC appointments and tier classifications,
               early-reject objections
             second-opinion members: their answers
             junior PC chair: requests to junior reviewers and their dispositions,
               and escalations
             ACs, also: the requests they send and the dispositions they record
             the provider agreement behind each confidential clearance: a ruling
               the PC chairs settle
```

---

## 4. The manifest view

| Judgment | Category | Established by | Who is affected if wrong |
|---|---|---|---|
| Nomination compliance | deterministic | Rules; X1 | Authors |
| Nomination pattern | deterministic signal, then the PC chairs | M4; X3 | Senior and junior co-authors |
| Tier of a person | deterministic | HotCRP tags; rule | Reviewers |
| Eligibility and exclusions | deterministic | Rules; A2; X5 | Authors, reviewers |
| Affinity | model (TPMS / local), named source | Import provenance; P4 | Authors (fit of reviewers) |
| Assignment | optimization, then a chair confirms | A1–A5; Writeback dry run | Everyone |
| PC appointment and tier | escalated: the AC decides, the person consents | V1 | Candidates; authors (reviewer quality) |
| Screening grounds | deterministic or bounded LLM, then the AC | agent.md; S1–S11 | Authors |
| Desk reject | escalated: two people, then a chair | S1, S2, S7–S10 | Authors |
| Attention signals | deterministic heuristics | spec §5; golden scenario | ACs and reviewers (nudged) |
| Accountability-request suggestions | deterministic heuristics, then the AC or junior PC chair | AR2–AR4; C1, C4 | Reviewers (asked to revisit) |
| Early reject | escalated: reviewers' last word, then a chair | E-1 | Authors |
| Nominee consequence | escalated: two people, then a chair | V4 | Nominees and their co-authors |
| Conflict engineering | deterministic signal, then the PC chairs | M3 | Authors; reviewers |

---

## 5. Getting to a signed specification

**Status (2026-11-13):** steps 2–6 run on the Lean model in [`model/`](../model/README.md), steps 4 and 6 in part. `lake build` checks the proved properties, including the policy table's. `lake exe report <answers file>` prints the narrowing, the cards to bring for open questions, the policy table at the answered reading, the L1/L2 trace search, the mutation results, and consequences on a synthetic conference from the Plan solver (min-cost max-flow, spec §10.5). Steps 1 and 7 have not run.

1. **Elicit.** The agent drafts the readings table from the steering committee's text and past CFPs. The chairs may add questions, but not grounds.
2. **Separate the readings by example.** The tool picks the cards that split the remaining readings most evenly. The splitting cards are E3, E4, E6, E8, X1, X2, X3, X4, X6, X7, R1, and R3. Each answer settles a question, because the cards were built to vary one question each. A combined card could settle several at once, but is harder to read.
3. **Mutate the signed specification.** For example:
   - "second opinion from anyone";
   - "assign someone the AC hasn't accepted";
   - "combine ignores the Q18 reading";
   - "a declined nominee's share moves to someone the authors didn't name";
   - "apply without a dry run";
   - "early reject before the window closes";
   - "silence removes";
   - "a dismissed suggestion counts against the reviewer";
   - "a heuristic suggestion is sent without an AC";
   - `cycle-free` with K = 1.

   Each mutant must be killed by an example or a property. Survivors identify clauses signed without evidence, and each gets a boundary card.
4. **Check that the specification can be met.**
   - At the target scale, does the composition admit a solution given expected conflicts?
   - Does `pick` find second opinions within the cap?
   - With accepted nominees counted, are there enough seniors per area for two per paper?
5. **Check the policy against the work.** Run the trace search for L1 and L2.
6. **Show the consequences** of a ruling change, or of a plan export, before it takes effect: which papers it moves.
7. **Sign.**

---

## 6. Mapping to the implementation

| Concepts | Where |
|---|---|
| Open questions, rules, properties, examples, policy, Plan | `model/` (Lean): Readings, Model, Properties, Validate, Policy, Solver |
| Phase, Ruling | spec §4.1 (the answers file holds the rulings), §10.1 (phase dates); agent.md §3.1 (decision records = rulings) |
| Mirror | spec §1–§4 (sync, snapshots, first_seen, deletions) |
| Writeback | spec §6 (artifacts and their dry runs) |
| Every non-chair action in §3.9 | spec §11 (the HotCRP trace each one leaves; HotCRP is the shared record) |
| Import | spec §10.3 |
| Nomination, Appointment, SubmissionLimit | spec §10.3 (`appointments` import), §10.4 A |
| Screening concepts | agent.md; spec §10.4 B (triage, second opinion, remedy, disposition, TriageFeedback) |
| Affinity, Plan | spec §10.4 C, §10.5 (solver) |
| Attention | spec §5 (rules), §10.4 D, F |
| EarlyReject | spec §10.4 E |
| Criterion, AccountabilityRequest, Accountability | spec §10.4 D, §11 |
| Pseudonym | spec §10.4 G |

The model is the oracle for the implementation's tests: the example cards become generated tests, and the Lean solver is the reference for `core`'s solver (spec §9.1, PLAN M1).
