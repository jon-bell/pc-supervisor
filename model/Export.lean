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

def cardsJson : Json :=
  Json.arr <| cards.toArray.map fun c =>
    let cases := combos (c.deps.map fun q => (q, List.range q.count))
    Json.mkObj [("id", c.id), ("text", c.text), ("deps", Json.arr (c.deps.toArray.map (Json.str ·.code))),
      ("cases", Json.arr <| cases.toArray.map fun xs =>
        Json.mkObj [("reading", readingObj xs), ("outcome", c.outcome {} (withAll {} xs))])]

def roleKey : Role → String
  | .processChair => "process-chair" | .pcChair => "pc-chair" | .ac => "ac" | .juniorPcChair => "junior-pc-chair"
  | .pcMember => "pc-member" | .nominee => "nominee" | .author => "author" | .pcs => "pcs" | .agent => "agent"

def permKey (p : Perm) : String :=
  -- camelCase constructor name to kebab-case
  let s := (toString (repr p)).replace "ReviewProcess.Perm." ""
  String.join (s.toList.map fun ch => if ch.isUpper then "-" ++ (toString ch.toLower) else toString ch)

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
  let sys {σ α : Type} (s : Sys σ α) : Json :=
    Json.mkObj [("subsystem", s.name), ("actions", Json.arr <| s.acts.toArray.map fun a =>
      Json.mkObj [("action", s.showAct a), ("perm", match s.perm a with | some p => Json.str (permKey p) | none => Json.null)])]
  Json.arr #[sys deskSys, sys earlySys, sys accSys, sys pcSys]

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
  -- the Lean parse of the synthetic answers file, for the JVM parser-agreement test
  let a := parseAnswers (← IO.FS.readFile "answers/synthetic.txt")
  write "answers-synthetic.json" (Json.mkObj [
    ("given", Json.arr (a.given.toArray.map fun (q, i) => Json.arr #[q.code, (q.labels.getD i ("?", "?")).1])),
    ("errors", Json.arr (a.errors.toArray.map Json.str))])
  IO.println s!"wrote {dir}/: readings.json ({QId.all.length} questions), cards.json ({cards.length} cards), policy.json, actions.json, mutants.json"
