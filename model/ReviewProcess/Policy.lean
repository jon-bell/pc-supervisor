import ReviewProcess.Model
import Std.Data.HashMap
/-
  The policy table of docs/concepts.md §3.9, as a function of the reading, and
  the trace search of §5 step 5 (L1, L2).

  Every action in the trace search is taken by a role, and `gated` refuses it
  unless the role's cell for the action's permission is granted. The rules of
  Model.lean then decide whether the action has any effect. So a trace is a
  run that both the policy and the rules allow.
-/
namespace ReviewProcess

inductive Role | processChair | pcChair | ac | juniorPcChair | pcMember | nominee | author | pcs | agent
  deriving DecidableEq, Repr, Inhabited

def Role.all : List Role :=
  [.processChair, .pcChair, .ac, .juniorPcChair, .pcMember, .nominee, .author, .pcs, .agent]

def Role.name : Role → String
  | .processChair => "Process chair" | .pcChair => "PC chair" | .ac => "AC (own paper)"
  | .juniorPcChair => "Junior PC chair" | .pcMember => "Senior / junior PC"
  | .nominee => "Accepted nominee" | .author => "Author" | .pcs => "PCS" | .agent => "Screening agent"

def Role.idx : Role → Nat
  | .processChair => 0 | .pcChair => 1 | .ac => 2 | .juniorPcChair => 3 | .pcMember => 4
  | .nominee => 5 | .author => 6 | .pcs => 7 | .agent => 8

inductive Perm
  | readHotcrp | writeHotcrp | applyWriteback | seeFindings | triage | secondOpinion | remove
  | classify | seeNominationPatterns | solvePlan | seeAffinity | seeIdentities | seeReviewText
  | coach | setCriteria | suggestRequest | sendRequest | seeEngagement | openCase | settleRuling
  | routeEngines | seeAcViews | sendOutside
  deriving DecidableEq, Repr, Inhabited

def Perm.all : List Perm :=
  [.readHotcrp, .writeHotcrp, .applyWriteback, .seeFindings, .triage, .secondOpinion, .remove,
   .classify, .seeNominationPatterns, .solvePlan, .seeAffinity, .seeIdentities, .seeReviewText,
   .coach, .setCriteria, .suggestRequest, .sendRequest, .seeEngagement, .openCase, .settleRuling,
   .routeEngines, .seeAcViews, .sendOutside]

def Perm.name : Perm → String
  | .readHotcrp => "Read HotCRP via the chair token" | .writeHotcrp => "Write to HotCRP directly"
  | .applyWriteback => "Confirm and apply a Writeback" | .seeFindings => "See the screening findings and summary"
  | .triage => "Keep or refer (triage)" | .secondOpinion => "Give a second opinion"
  | .remove => "Remove a paper (desk or early reject)"
  | .classify => "Accept a PC candidate and classify their tier"
  | .seeNominationPatterns => "See nomination patterns across an author's papers"
  | .solvePlan => "Solve and export a Plan" | .seeAffinity => "See affinity scores and plan reports"
  | .seeIdentities => "See reviewer identities" | .seeReviewText => "See review text"
  | .coach => "Coach a junior review (HotCRP comment)" | .setCriteria => "Set the review criteria"
  | .suggestRequest => "Suggest an accountability request"
  | .sendRequest => "Send a request, remind, and record its disposition"
  | .seeEngagement => "See a reviewer's engagement record"
  | .openCase => "Open or uphold an Accountability case" | .settleRuling => "Settle a ruling"
  | .routeEngines => "Route checks to engines; record qualifications"
  | .seeAcViews => "See per-AC consistency views" | .sendOutside => "Send anything outside the system"

/-- A cell: granted with a scope, denied (confirmed), not yet examined (denied),
    or set by a ruling on question `q`. -/
inductive Cell | y (scope : String := "") | n | dot | dag (q : String) (granted : Bool) (scope : String := "")
  deriving Repr, Inhabited

def Cell.granted : Cell → Bool
  | .y _ => true | .dag _ g _ => g | _ => false

def Cell.show : Cell → String
  | .y "" => "Y" | .y s => s!"Y ({s})" | .n => "N" | .dot => "."
  | .dag q g s => s!"†{q}: {if g then "Y" else "N"}{if s.isEmpty then "" else s!" ({s})"}"

/-- One row of §3.9, in `Role.all` order. -/
def row (r : Reading) : Perm → List Cell
  | .readHotcrp => [.y, .dot, .n, .n, .n, .n, .n, .y "read", .n]
  | .writeHotcrp => [.n, .y "in HotCRP", .y "in HotCRP, own papers", .y "comments", .y "own reviews",
                     .y "own reviews", .y "own paper", .n, .n]
  | .applyWriteback => [.y, .y, .n, .n, .n, .n, .n, .n, .n]
  | .seeFindings =>
    let reviewer : Cell := match r.q4 with
      | .never => .dag "Q4" false | .afterOwnReview => .dag "Q4" true "after own review" | .always => .dag "Q4" true
    [.y, .y, .y, .n, reviewer, reviewer, .n, .y, .n]
  | .triage => [.dot, .dot, .y, .n, .n, .n, .n, .n, .n]
  | .secondOpinion => [.dot, .dot, .n, .n, .y "requested", .n, .n, .n, .n]
  | .remove => [.dot, .y, .n, .n, .n, .n, .n, .n, .n]
  | .classify => [.dot, .y "in the sheet, any candidate", .y "in the sheet, own area", .n, .n, .n, .n, .n, .n]
  | .seeNominationPatterns => [.y, .y, .n, .n, .n, .n, .n, .y, .n]
  | .solvePlan => [.y, .dot, .n, .n, .n, .n, .n, .n, .n]
  | .seeAffinity => [.y, .y, .y "own papers", .n, .n, .n, .n, .y, .n]
  | .seeIdentities => [.y, .y, .y, .y "junior reviews", .dag "HotCRP setting" false,
                       .dag "HotCRP setting" false, .n, .y, .n]
  | .seeReviewText => [.y, .y, .y, .y "junior reviews", .dag "HotCRP setting" false,
                       .dag "HotCRP setting" false, .y "after release", .y "local, encrypted", .n]
  | .coach => [.dot, .dot, .y, .y, .n, .n, .n, .n, .n]
  | .setCriteria => [.dot, .y, .n, .n, .n, .n, .n, .n, .n]
  | .suggestRequest => [.dot, .dot, .y "own papers", .y "junior reviews", .n, .n, .n, .y "heuristics", .n]
  | .sendRequest => [.dot, .dot, .y "own papers", .y "junior reviews; escalations", .n, .n, .n, .n, .n]
  | .seeEngagement => [.dot, .dag "Q21" true, .dag "Q21" true "own requests", .dag "Q21" true "junior reviewers",
                       .y "own only", .y "own only", .n, .y "local, encrypted", .n]
  | .openCase => [.y "open", .y "uphold", .n, .n, .n, .n, .n, .y "open", .n]
  | .settleRuling => [.y "process", .y "policy", .n, .n, .n, .n, .n, .n, .n]
  | .routeEngines => [.y, .dot, .n, .n, .n, .n, .n, .n, .n]
  | .seeAcViews => [.y, .y, .n, .n, .n, .n, .n, .y, .n]
  | .sendOutside => [.n, .n, .n, .n, .n, .n, .n, .n, .n]

def policy (r : Reading) (role : Role) (pm : Perm) : Cell := (row r pm).getD role.idx .n

/-! ### Theorems about the table -/

/-- S6: the screening agent is granted nothing. It proposes through PCS only. -/
theorem s6_agent_granted_nothing (r : Reading) (pm : Perm) : (policy r .agent pm).granted = false := by
  cases pm <;> simp [policy, row, Role.idx, Cell.granted] <;> cases r.q4 <;> simp [Cell.granted]

/-- S1, S8: only a PC chair removes a paper. -/
theorem only_pc_chair_removes (r : Reading) (role : Role) (h : (policy r role .remove).granted = true) :
    role = .pcChair := by
  cases role <;> simp_all [policy, row, Role.idx, Cell.granted]

/-- AR2: only a person (an AC or the junior PC chair) sends a request or records its disposition. -/
theorem only_people_send_requests (r : Reading) (role : Role) (h : (policy r role .sendRequest).granted = true) :
    role = .ac ∨ role = .juniorPcChair := by
  cases role <;> simp_all [policy, row, Role.idx, Cell.granted]

/-- H2: only a chair confirms and applies a Writeback; PCS never writes HotCRP. -/
theorem only_chairs_apply (r : Reading) (role : Role) (h : (policy r role .applyWriteback).granted = true) :
    role = .processChair ∨ role = .pcChair := by
  cases role <;> simp_all [policy, row, Role.idx, Cell.granted]

/-- Who may classify: only a PC chair or an AC holds the policy cell. -/
theorem only_chair_or_ac_classify (r : Reading) (role : Role) (h : (policy r role .classify).granted = true) :
    role = .pcChair ∨ role = .ac := by
  cases role <;> simp_all [policy, row, Role.idx, Cell.granted]

theorem pcs_never_writes (r : Reading) : (policy r .pcs .writeHotcrp).granted = false ∧
    (policy r .pcs .applyWriteback).granted = false := by
  simp [policy, row, Role.idx, Cell.granted]

/-- Nobody sends anything outside the system. -/
theorem nothing_outside (r : Reading) (role : Role) : (policy r role .sendOutside).granted = false := by
  cases role <;> simp [policy, row, Role.idx, Cell.granted]

/-- C2: authors never see who gave an opinion or the screening findings. -/
theorem authors_see_no_findings (r : Reading) : (policy r .author .seeFindings).granted = false ∧
    (policy r .author .seeIdentities).granted = false := by
  cases h : r.q4 <;> simp [policy, row, Role.idx, Cell.granted, h]

/-- S12's reveal rule: under Q4 = never, no reviewer sees the screening record. -/
theorem q4_never_hides (r : Reading) (hq : r.q4 = .never) :
    (policy r .pcMember .seeFindings).granted = false ∧ (policy r .nominee .seeFindings).granted = false := by
  simp [policy, row, Role.idx, Cell.granted, hq]

/-! ### Gated steps and trace search -/

/-- A subsystem: actions, the permission each needs (`none` for the environment:
    time passing, the candidate's own consent), and the model's rule for each
    action. A rule returns `none` if the action is not allowed or has no effect. -/
structure Sys (σ α : Type) where
  name : String
  init : σ
  acts : List α
  perm : α → Option Perm
  rule : Params → Reading → σ → Option Role → α → Option σ
  showAct : α → String

def gated {σ α : Type} (sys : Sys σ α) (p : Params) (r : Reading) (s : σ) : Option Role × α → Option σ
  | (some role, a) => match sys.perm a with
    | some pm => if (policy r role pm).granted then sys.rule p r s (some role) a else none
    | none => none
  | (none, a) => match sys.perm a with
    | some _ => none
    | none => sys.rule p r s none a

/-- Every step of every trace is allowed by the policy: a role acts only where its cell is granted. -/
theorem gated_requires_policy {σ α : Type} (sys : Sys σ α) (p : Params) (r : Reading) (s s' : σ)
    (role : Role) (a : α) (h : gated sys p r s (some role, a) = some s') :
    ∃ pm, sys.perm a = some pm ∧ (policy r role pm).granted = true := by
  simp only [gated] at h
  split at h
  · rename_i pm hp
    split at h
    · exact ⟨pm, hp, by assumption⟩
    · cases h
  · cases h

/-- The environment never takes an action that needs a permission. -/
theorem env_has_no_perms {σ α : Type} (sys : Sys σ α) (p : Params) (r : Reading) (s s' : σ) (a : α)
    (h : gated sys p r s (none, a) = some s') : sys.perm a = none := by
  simp only [gated] at h
  split at h
  · cases h
  · assumption

structure Explored (σ α : Type) where
  states : Array σ
  parent : Array (Option (Nat × (Option Role × α)))
  /-- First effective use of each granted (role, permission) cell: (source state, action). -/
  firstUse : List ((Role × Perm) × (Nat × (Option Role × α)))
  truncated : Bool

/-- Breadth-first search over the gated steps, deduplicating states by their `Repr`. -/
def explore {σ α : Type} [Repr σ] [Inhabited σ] (sys : Sys σ α) (p : Params) (r : Reading) (maxStates : Nat := 50000) :
    Explored σ α := Id.run do
  let moves : List (Option Role × α) :=
    sys.acts.flatMap fun a => match sys.perm a with
      | some _ => Role.all.map fun role => (some role, a)
      | none => [(none, a)]
  let mut seen : Std.HashMap String Nat := {}
  let mut states : Array σ := #[sys.init]
  let mut parent : Array (Option (Nat × (Option Role × α))) := #[none]
  seen := seen.insert (toString (repr sys.init)) 0
  let mut firstUse : List ((Role × Perm) × (Nat × (Option Role × α))) := []
  let mut i := 0
  let mut truncated := false
  while i < states.size do
    let s := states[i]!
    for m in moves do
      match gated sys p r s m with
      | none => pure ()
      | some s' =>
        match m.1, sys.perm m.2 with
        | some role, some pm =>
          if !(firstUse.any fun (k, _) => k == (role, pm)) then firstUse := firstUse ++ [((role, pm), (i, m))]
        | _, _ => pure ()
        let key := toString (repr s')
        if !seen.contains key then
          if states.size ≥ maxStates then truncated := true
          else
            seen := seen.insert key states.size
            states := states.push s'
            parent := parent.push (some (i, m))
    i := i + 1
  return { states, parent, firstUse, truncated }

def Explored.traceTo {σ α : Type} (e : Explored σ α) (i : Nat) : List (Option Role × α) := Id.run do
  let mut out := []
  let mut j := i
  for _ in [0:e.states.size] do
    match e.parent[j]! with
    | none => break
    | some (k, m) => out := m :: out; j := k
  return out

def showMove {σ α : Type} (sys : Sys σ α) : Option Role × α → String
  | (some role, a) => s!"{role.name}: {sys.showAct a}"
  | (none, a) => sys.showAct a

def showTrace {σ α : Type} (sys : Sys σ α) (t : List (Option Role × α)) : String :=
  " → ".intercalate (t.map (showMove sys))

/-- The shortest trace to a state satisfying `goal`, if any. -/
def Explored.find {σ α : Type} [Inhabited σ] (e : Explored σ α) (goal : σ → Bool) : Option (List (Option Role × α)) :=
  (List.range e.states.size).find? (fun i => goal e.states[i]!) |>.map e.traceTo

/-! ### Subsystem 1: desk reject -/

structure DeskSt where
  ref : Referral := { ac := 1, ground := .format }
  referred : Bool := false
  disp : Disposition := .inReview
  deriving Repr, Inhabited

inductive DeskAct
  | refer (g : Ground) | opinion (o : Opinion) | offerRemedy | warn | cure | tick | advance | remove
  deriving Repr

def DeskAct.show : DeskAct → String
  | .refer g => s!"refer on {g.name}" | .opinion o => s!"agree (person {o.who}{if o.isAc then ", an AC" else ""}, {match o.tier with | some .senior => "senior" | some .junior => "junior" | none => "?"})"
  | .offerRemedy => "offer the fix window" | .warn => "warn the authors" | .cure => "fix the violation"
  | .tick => "time passes" | .advance => "the process moves to the next stage" | .remove => "remove the paper"

def Stage.next : Stage → Option Stage
  | .screening => some .assigned | .assigned => some .inReview | .inReview => some .released | .released => none

def searchOpinions : List Opinion :=
  [{ who := 2, isAc := true, tier := some .senior }, { who := 3, tier := some .senior }, { who := 4, tier := some .junior }]

def insertOpinion (o : Opinion) : List Opinion → List Opinion
  | [] => [o]
  | x :: xs => if o.who < x.who then o :: x :: xs else x :: insertOpinion o xs

def deskRule (p : Params) (r : Reading) (s : DeskSt) (who : Option Role) : DeskAct → Option DeskSt
  | .refer g => if !s.referred && s.disp == .inReview && who == some .ac
      then some { s with referred := true, ref := { s.ref with ground := g } } else none
  | .opinion o => if s.referred && s.disp == .inReview && !(s.ref.opinions.any (·.who == o.who))
      then some { s with ref := { s.ref with opinions := insertOpinion o s.ref.opinions } } else none
  | .offerRemedy => if s.referred && s.ref.ground == .anonymity && r.q1 == .fixWindow && !s.ref.remedyOffered
      then some { s with ref := { s.ref with remedyOffered := true, remedyDue := s.ref.now + 72 } } else none
  | .warn => if s.referred && s.ref.ground == .nominationNoncompliance && !s.ref.warned
      then some { s with ref := { s.ref with warned := true } } else none
  | .cure => if who == some .author && s.ref.remedyOffered && !s.ref.cured && s.ref.now ≤ s.ref.remedyDue
      then some { s with ref := { s.ref with cured := true } } else none
  | .tick => if s.ref.now < 200 then some { s with ref := { s.ref with now := s.ref.now + 100 } } else none
  | .advance => (s.ref.stage.next).map fun st => { s with ref := { s.ref with stage := st } }
  | .remove =>
    let s' := drStep p r { ref := s.ref, disp := s.disp } (.remove (who == some .pcChair))
    if s.referred && s'.disp != s.disp then some { s with disp := s'.disp } else none

def deskSys : Sys DeskSt DeskAct where
  name := "desk reject"
  init := {}
  acts := ([Ground.format, .scope, .anonymity, .fabricatedReference, .misusedCitation, .noContribution,
            .nominationNoncompliance, .promptInjection].map DeskAct.refer) ++ searchOpinions.map DeskAct.opinion ++
          [.offerRemedy, .warn, .cure, .tick, .advance, .remove]
  perm
    | .refer _ => some .triage | .opinion _ => some .secondOpinion
    | .offerRemedy | .warn => some .applyWriteback | .cure => some .writeHotcrp
    | .tick | .advance => none | .remove => some .remove
  rule := deskRule
  showAct := DeskAct.show

/-! ### Subsystem 2: early reject -/

structure EarlySt where
  scores : List Score := []
  windowClosed : Bool := false
  bumped : Bool := false
  removed : Bool := false
  deriving Repr, Inhabited

inductive EarlyAct | review (s : Score) | bump | closeWindow | remove
  deriving Repr

def EarlyAct.show : EarlyAct → String
  | .review s => s!"submit an initial review ({s.name})" | .bump => "bump the score"
  | .closeWindow => "the last-word window closes" | .remove => "early reject"

def insertScore (x : Score) : List Score → List Score
  | [] => [x]
  | y :: ys => if x.rank ≤ y.rank then x :: y :: ys else y :: insertScore x ys

def earlyRule (p : Params) (r : Reading) (s : EarlySt) (who : Option Role) : EarlyAct → Option EarlySt
  | .review x => if (who == some .pcMember || who == some .nominee) && s.scores.length < 3 && !s.removed
      then some { s with scores := insertScore x s.scores } else none
  | .bump => if who == some .pcMember && r.q16 == .bumpWindow && s.scores.length == 3 && !s.windowClosed && !s.bumped
      then some { s with bumped := true } else none
  | .closeWindow => if r.q16 == .bumpWindow && s.scores.length == 3 && !s.windowClosed
      then some { s with windowClosed := true } else none
  | .remove => if who == some .pcChair && !s.removed && s.scores.length == 3 &&
        mayEarlyReject p r { scores := s.scores, windowClosed := s.windowClosed, bumped := s.bumped }
      then some { s with removed := true } else none

def earlySys : Sys EarlySt EarlyAct where
  name := "early reject"
  init := {}
  acts := [.review .reject, .review .weakReject, .review .borderline, .review .accept, .bump, .closeWindow, .remove]
  perm | .review _ | .bump => some .writeHotcrp | .closeWindow => none | .remove => some .remove
  rule := earlyRule
  showAct := EarlyAct.show

/-! ### Subsystem 3: accountability requests -/

structure AccSt where
  criteria : Bool := false
  suggested : Bool := false
  dismissed : Bool := false
  coached : Bool := false
  req : Option Request := none
  now : Time := 0
  caseOpen : Bool := false
  upheld : Bool := false
  deriving Repr, Inhabited

inductive AccAct
  | setCriteria | suggest | dismiss | coach | send | remind | reply | dispose (d : ReqDisposition)
  | tick | openCase | uphold
  deriving Repr

def AccAct.show : AccAct → String
  | .setCriteria => "set the review criteria" | .suggest => "suggest a request" | .dismiss => "dismiss the suggestion"
  | .coach => "coach the review" | .send => "send a request citing the criteria" | .remind => "send the reminder"
  | .reply => "the reviewer replies" | .dispose d => s!"record the disposition ({d.name})"
  | .tick => "time passes" | .openCase => "open a quality case" | .uphold => "uphold the case"

def accRule (p : Params) (r : Reading) (s : AccSt) (who : Option Role) : AccAct → Option AccSt
  | .setCriteria => if !s.criteria then some { s with criteria := true } else none
  | .suggest => if !s.suggested then some { s with suggested := true } else none
  | .dismiss => if s.suggested && !s.dismissed && s.req.isNone then some { s with dismissed := true } else none
  | .coach => if !s.coached then some { s with coached := true } else none
  | .send => if s.criteria && s.req.isNone
      then some { s with req := some { reviewer := 7, sentBy := some (if who == some .ac then 1 else 5), due := s.now + 48 } }
      else none
  | .remind => match s.req with
    | some q => if !q.replied && q.remindedAt.isNone && s.now > q.due then some { s with req := some { q with remindedAt := some s.now } } else none
    | none => none
  | .reply => match s.req with
    | some q => if (who == some .nominee || who == some .pcMember) && !q.replied && q.disp.isNone
        then some { s with req := some { q with replied := true } } else none
    | none => none
  | .dispose d => match s.req with
    | some q => if q.disp.isNone && mayDispose r.venue.accGraceH q d s.now then some { s with req := some { q with disp := some d } } else none
    | none => none
  | .tick => if s.now < 200 then some { s with now := s.now + 50 } else none
  | .openCase => if (who == some .pcs || who == some .processChair) && !s.caseOpen &&
        caseMayOpen p r false s.req.toList then some { s with caseOpen := true } else none
  | .uphold => if who == some .pcChair && s.caseOpen && !s.upheld then some { s with upheld := true } else none

def accSys : Sys AccSt AccAct where
  name := "accountability requests"
  init := {}
  acts := [.setCriteria, .suggest, .dismiss, .coach, .send, .remind, .reply,
           .dispose .revised, .dispose .explained, .dispose .declined, .dispose .noReply, .tick, .openCase, .uphold]
  perm
    | .setCriteria => some .setCriteria | .suggest | .dismiss => some .suggestRequest | .coach => some .coach
    | .send | .remind | .dispose _ => some .sendRequest | .reply => some .writeHotcrp | .tick => none
    | .openCase | .uphold => some .openCase
  rule := accRule
  showAct := AccAct.show

/-! ### Subsystem 4: appointing a nominee, and the plan reaching HotCRP -/

structure PcSt where
  accepted : Bool := false
  tier : Option Tier := none
  consented : Bool := false
  solved : Bool := false
  inPlan : Bool := false
  synced : Bool := false
  dryRunOk : Bool := false
  confirmed : Bool := false
  applied : Bool := false
  deriving Repr, Inhabited

inductive PcAct | classify (t : Tier) | consent | sync | solve | dryRun | confirm | apply
  deriving Repr

def PcAct.show : PcAct → String
  | .classify t => s!"accept the nominee and classify them {match t with | .senior => "senior" | .junior => "junior"}"
  | .consent => "the nominee consents" | .sync => "sync HotCRP" | .solve => "solve the plan"
  | .dryRun => "dry-run the assignment upload" | .confirm => "confirm the upload" | .apply => "apply the upload"

def pcRule (p : Params) (_ : Reading) (s : PcSt) (_ : Option Role) : PcAct → Option PcSt
  | .classify t => if !s.accepted then some { s with accepted := true, tier := some t } else none
  | .consent => if !s.consented then some { s with consented := true } else none
  | .sync => if !s.synced then some { s with synced := true } else none
  | .solve => if s.synced && !s.solved then
      some { s with solved := true,
                    inPlan := eligible p { who := 9, tier := s.tier, nominee := true, accepted := s.accepted,
                                           consented := s.consented } {} }
      else none
  | .dryRun => if s.solved && !s.dryRunOk then some { s with dryRunOk := true } else none
  | .confirm => if s.solved && s.dryRunOk && !s.confirmed then some { s with confirmed := true } else none
  | .apply => if !s.applied && s.solved && mayApply p { dryRunOk := s.dryRunOk, confirmed := s.confirmed }
      then some { s with applied := true } else none

def pcSys : Sys PcSt PcAct where
  name := "appointment and assignment"
  init := {}
  acts := [.classify .senior, .classify .junior, .consent, .sync, .solve, .dryRun, .confirm, .apply]
  perm
    | .classify _ => some .classify | .consent => none | .sync | .dryRun => some .readHotcrp
    | .solve => some .solvePlan | .confirm | .apply => some .applyWriteback
  rule := pcRule
  showAct := PcAct.show

/-! ### L1 and L2 -/

structure Goal where
  name : String
  /-- Whether the reading admits it. A goal the reading does not admit must be unreachable. -/
  admitted : Bool
  found : Option String

structure SearchResult where
  sys : String
  states : Nat
  truncated : Bool
  goals : List Goal
  uses : List ((Role × Perm) × String)

def runSearch {σ α : Type} [Repr σ] [Inhabited σ] (sys : Sys σ α) (p : Params) (r : Reading)
    (goals : List (String × Bool × (σ → Bool))) : SearchResult :=
  let e := explore sys p r
  { sys := sys.name, states := e.states.size, truncated := e.truncated,
    goals := goals.map fun (n, adm, g) => { name := n, admitted := adm, found := (e.find g).map (showTrace sys) },
    uses := e.firstUse.map fun (k, (i, m)) => (k, showTrace sys (e.traceTo i ++ [m])) }

def groundAdmittedBy (r : Reading) : Ground → Bool
  | .fabricatedReference => r.q6 == .grounds
  | .nominationNoncompliance => r.q10 != .warnOnly
  | _ => true

def searchAll (p : Params) (r : Reading) : List SearchResult :=
  let grounds := [Ground.format, .scope, .anonymity, .fabricatedReference, .misusedCitation, .noContribution,
                  .nominationNoncompliance, .promptInjection]
  [ runSearch deskSys p r (grounds.map fun g =>
      (s!"desk reject on {g.name}", groundAdmittedBy r g, fun (s : DeskSt) => s.disp == .removed g)),
    runSearch earlySys p r [("early reject", true, (·.removed))],
    runSearch accSys p r
      [("a reviewer recorded as engaged", true, fun s => s.req.any (·.disp.any (·.engaged))),
       ("a reviewer recorded as not engaged", true, fun s => s.req.any (·.disp.any (·.notEngaged))),
       ("a quality case upheld", true, (·.upheld))],
    runSearch pcSys p r [("a nominee appointed and assigned in HotCRP", true, fun s => s.applied && s.inPlan)] ]

/-- Cells that are granted but that no modeled action needs: visibility and
    configuration rights, enforced by views and checked by the information-flow
    properties rather than by traces. -/
def modeledPerms : List Perm :=
  [.readHotcrp, .writeHotcrp, .applyWriteback, .triage, .secondOpinion, .remove, .classify, .solvePlan,
   .coach, .setCriteria, .suggestRequest, .sendRequest, .openCase]

end ReviewProcess
