import ReviewProcess.Policy
import ReviewProcess.Query
import ReviewProcess.Validate
import Lean.Data.Json
open Lean
/-
  Witness traces and evidence checking (PLAN §A3, §A5, §A6).

  This file gives the desk-reject subsystem a JSON face: each action as a key with parameters,
  each state as the observations the bindings read, the traces the explorer finds, and the replay
  that `lake exe check-evidence` runs over an evidence record. Nothing here changes a rule.
-/
namespace ReviewProcess

def roleKey : Role → String
  | .processChair => "process-chair" | .pcChair => "pc-chair" | .ac => "ac" | .juniorPcChair => "junior-pc-chair"
  | .pcMember => "pc-member" | .nominee => "nominee" | .author => "author" | .pcs => "pcs" | .agent => "agent"

def roleOfKey? (k : String) : Option Role := Role.all.find? (roleKey · == k)

def groundKey (g : Ground) : String := ((groundKeys.find? (·.2 == g)).map (·.1)).getD "?"
def stageKey (s : Stage) : String := ((stageKeys.find? (·.2 == s)).map (·.1)).getD "?"
def tierKey : Option Tier → Json
  | some .senior => "senior" | some .junior => "junior" | none => Json.null

/-- An action as `(key, parameters)`: the vocabulary the bindings are written against. -/
abbrev ActDesc := String × List (String × Json)

def deskDesc : DeskAct → ActDesc
  | .refer g => ("refer", [("ground", groundKey g)])
  | .opinion o => ("opinion", [("who", (o.who : Nat)), ("isAc", o.isAc), ("tier", tierKey o.tier)])
  | .offerRemedy => ("offer-remedy", []) | .warn => ("warn", []) | .cure => ("cure", [])
  | .tick => ("tick", []) | .advance => ("advance", []) | .remove => ("remove", [])

def earlyDesc : EarlyAct → ActDesc
  | .review s => ("review", [("score", ((scoreKeys.find? (·.2 == s)).map (·.1)).getD "?")])
  | .bump => ("bump", []) | .closeWindow => ("close-window", []) | .remove => ("remove", [])

def accDesc : AccAct → ActDesc
  | .setCriteria => ("set-criteria", []) | .suggest => ("suggest", []) | .dismiss => ("dismiss", [])
  | .coach => ("coach", []) | .send => ("send", []) | .remind => ("remind", []) | .reply => ("reply", [])
  | .dispose d => ("dispose", [("disposition", ((dispKeys.find? (·.2 == d)).map (·.1)).getD "?")])
  | .tick => ("tick", []) | .openCase => ("open-case", []) | .uphold => ("uphold", [])

def pcDesc : PcAct → ActDesc
  | .classify t => ("classify", [("tier", tierKey (some t))])
  | .consent => ("consent", []) | .sync => ("sync", []) | .solve => ("solve", []) | .dryRun => ("dry-run", [])
  | .confirm => ("confirm", []) | .apply => ("apply", [])

def descJson (d : ActDesc) : Json := Json.mkObj [("key", d.1), ("params", Json.mkObj d.2)]

/-- The observations of the desk-reject subsystem, with the readers that must each produce them. -/
def deskObservations : List (String × String × List String) :=
  [("referred", "bool", ["hotcrp", "state"]), ("ground", "string?", ["hotcrp", "state"]),
   ("opinions", "int-list", ["hotcrp", "state"]), ("stage", "string", ["state"]),
   ("remedy-due", "int?", ["state"]), ("warned", "bool", ["state"]), ("cured", "bool", ["hotcrp"]),
   ("now", "int", ["clock", "state"]), ("disposition", "string", ["hotcrp", "state"]),
   ("role-sees-pc-member", "bool", ["role"]), ("role-sees-nominee", "bool", ["role"])]

def deskObserve (r : Reading) (s : DeskSt) : Json :=
  let seesText (role : Role) : Bool := (policy r role .seeReviewText).granted
  Json.mkObj
    [("referred", s.referred), ("ground", if s.referred then Json.str (groundKey s.ref.ground) else Json.null),
     ("opinions", Json.arr (s.ref.opinions.toArray.map fun o => Json.num (o.who : Nat))),
     ("stage", stageKey s.ref.stage),
     ("remedy-due", if s.ref.remedyOffered then Json.num s.ref.remedyDue else Json.null),
     ("warned", s.ref.warned), ("cured", s.ref.cured), ("now", Json.num s.ref.now),
     ("disposition", match s.disp with | .inReview => "in-review" | .removed g => s!"removed:{groundKey g}"),
     ("role-sees-pc-member", seesText .pcMember), ("role-sees-nominee", seesText .nominee)]

def parseTier? : Json → Option Tier
  | .str "senior" => some .senior | .str "junior" => some .junior | _ => none

def deskActOfJson (j : Json) : Except String DeskAct := do
  let key ← j.getObjValAs? String "key"
  let ps := (j.getObjVal? "params").toOption.getD Json.null
  match key with
  | "refer" =>
    let g ← ps.getObjValAs? String "ground"
    .ok (.refer (← lookupKey groundKeys g))
  | "opinion" =>
    let who : Nat ← ps.getObjValAs? Nat "who"
    let isAc ← ps.getObjValAs? Bool "isAc"
    let tier := parseTier? ((ps.getObjVal? "tier").toOption.getD Json.null)
    .ok (.opinion { who, isAc, tier })
  | "offer-remedy" => .ok .offerRemedy | "warn" => .ok .warn | "cure" => .ok .cure
  | "tick" => .ok .tick | "advance" => .ok .advance | "remove" => .ok .remove
  | k => .error s!"unknown desk action {k}"

def readingJson (r : Reading) : Json :=
  Json.mkObj <| QId.all.map fun q => (q.code, Json.str ((q.labels.getD (r.get q) ("?", "?")).1))

structure Move where
  role : Option Role
  act : DeskAct

def stepJson (r : Reading) (after : DeskSt) (m : Move) (effective : Bool) : Json :=
  Json.mkObj [("role", match m.role with | some ro => Json.str (roleKey ro) | none => Json.null),
    ("action", descJson (deskDesc m.act)), ("label", showMove deskSys (m.role, m.act)),
    ("effective", effective), ("expect", deskObserve r after)]

/-- Replay moves through the gated step function (the policy, then the rules), recording each
    step's outcome. A refused move leaves the state unchanged. -/
def replayDesk (p : Params) (r : Reading) (ms : List Move) : List (Json × DeskSt) × DeskSt := Id.run do
  let mut s : DeskSt := deskSys.init
  let mut out := []
  for m in ms do
    match gated deskSys p r s (m.role, m.act) with
    | some s' => out := out ++ [(stepJson r s' m true, s')]; s := s'
    | none => out := out ++ [(stepJson r s m false, s)]
  return (out, s)

def moveOf (m : Option Role × DeskAct) : Move := { role := m.1, act := m.2 }

/-! ### Verdicts -/

/-- What a trace is evidence for, as a predicate on the model's replay of it. -/
inductive Verdict
  | removed (g : Ground)
  | earlyRemoved
  | cell (role : Role) (perm : Perm)
  | refused
  | denied

def permOfKey? (k : String) : Option Perm :=
  Perm.all.find? fun pm =>
    let s := (toString (repr pm)).replace "ReviewProcess.Perm." ""
    String.join (s.toList.map fun ch => if ch.isUpper then "-" ++ (toString ch.toLower) else toString ch) == k

def permKey (p : Perm) : String :=
  let s := (toString (repr p)).replace "ReviewProcess.Perm." ""
  String.join (s.toList.map fun ch => if ch.isUpper then "-" ++ (toString ch.toLower) else toString ch)

def Verdict.json : Verdict → Json
  | .removed g => Json.mkObj [("kind", "removed"), ("ground", groundKey g)]
  | .earlyRemoved => Json.mkObj [("kind", "early-removed")]
  | .cell ro pm => Json.mkObj [("kind", "cell"), ("role", roleKey ro), ("perm", permKey pm)]
  | .refused => Json.mkObj [("kind", "refused")]
  | .denied => Json.mkObj [("kind", "denied")]

/-- Does the verdict hold of this replay? `outcomes` are the model's effective flags per step. -/
def Verdict.holds (v : Verdict) (ms : List Move) (outcomes : List Bool) (final : DeskSt) : Bool :=
  match v with
  | .removed g => final.disp == .removed g
  | .earlyRemoved => false
  | .cell ro pm => match ms.getLast?, outcomes.getLast? with
      | some m, some true => m.role == some ro && deskSys.perm m.act == some pm
      | _, _ => false
  | .refused => outcomes.getLast? == some false
  | .denied => outcomes.getLast? == some false

def verdictOfJson (j : Json) : Except String Verdict := do
  match ← j.getObjValAs? String "kind" with
  | "removed" => .ok (.removed (← lookupKey groundKeys (← j.getObjValAs? String "ground")))
  | "cell" =>
    let ro := roleOfKey? (← j.getObjValAs? String "role")
    let pm := permOfKey? (← j.getObjValAs? String "perm")
    match ro, pm with
    | some ro, some pm => .ok (.cell ro pm)
    | _, _ => .error "unknown role or permission in a cell verdict"
  | "early-removed" => .ok .earlyRemoved
  | "refused" => .ok .refused
  | "denied" => .ok .denied
  | k => .error s!"unknown verdict kind {k}"

/-! ### Traces -/

structure Trace where
  id : String
  family : String
  claims : List String
  reading : Reading
  moves : List Move
  verdict : Verdict

def Trace.json (t : Trace) : Json :=
  let (steps, final) := replayDesk {} t.reading t.moves
  let outcomes := steps.map fun (j, _) => ((j.getObjValAs? Bool "effective").toOption.getD false)
  Json.mkObj [("id", t.id), ("subsystem", deskSys.name), ("family", t.family),
    ("claims", Json.arr (t.claims.toArray.map Json.str)),
    ("reading", readingJson t.reading), ("steps", Json.arr (steps.toArray.map (·.1))),
    ("verdict", Json.mkObj [("claimed", t.verdict.json), ("holds", t.verdict.holds t.moves outcomes final)]),
    ("final", deskObserve t.reading final)]

private def slug (s : String) : String := String.map (fun c => if c.isAlphanum then c else '-') s

/-- Witness traces for the desk-reject subsystem under a reading: one per admitted ground (L2)
    and one per granted cell's first use (L1), plus hand-written refusals. -/
def deskTraces (tag : String) (r : Reading) : List Trace :=
  let e := explore deskSys {} r
  let grounds := [Ground.format, .scope, .anonymity, .fabricatedReference, .misusedCitation, .noContribution,
                  .nominationNoncompliance, .promptInjection]
  let goals := grounds.filterMap fun g =>
    (e.find fun (s : DeskSt) => s.disp == .removed g).map fun tr =>
      { id := s!"desk/{tag}/remove-{groundKey g}", family := "T5", claims := ["prop:L2"], reading := r,
        moves := tr.map moveOf, verdict := .removed g : Trace }
  let uses := e.firstUse.map fun ((ro, pm), (i, m)) =>
    { id := s!"desk/{tag}/cell-{roleKey ro}-{permKey pm}", family := "T5",
      claims := [s!"cell:{roleKey ro}/{permKey pm}"], reading := r,
      moves := (e.traceTo i ++ [m]).map moveOf, verdict := .cell ro pm : Trace }
  let silence : Trace :=
    { id := s!"desk/{tag}/silence-does-not-remove", family := "T5", claims := ["prop:S8"], reading := r,
      moves := [⟨some .ac, .refer .format⟩, ⟨none, .tick⟩, ⟨some .pcChair, .remove⟩], verdict := .refused }
  let junior : Trace :=
    { id := s!"desk/{tag}/junior-alone-does-not-remove", family := "T5", claims := ["rule:may-remove"], reading := r,
      moves := [⟨some .ac, .refer .format⟩, ⟨some .pcMember, .opinion { who := 4, tier := some .junior }⟩,
                ⟨some .pcChair, .remove⟩], verdict := .refused }
  let authorRefer : Trace :=
    { id := s!"desk/{tag}/author-cannot-refer", family := "T6", claims := ["cell:author/triage"], reading := r,
      moves := [⟨some .author, .refer .format⟩], verdict := .denied }
  let acRemove : Trace :=
    { id := s!"desk/{tag}/ac-cannot-remove", family := "T6", claims := ["cell:ac/remove"], reading := r,
      moves := [⟨some .ac, .refer .format⟩, ⟨some .pcMember, .opinion { who := 2, isAc := true, tier := some .senior }⟩,
                ⟨some .ac, .remove⟩], verdict := .denied }
  goals ++ uses ++ [silence, junior, authorRefer, acRemove]

/-- A canonical string for an observation: keys sorted, values compressed. The report matches evidence by it. -/
def obsKey (j : Json) : String :=
  match j with
  | .obj kvs => "|".intercalate (kvs.toList.map fun (k, v) => s!"{k}={v.compress}")
  | _ => j.compress

/-- A canonical string for a move: role, action key, parameters sorted. -/
def moveKey (role : Option Role) (d : ActDesc) : String :=
  let sorted := d.2.toArray.qsort (fun a b => a.1 < b.1) |>.toList
  let pstr := ",".intercalate (sorted.map fun (k, v) => s!"{k}={match v with | Json.str t => t | _ => v.compress}")
  s!"{match role with | some ro => roleKey ro | none => "env"}|{d.1}|{pstr}"

/-- Every effective transition of the desk-reject subsystem under a reading, as indices into a state table
    and a move table: the assurance report's transition coverage is the share evidence records take. -/
def deskTransitions (r : Reading) : List String × List (Nat × String × Nat) := Id.run do
  let e := explore deskSys {} r
  let moves : List (Option Role × DeskAct) :=
    deskSys.acts.flatMap fun a => match deskSys.perm a with
      | some _ => Role.all.map fun role => (some role, a)
      | none => [(none, a)]
  let keys := e.states.toList.map fun s => obsKey (deskObserve r s)
  let idx : Std.HashMap String Nat := keys.zipIdx.foldl (fun m (k, i) => m.insertIfNew k i) {}
  let mut out := []
  for (s, i) in e.states.toList.zipIdx do
    for m in moves do
      match gated deskSys {} r s m with
      | some s' => out := out ++ [(i, moveKey m.1 (deskDesc m.2), idx.getD (obsKey (deskObserve r s')) 0)]
      | none => pure ()
  return (keys, out)


/-! ### Early reject -/

def scoreKey (s : Score) : String := ((scoreKeys.find? (·.2 == s)).map (·.1)).getD "?"

/-- The observations of the early-reject subsystem, with the readers that must each produce them.
    `scores` are the initial reviews (a bump changes a review, not the window-open snapshot). -/
def earlyObservations : List (String × String × List String) :=
  [("reviews", "int", ["hotcrp", "state"]), ("scores", "string-list", ["state"]), ("candidate", "bool", ["state"]),
   ("bumped", "bool", ["state"]), ("window-closed", "bool", ["state"]), ("may-early-reject", "bool", ["state"]),
   ("disposition", "string", ["hotcrp", "state"])]

def earlyObserve (r : Reading) (s : EarlySt) : Json :=
  Json.mkObj
    [("reviews", Json.num s.scores.length), ("scores", Json.arr (s.scores.toArray.map fun x => Json.str (scoreKey x))),
     ("candidate", s.scores.length == 3 && s.scores.all (negative r)), ("bumped", s.bumped),
     ("window-closed", s.windowClosed),
     ("may-early-reject", mayEarlyReject {} r { scores := s.scores, windowClosed := s.windowClosed, bumped := s.bumped }),
     ("disposition", if s.removed then "early-rejected" else "in-review")]

def earlyActOfJson (j : Json) : Except String EarlyAct := do
  let key ← j.getObjValAs? String "key"
  let ps := (j.getObjVal? "params").toOption.getD Json.null
  match key with
  | "review" => .ok (.review (← lookupKey scoreKeys (← ps.getObjValAs? String "score")))
  | "bump" => .ok .bump | "close-window" => .ok .closeWindow | "remove" => .ok .remove
  | k => .error s!"unknown early-reject action {k}"

structure EMove where
  role : Option Role
  act : EarlyAct

def estepJson (r : Reading) (after : EarlySt) (m : EMove) (effective : Bool) : Json :=
  Json.mkObj [("role", match m.role with | some ro => Json.str (roleKey ro) | none => Json.null),
    ("action", descJson (earlyDesc m.act)), ("label", showMove earlySys (m.role, m.act)),
    ("effective", effective), ("expect", earlyObserve r after)]

def replayEarly (p : Params) (r : Reading) (ms : List EMove) : List (Json × EarlySt) × EarlySt := Id.run do
  let mut s : EarlySt := earlySys.init
  let mut out := []
  for m in ms do
    match gated earlySys p r s (m.role, m.act) with
    | some s' => out := out ++ [(estepJson r s' m true, s')]; s := s'
    | none => out := out ++ [(estepJson r s m false, s)]
  return (out, s)

def Verdict.holdsEarly (v : Verdict) (ms : List EMove) (outcomes : List Bool) (final : EarlySt) : Bool :=
  match v with
  | .earlyRemoved => final.removed
  | .cell ro pm => match ms.getLast?, outcomes.getLast? with
      | some m, some true => m.role == some ro && earlySys.perm m.act == some pm
      | _, _ => false
  | .refused | .denied => outcomes.getLast? == some false
  | .removed _ => false

structure ETrace where
  id : String
  family : String
  claims : List String
  reading : Reading
  moves : List EMove
  verdict : Verdict

def ETrace.json (t : ETrace) : Json :=
  let (steps, final) := replayEarly {} t.reading t.moves
  let outcomes := steps.map fun (j, _) => ((j.getObjValAs? Bool "effective").toOption.getD false)
  Json.mkObj [("id", t.id), ("subsystem", earlySys.name), ("family", t.family),
    ("claims", Json.arr (t.claims.toArray.map Json.str)),
    ("reading", readingJson t.reading), ("steps", Json.arr (steps.toArray.map (·.1))),
    ("verdict", Json.mkObj [("claimed", t.verdict.json), ("holds", t.verdict.holdsEarly t.moves outcomes final)]),
    ("final", earlyObserve t.reading final)]

def emoveOf (m : Option Role × EarlyAct) : EMove := { role := m.1, act := m.2 }

/-- Witness traces for the early-reject subsystem under a reading: a path to an early reject (L2), the
    window's refusals (E-1: no removal before the window closes, after a bump, or with a non-negative
    review), the reading's own boundary (Q15), and, with `cells`, the first use of each granted cell (L1). -/
def earlyTraces (tag : String) (r : Reading) (cells : Bool) : List ETrace :=
  let e := explore earlySys {} r
  let pc (a : EarlyAct) : EMove := ⟨some .pcChair, a⟩
  let mem (a : EarlyAct) : EMove := ⟨some .pcMember, a⟩
  let three (a b c : Score) : List EMove := [mem (.review a), mem (.review b), mem (.review c)]
  let window := r.q16 == .bumpWindow
  let mk (id : String) (claims : List String) (moves : List EMove) (v : Verdict) : ETrace :=
    { id := s!"early/{tag}/{id}", family := "T5", claims := claims, reading := r, moves := moves, verdict := v }
  let removed := (e.find fun (s : EarlySt) => s.removed).map fun tr =>
    mk "early-reject" ["prop:L2", "prop:E-1"] (tr.map emoveOf) .earlyRemoved
  let uses := if cells then e.firstUse.map fun ((ro, pm), (i, m)) =>
      mk s!"cell-{roleKey ro}-{permKey pm}" [s!"cell:{roleKey ro}/{permKey pm}"] ((e.traceTo i ++ [m]).map emoveOf) (.cell ro pm)
    else []
  let close : List EMove := if window then [⟨none, .closeWindow⟩] else []
  let bounded (id : String) (a b c : Score) : ETrace :=
    mk id ["prop:E-1", "card:R3", "card:R4"] (three a b c ++ close ++ [pc .remove])
      (if negative r a && negative r b && negative r c then .earlyRemoved else .refused)
  let always : List ETrace :=
    [mk "positive-review-blocks" ["prop:E-1"] (three .reject .reject .accept ++ close ++ [pc .remove]) .refused,
     bounded "weak-reject-boundary" .reject .reject .weakReject,
     bounded "borderline-boundary" .reject .weakReject .borderline,
     mk "author-cannot-remove" ["cell:author/remove"] (three .reject .reject .reject ++ close ++ [⟨some .author, .remove⟩]) .denied,
     mk "pc-member-cannot-remove" ["cell:pc-member/remove"] (three .reject .reject .reject ++ close ++ [mem .remove]) .denied]
  let windowed : List ETrace :=
    if window then
      [mk "remove-before-close-refused" ["prop:E-1", "card:R2"] (three .reject .reject .reject ++ [pc .remove]) .refused,
       mk "bump-blocks-removal" ["prop:E-1", "card:R1"] (three .reject .reject .reject ++ [mem .bump, ⟨none, .closeWindow⟩, pc .remove]) .refused]
    else
      [mk "no-window-removes-at-once" ["prop:E-1"] (three .reject .reject .reject ++ [pc .remove]) .earlyRemoved,
       mk "no-window-no-bump" ["prop:E-1"] (three .reject .reject .reject ++ [mem .bump]) .refused]
  removed.toList ++ uses ++ windowed ++ always

/-! ### Binding mutants (PLAN §A8) -/

/-- Faults in the test code that would make a broken system look correct. `milestone` is where
    the binding exists; a control for each mutant must catch it before that milestone is done. -/
def bindingMutants : List (String × String × String) :=
  [("actor-skips-action", "hotcrp-actor", "M3a"), ("clock-does-not-advance", "clock", "M3a"),
   ("role-reader-reads-as-chair", "role-reader", "M3a"), ("hotcrp-reader-drops-last-row", "hotcrp-reader", "M3a"),
   ("state-reader-stale", "state-reader", "M3a"), ("observer-misses-socket", "boundary-observer", "M3a"),
   ("observer-misses-file-write", "boundary-observer", "M3a"), ("observer-misses-canary", "boundary-observer", "M3a"),
   ("view-reader-drops-last-row", "view-reader", "M4")]

def bindingMutantsJson : Json :=
  Json.arr <| bindingMutants.toArray.map fun (k, b, m) => Json.mkObj [("key", k), ("binding", b), ("milestone", m)]

end ReviewProcess
