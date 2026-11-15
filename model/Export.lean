import ReviewProcess
import Lean.Data.Json
open ReviewProcess Lean

/-
  `lake exe export <dir>` writes the model's vocabulary as JSON for the JVM build
  (PLAN §A2, §A3): the open questions and their readings, the example cards with
  their outcome under every combination of the readings they depend on, the policy
  table, the model's actions per subsystem, and the specification mutants.
  The files are committed (model/export/) and CI checks that they are current.
-/

def readingsJson : Json :=
  Json.arr <| QId.all.toArray.map fun q =>
    Json.mkObj [("code", q.code), ("text", q.text),
      ("readings", Json.arr <| q.labels.toArray.map fun (k, d) => Json.mkObj [("key", k), ("desc", d)])]

def readingObj (xs : List (QId × Nat)) : Json :=
  Json.mkObj <| xs.map fun (q, i) => (q.code, Json.str ((q.labels.getD i ("?", "?")).1))

/-- The values tried for each venue parameter: the default and others on either side. -/
def venueValues : String → List Nat
  | "nominees-max" => [1, 2, 3, 5] | "pattern-min" => [2, 3, 4] | "acc-grace-h" => [0, 24, 48, 72] | _ => []

def setVenue (v : Venue) : String → Nat → Venue
  | "nominees-max", n => { v with nomineesMax := n } | "pattern-min", n => { v with patternMin := n }
  | "acc-grace-h", n => { v with accGraceH := n } | _, _ => v

def venueJson (v : Venue) : Json :=
  Json.mkObj [("nomineesMax", Json.num v.nomineesMax), ("patternMin", Json.num v.patternMin), ("accGraceH", Json.num v.accGraceH)]

/-- A card's cases: every combination of the readings it depends on, and, for a card that declares
    venue parameters, of the values tried for each (the card then says which venue it ran under). -/
def cardsJson : Json :=
  Json.arr <| cards.toArray.map fun c =>
    let cases := combos (c.deps.map fun q => (q, List.range q.count))
    let venues : List (Option Venue) :=
      if c.venueDeps.isEmpty then [none]
      else (c.venueDeps.foldl (fun (acc : List Venue) n => acc.flatMap fun v => (venueValues n).map (setVenue v n)) [{}]).map some
    Json.mkObj [("id", c.id), ("text", c.text), ("deps", Json.arr (c.deps.toArray.map (Json.str ·.code))),
      ("venueDeps", Json.arr (c.venueDeps.toArray.map Json.str)),
      ("cases", Json.arr <| (cases.flatMap fun xs => venues.map fun v => (xs, v)).toArray.map fun (xs, v) =>
        let r : Reading := match v with | some v => { withAll {} xs with venue := v } | none => withAll {} xs
        let venueField : List (String × Json) := match v with | some v => [("venue", venueJson v)] | none => []
        let rest : List (String × Json) :=
          [("outcome", Json.str (c.outcome {} r)),
           ("underMutant", Json.arr (mutants.toArray.map fun m => Json.str (c.outcome m.params r)))]
        Json.mkObj ([("reading", readingObj xs)] ++ venueField ++ rest))]

def cellJson : Cell → Json
  | .y s => Json.mkObj [("kind", "granted"), ("scope", s)]
  | .n => Json.mkObj [("kind", "denied")]
  | .dot => Json.mkObj [("kind", "unexamined")]
  | .dag q g s => Json.mkObj [("kind", "ruling"), ("question", q), ("granted", g), ("scope", s)]

def policyJson : Json :=
  -- cells depend on the reading only through Q4; export each Q4 reading's table
  let tables := (List.range QId.q4.count).map fun i =>
    let r : Reading := ({} : Reading).set .q4 i
    Json.mkObj [("q4", (QId.q4.labels.getD i ("?", "?")).1),
      ("cells", Json.arr <| (Perm.all.flatMap fun pm => Role.all.map fun ro => (ro, pm)).toArray.map fun (ro, pm) =>
        Json.mkObj [("role", roleKey ro), ("perm", permKey pm), ("cell", cellJson (policy r ro pm))])]
  Json.mkObj [("roles", Json.arr (Role.all.toArray.map fun ro => Json.mkObj [("key", roleKey ro), ("name", ro.name)])),
    ("perms", Json.arr (Perm.all.toArray.map fun pm => Json.mkObj [("key", permKey pm), ("name", pm.name)])),
    ("modeledPerms", Json.arr (modeledPerms.toArray.map (Json.str ∘ permKey))),
    ("byQ4", Json.arr tables.toArray)]

def actionsJson : Json :=
  -- `key` and `args` are the binding vocabulary (Traces.lean); the JVM build generates the action
  -- types from them, so an action added here breaks the bindings' exhaustive `when` until it is bound.
  let sys {σ α : Type} (s : Sys σ α) (desc : α → ActDesc) (obs : List (String × String × List String)) : Json :=
    Json.mkObj [("subsystem", s.name),
      ("actions", Json.arr <| s.acts.toArray.map fun a =>
        Json.mkObj [("action", s.showAct a), ("key", (desc a).1), ("args", Json.mkObj (desc a).2),
          ("perm", match s.perm a with | some p => Json.str (permKey p) | none => Json.null)]),
      ("observations", Json.arr <| obs.toArray.map fun (k, t, rs) =>
        Json.mkObj [("key", k), ("type", t), ("readers", Json.arr (rs.toArray.map Json.str))])]
  Json.arr #[sys deskSys deskDesc deskObservations, sys earlySys earlyDesc earlyObservations, sys accSys accDesc accObservations, sys pcSys pcDesc pcObservations]

def transitionsJson (a : Answers) : Json :=
  let base := a.base
  let fix := base.set .q1 (indexIn (QId.q1.labels.map (·.1)) "fix-window")
  let one (tag : String) (r : Reading) : Json :=
    let (states, ts) := deskTransitions r
    Json.mkObj [("reading", tag), ("initial", obsKey (deskObserve r deskSys.init)),
      ("states", Json.arr (states.toArray.map Json.str)),
      ("transitions", Json.arr (ts.toArray.map fun (f, m, t) => Json.arr #[Json.num f, Json.str m, Json.num t]))]
  Json.mkObj [("subsystem", deskSys.name), ("readings", Json.arr #[one "signed" base, one "fix-window" fix])]

def tracesJson (a : Answers) : Json :=
  let base := a.base
  let fix := base.set .q1 (indexIn (QId.q1.labels.map (·.1)) "fix-window")
  Json.arr <| (deskTraces "signed" base ++ deskTraces "fix-window" fix).toArray.map Trace.json

/-- The early-reject witness traces: the first reading carries the first use of each granted cell. -/
def earlyReadings (a : Answers) : List (String × Reading × Bool) :=
  let base := a.base
  let withQ (q15 q16 : String) : Reading :=
    (base.set .q15 (indexIn (QId.q15.labels.map (·.1)) q15)).set .q16 (indexIn (QId.q16.labels.map (·.1)) q16)
  [("bump-reject-only", withQ "reject-only" "bump-window", true), ("bump-reject-or-weak", withQ "reject-or-weak" "bump-window", false),
   ("bump-below-accept", withQ "below-accept" "bump-window", false), ("no-window-reject-or-weak", withQ "reject-or-weak" "no-window", false)]

def earlyTracesJson (a : Answers) : Json :=
  Json.arr <| ((earlyReadings a).flatMap fun (tag, r, cells) => earlyTraces tag r cells).toArray.map ETrace.json

def pcTracesJson (a : Answers) : Json :=
  Json.arr <| (pcTraces "signed" a.base).toArray.map PTrace.json

/-- Accountability traces under both readings of Q20: the first carries the first use of each granted cell. -/
def accReadings (a : Answers) : List (String × Reading × Bool) :=
  let base := a.base
  let q20 (l : String) := base.set .q20 (indexIn (QId.q20.labels.map (·.1)) l)
  [("q20-needs-request", q20 "yes", true), ("q20-no-request-needed", q20 "no", false)]

def accTracesJson (a : Answers) : Json :=
  Json.arr <| ((accReadings a).flatMap fun (tag, r, cells) => accTraces tag r cells).toArray.map ATrace.json

def accTransitionsJson (a : Answers) : Json :=
  Json.mkObj [("subsystem", accSys.name), ("readings", Json.arr ((accReadings a).toArray.map fun (tag, r, _) =>
    Json.mkObj [("reading", tag), ("q20", (QId.q20.labels.getD (r.get .q20) ("?", "?")).1), ("graceH", Json.num r.venue.accGraceH), ("table", accTransitions r)]))]

def mutantsJson : Json :=
  Json.arr <| mutants.toArray.map fun m => Json.str m.name

def main (args : List String) : IO Unit := do
  let dir := args.headD "export"
  IO.FS.createDirAll dir
  let write (name : String) (j : Json) : IO Unit := IO.FS.writeFile s!"{dir}/{name}" (j.pretty ++ "\n")
  write "readings.json" readingsJson
  write "cards.json" cardsJson
  write "policy.json" policyJson
  write "actions.json" actionsJson
  write "mutants.json" mutantsJson
  write "binding-mutants.json" bindingMutantsJson
  -- the Lean parse of the synthetic answers file, for the JVM parser-agreement test
  let a := parseAnswers (← IO.FS.readFile "answers/synthetic.txt")
  write "traces-desk.json" (tracesJson a)
  write "traces-early.json" (earlyTracesJson a)
  write "traces-appt.json" (pcTracesJson a)
  write "traces-acc.json" (accTracesJson a)
  IO.FS.writeFile s!"{dir}/transitions-acc.json" ((accTransitionsJson a).compress ++ "\n")
  IO.FS.writeFile s!"{dir}/transitions-desk.json" ((transitionsJson a).compress ++ "\n")
  write "answers-synthetic.json" (Json.mkObj [
    ("given", Json.arr (a.given.toArray.map fun (q, i) => Json.arr #[q.code, (q.labels.getD i ("?", "?")).1])),
    ("errors", Json.arr (a.errors.toArray.map Json.str))])
  IO.println s!"wrote {dir}/: readings.json ({QId.all.length} questions), cards.json ({cards.length} cards), policy.json, actions.json, mutants.json, binding-mutants.json, traces-desk.json, traces-early.json, traces-appt.json, traces-acc.json, transitions-acc.json"
