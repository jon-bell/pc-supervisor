import ReviewProcess.Readings
/-
  The executable model of docs/concepts.md §3: the rules that decide removal,
  composition, nominee obligations, early reject, and accountability requests.
  Every rule takes a `Reading` (the chairs' answers) and `Params` (all false in
  the signed model; a mutant sets one flag). Times are hours, and nothing here
  reads a clock.
-/
namespace ReviewProcess

abbrev PersonId := Nat
abbrev Time := Nat

inductive Tier | senior | junior
  deriving DecidableEq, Repr, Inhabited

inductive Ground
  | format | scope | anonymity | fabricatedReference | misusedCitation | noContribution
  | nominationNoncompliance | promptInjection
  deriving DecidableEq, Repr, Inhabited

def Ground.name : Ground → String
  | .format => "format" | .scope => "scope" | .anonymity => "anonymity"
  | .fabricatedReference => "fabricated reference" | .misusedCitation => "misused citation"
  | .noContribution => "no contribution" | .nominationNoncompliance => "nomination non-compliance"
  | .promptInjection => "prompt injection"

inductive Stage | screening | assigned | inReview | released
  deriving DecidableEq, Repr, Inhabited

/-- One flag per mutant of the signed specification (§5 step 3). -/
structure Params where
  secondOpinionFromAnyone : Bool := false
  silenceRemoves : Bool := false
  assignUnaccepted : Bool := false
  combineIgnoresQ18 : Bool := false
  declinedShareToUnnamed : Bool := false
  earlyRejectBeforeWindowCloses : Bool := false
  dismissedSuggestionCounts : Bool := false
  heuristicSendsItself : Bool := false
  applyWithoutDryRun : Bool := false
  cycleK1 : Bool := false
  deriving Repr, Inhabited

/-! ### Desk reject: Triage, SecondOpinion, Remedy, Disposition -/

structure Opinion where
  who : PersonId
  isAc : Bool := false
  tier : Option Tier := none
  conflicted : Bool := false
  agrees : Bool := true
  deriving Repr, Inhabited

structure Referral where
  ac : PersonId
  ground : Ground
  opinions : List Opinion := []
  stage : Stage := .screening
  /-- Q1 fix window: offered, due, cured. -/
  remedyOffered : Bool := false
  remedyDue : Time := 0
  cured : Bool := false
  /-- Q10: the authors were warned and did not fix it. -/
  warned : Bool := false
  /-- When the second-opinion request was sent; silence is measured from here. -/
  askedAt : Time := 0
  now : Time := 0
  deriving Repr, Inhabited

/-- Opinions that count: agree, not the referring AC, not conflicted. -/
def validOpinions (p : Params) (ref : Referral) : List Opinion :=
  ref.opinions.filter fun o =>
    o.agrees && (p.secondOpinionFromAnyone || (o.who != ref.ac && !o.conflicted))

def q2Met : Q2 → List Opinion → Bool
  | .acAlone, _ => true
  | .acPlusSenior, v => v.any (·.tier == some .senior)
  | .acPlusAc, v => v.any (·.isAc)
  | .vote, v => (v.filter (·.tier == some .senior)).length ≥ 2 && (v.filter (·.tier == some .junior)).length ≥ 1

/-- Rule `may-remove`, part 1: nobody removes a paper on one person's word,
    unless Q2's "AC alone" reading is chosen. -/
def twoPerson (p : Params) (r : Reading) (ref : Referral) : Bool :=
  match r.q2 with
  | .acAlone => true
  | q => !(validOpinions p ref).isEmpty && q2Met q (validOpinions p ref)

def groundAdmissible (r : Reading) (ref : Referral) : Bool :=
  match ref.ground with
  | .fabricatedReference => r.q6 == .grounds
  | .nominationNoncompliance =>
    match r.q10 with
    | .deskReject => true
    | .warnThenReject => ref.warned
    | .warnOnly => false
  | _ => true

def stageAllowed : Q3 → Ground → Stage → Bool
  | .beforeAssignment, _, s => s == .screening
  | .anonUntilRelease, g, s => s == .screening || (g == .anonymity && s != .released)
  | .anyUntilRelease, _, s => s != .released
  | .anonAnyStage, g, s => s == .screening || g == .anonymity
  | .anyAnyStage, _, _ => true

def remedyHonored (r : Reading) (ref : Referral) : Bool :=
  if ref.ground == .anonymity && r.q1 == .fixWindow then
    ref.remedyOffered && ref.now > ref.remedyDue && !ref.cured
  else true

/-- May the AC keep (not refer) a paper with this ground? Under Q1's "reject at
    once", an anonymity violation can't be kept. -/
def acMayKeep (r : Reading) (g : Ground) : Bool := g != .anonymity || r.q1 != .rejectAtOnce

def mayRemove (p : Params) (r : Reading) (ref : Referral) : Bool :=
  let silent := p.silenceRemoves && ref.opinions.isEmpty && ref.now ≥ ref.askedAt + 72
  (twoPerson p r ref || silent) && groundAdmissible r ref && stageAllowed r.q3 ref.ground ref.stage
    && remedyHonored r ref

inductive Disposition | inReview | removed (g : Ground)
  deriving DecidableEq, Repr, Inhabited

inductive DRAction
  | keep | refer (g : Ground) | opinion (o : Opinion) | remedy (due : Time) | cure | tick (t : Time)
  | remove (byChair : Bool)
  deriving Repr

structure DRState where
  ref : Referral
  disp : Disposition := .inReview
  deriving Repr, Inhabited

def drStep (p : Params) (r : Reading) (s : DRState) : DRAction → DRState
  | .keep => s
  | .refer g => { s with ref := { s.ref with ground := g } }
  | .opinion o => { s with ref := { s.ref with opinions := s.ref.opinions ++ [o] } }
  | .remedy due => { s with ref := { s.ref with remedyOffered := true, remedyDue := due } }
  | .cure => { s with ref := { s.ref with cured := true } }
  | .tick t => { s with ref := { s.ref with now := t } }
  | .remove byChair =>
    if byChair && s.disp == .inReview && mayRemove p r s.ref then { s with disp := .removed s.ref.ground } else s

/-! ### Early reject -/

inductive Score | strongReject | reject | weakReject | borderline | weakAccept | accept | strongAccept
  deriving DecidableEq, Repr, Inhabited

def Score.rank : Score → Nat
  | .strongReject => 0 | .reject => 1 | .weakReject => 2 | .borderline => 3
  | .weakAccept => 4 | .accept => 5 | .strongAccept => 6

def Score.name : Score → String
  | .strongReject => "strong reject" | .reject => "reject" | .weakReject => "weak reject"
  | .borderline => "borderline" | .weakAccept => "weak accept" | .accept => "accept" | .strongAccept => "strong accept"

def negative (r : Reading) (s : Score) : Bool :=
  match r.q15 with
  | .rejectOnly => s.rank ≤ 1
  | .rejectOrWeak => s.rank ≤ 2
  | .belowAccept => s.rank ≤ 3

structure ERCase where
  scores : List Score
  bumped : Bool := false
  windowClosed : Bool := false
  acObjects : Bool := false
  deriving Repr, Inhabited

def mayEarlyReject (p : Params) (r : Reading) (c : ERCase) : Bool :=
  !c.scores.isEmpty && c.scores.all (negative r) && !c.acObjects &&
    (r.q16 == .noWindow || ((c.windowClosed || p.earlyRejectBeforeWindowCloses) && !c.bumped))

/-! ### Nominations and obligations

Shares are in sixths of a paper's obligation, so halves and thirds are exact.
Obligations are in sixths of a review. -/

def k : Nat := 3

structure Nominee where
  who : PersonId
  share : Nat := 0          -- sixths, when the authors allocate (Q19)
  accepted : Bool := true
  deriving Repr, Inhabited

structure PaperNoms where
  paper : Nat
  nominees : List Nominee
  deriving Repr, Inhabited

/-- What each named nominee of one paper owes for that paper, in sixths of a
    review, or `none` when Q19 pools the obligation. Declined nominees owe nothing. -/
def paperShares (p : Params) (r : Reading) (pn : PaperNoms) : Option (List (PersonId × Nat)) :=
  let acc := pn.nominees.filter (·.accepted)
  let n := pn.nominees.length
  let full := 6 * k
  match r.q19 with
  | .solverPooled => if n == 1 then some (acc.map fun x => (x.who, full)) else none
  | split =>
    let raw : Nominee → Nat := fun x =>
      if split == .equal then (if n == 0 then 0 else full / n) else x.share * k
    let declined := (pn.nominees.filter (!·.accepted)).foldl (fun s x => s + raw x) 0
    let accTotal := acc.foldl (fun s x => s + raw x) 0
    let shares := acc.map fun x =>
      let extra :=
        if r.q19b == .othersAbsorb && !p.declinedShareToUnnamed && accTotal > 0 then declined * raw x / accTotal
        else 0
      (x.who, raw x + extra)
    some shares

/-- How much of a paper's obligation is left unmet by its named nominees (sixths). -/
def paperShortfall (p : Params) (r : Reading) (pn : PaperNoms) : Nat :=
  match paperShares p r pn with
  | none => if pn.nominees.any (·.accepted) then 0 else 6 * k
  | some ss => 6 * k - min (6 * k) (ss.foldl (fun s x => s + x.2) 0)

/-- The PC slot a declined share goes to when the mutant moves it to someone the authors didn't name. -/
def movedToUnnamed (p : Params) (r : Reading) (pn : PaperNoms) : Bool :=
  p.declinedShareToUnnamed && r.q19b == .othersAbsorb && pn.nominees.any (!·.accepted)

def bandMax : Tier → Nat
  | .senior => 15
  | .junior => 8

/-- Rule `owes`: what person `u` owes across all papers that nominate them, in
    sixths of a review. Q18 combines; `none` if every share is pooled (Q19). -/
def owes (p : Params) (r : Reading) (tier : Tier) (all : List PaperNoms) (u : PersonId) : Option Nat :=
  let mine := all.filter fun pn => pn.nominees.any fun x => x.who == u && x.accepted
  if mine.isEmpty then some 0 else
  let shares := mine.map fun pn => (paperShares p r pn).map fun ss => (ss.filter (·.1 == u)).foldl (fun s x => s + x.2) 0
  let q18 := if p.combineIgnoresQ18 then Q18.once else r.q18
  match q18 with
  | .once => some (6 * k)
  | .perPaper => some (6 * k * mine.length)
  | .shareWeighted => shares.foldl (fun acc s => do let a ← acc; let b ← s; pure (a + b)) (some 0)
  | .cappedAtBand =>
    (shares.foldl (fun acc s => do let a ← acc; let b ← s; pure (a + b)) (some 0)).map
      fun t => min t (6 * bandMax tier)

/-- Sixths of a review, shown as reviews (rounded up). -/
def showSixths (n : Nat) : String :=
  if n % 6 == 0 then s!"{n / 6}" else s!"{n / 6} {n % 6}/6"

/-! ### Nomination checks, patterns, and the submission cap (spec §10.4 A)

Rule `compliance` (concepts §3.8) for one paper, a signal for the PC chairs on
nomination patterns (Q9), and the cap on submissions (Q17). Q9 is not a question of
the model: the signal is shown to the PC chairs under every reading and is never a
ground (`Ground` has no such case, V3). -/

/-- Q8 "up to n": the venue's bound on nominees per paper (`PCS_NOMINEES_MAX`). -/
def nomineeMax : Nat := 3

/-- A nominee needs at least this many of an author's papers before a pattern shows. -/
def patternMinPapers : Nat := 3

inductive Compliance | ok | missingNominee | tooManyNominees | unregistered
  deriving DecidableEq, Repr, Inhabited

def Compliance.key : Compliance → String
  | .ok => "ok" | .missingNominee => "missing-nominee" | .tooManyNominees => "too-many-nominees"
  | .unregistered => "unregistered"

/-- Rule `compliance (p)`: the paper names the nominees Q8 allows (declined ones were still
    named by the authors), each registered with the matching system. -/
def compliance (r : Reading) (pn : PaperNoms) (registered : List PersonId) : Compliance :=
  let n := pn.nominees.length
  let tooMany := match r.q8 with
    | .one => decide (n > 1)
    | .upToN => decide (n > nomineeMax)
    | .atLeastOne => false
  if n == 0 then .missingNominee
  else if tooMany then .tooManyNominees
  else if pn.nominees.any (fun x => !registered.contains x.who) then .unregistered
  else .ok

/-- The Q9 signal for one author: a senior with at least `patternMinPapers` papers whose
    nominee is always someone else, always a junior. `noms` is one (nominee, tier) per paper. -/
def nominationPattern (author : PersonId) (authorTier : Option Tier) (noms : List (PersonId × Option Tier)) : Bool :=
  authorTier == some .senior && decide (noms.length ≥ patternMinPapers) &&
    noms.all fun (w, t) => w != author && t == some .junior

/-- What a pattern does by itself: nothing (V3). -/
def patternConsequence : String := "no consequence by itself"

/-- Q17: the most papers one author may be on. -/
def submissionCap (r : Reading) : Option Nat :=
  match r.q17 with
  | .noCap => none
  | .cap9 => some 9

/-- How many of an author's `n` papers are over the cap. -/
def papersOverCap (r : Reading) (n : Nat) : Nat :=
  match submissionCap r with
  | none => 0
  | some c => n - c

/-! ### Eligibility and composition -/

structure Member where
  who : PersonId
  tier : Option Tier          -- the AC's classification; none if not classified
  nominee : Bool := false
  accepted : Bool := true
  consented : Bool := true
  deriving Repr, Inhabited

structure PaperFacts where
  authors : List PersonId := []
  conflicts : List PersonId := []
  deriving Repr, Inhabited

/-- Rule `eligible` (V1). -/
def eligible (p : Params) (m : Member) (pf : PaperFacts) : Bool :=
  m.tier.isSome && (p.assignUnaccepted || (m.accepted && m.consented))
    && !pf.authors.contains m.who && !pf.conflicts.contains m.who

def fillsSenior (r : Reading) (m : Member) : Bool :=
  m.tier == some .senior && (r.q14 == .tierDecides || !m.nominee)

/-- Who may fill the slot beyond the two senior ones, under Q13 and Q14. A member
    fills at most one kind of slot, so tiers partition the reviewers (spec §10.5). -/
def fillsThird (r : Reading) (m : Member) : Bool :=
  !fillsSenior r m &&
  match r.q13 with
  | .oneJuniorOrNominee => m.nominee || m.tier == some .junior
  | _ => m.tier == some .junior && (r.q14 == .tierDecides || !m.nominee)

/-- How many slots beyond the senior ones the solver must fill (the optional
    second junior of "one or two juniors" is not required). -/
def thirdSlots (r : Reading) : Nat := if r.q13 == .zeroToTwoJuniors then 0 else 1

/-- Rule `composition`: does this set of reviewers meet Q13 and Q14? -/
def compositionOk (r : Reading) (seats : List Member) : Bool :=
  let seniors := seats.filter (fillsSenior r)
  let others := seats.filter (!fillsSenior r ·)
  let juniors := others.filter fun m => m.tier == some .junior && (r.q14 == .tierDecides || !m.nominee)
  let nomineeOrJunior := others.filter fun m => m.nominee || m.tier == some .junior
  seniors.length ≥ 2 &&
  match r.q13 with
  | .oneJunior => others.length == 1 && juniors.length == 1
  | .oneOrTwoJuniors => juniors.length == others.length && 1 ≤ others.length && others.length ≤ 2
  | .zeroToTwoJuniors => juniors.length == others.length && others.length ≤ 2
  | .oneJuniorOrNominee => others.length == 1 && nomineeOrJunior.length == 1

/-! ### Reciprocal cycles -/

/-- Edges are (reviewer, paper); `authorOf` maps a paper to its authors. Count
    2-cycles: a reviewer of B wrote A while a reviewer of A wrote B. With the
    K = 1 mutant, only self-review is checked. -/
def twoCycles (p : Params) (edges : List (PersonId × Nat)) (authorOf : Nat → List PersonId) : Nat :=
  if p.cycleK1 then 0 else
  let pairs := edges.flatMap fun (u, b) =>
    (edges.filter fun (v, a) => a != b && (authorOf a).contains u && (authorOf b).contains v).map fun (_, a) => (min a b, max a b)
  pairs.eraseDups.length

/-! ### Writeback -/

structure Change where
  dryRunOk : Bool
  confirmed : Bool
  deriving Repr, Inhabited

def mayApply (p : Params) (c : Change) : Bool := c.confirmed && (c.dryRunOk || p.applyWithoutDryRun)

/-! ### Accountability requests -/

inductive ReqDisposition | revised | explained | declined | noReply | disputed
  deriving DecidableEq, Repr, Inhabited

structure Request where
  reviewer : PersonId
  sentBy : Option PersonId      -- none: nobody sent it
  due : Time := 48
  remindedAt : Option Time := none
  replied : Bool := false
  disp : Option ReqDisposition := none
  deriving Repr, Inhabited

structure Suggestion where
  reviewer : PersonId
  dismissed : Bool := false
  deriving Repr, Inhabited

def ReqDisposition.name : ReqDisposition → String
  | .revised => "revised" | .explained => "explained" | .declined => "declined" | .noReply => "no reply"
  | .disputed => "disputed"

def grace : Time := 48

/-- Rule for `dispose` (AR5). -/
def mayDispose (req : Request) (d : ReqDisposition) (now : Time) : Bool :=
  match d with
  | .noReply => !req.replied && req.remindedAt.isSome && now > req.due + grace
  | _ => req.replied

def ReqDisposition.engaged : ReqDisposition → Bool
  | .revised | .explained => true
  | _ => false

def ReqDisposition.notEngaged : ReqDisposition → Bool
  | .declined | .noReply => true
  | _ => false

/-- Requests that reached the reviewer: a person sent them, unless the mutant
    lets a heuristic suggestion go out by itself. -/
def sentRequests (p : Params) (reqs : List Request) : List Request :=
  reqs.filter fun q => q.sentBy.isSome || p.heuristicSendsItself

/-- The engagement record (AR4): counts of dispositions only. -/
def engagement (p : Params) (reqs : List Request) (sugs : List Suggestion) (u : PersonId) : Nat × Nat :=
  let mine := (sentRequests p reqs).filter (·.reviewer == u)
  let engaged := (mine.filter fun q => q.disp.any (·.engaged)).length
  let notEng := (mine.filter fun q => q.disp.any (·.notEngaged)).length
  let dismissed := if p.dismissedSuggestionCounts then (sugs.filter fun s => s.reviewer == u && s.dismissed).length else 0
  (engaged, notEng + dismissed)

/-- May an Accountability case about a nominee open? A missing review always
    may; a quality case needs an earlier request under Q20's "yes" (AR6). -/
def caseMayOpen (p : Params) (r : Reading) (missingReview : Bool) (reqs : List Request) : Bool :=
  missingReview || r.q20 == .noRequestNeeded ||
    (sentRequests p reqs).any fun q => q.disp.any (·.notEngaged)

/-- The consequence a case may lead to, under Q11 (V4: always via two people). -/
def consequence (r : Reading) : String :=
  match r.q11 with
  | .rejectOwnPapers => "the nominating papers may be desk rejected, via the two-person path"
  | .recordOnly => "recorded for the PC chairs; no effect on papers"
  | .nothing => "no consequence"

end ReviewProcess
