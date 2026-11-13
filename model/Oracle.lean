import ReviewProcess
import Lean.Data.Json
open ReviewProcess Lean

/-
  `lake exe oracle` answers questions about expected behavior (PLAN §A3).

  Interactive: one JSON query per line on stdin, one JSON answer per line on stdout.
    {"q":"ping"}
    {"q":"mayRemove","reading":{"Q2":"vote",...},"mutant":null,"referral":{...}}
  A query names readings by key; questions it omits take their first reading.
  `mutant` is a mutant's index in mutants.json, or null for the signed model.

  Corpus: `lake exe oracle corpus <rule> <n> <seed>` writes n random queries with
  their answers, one JSON object per line, for the JVM's fast test path.
-/

def groundKeys : List (String × Ground) :=
  [("format", .format), ("scope", .scope), ("anonymity", .anonymity),
   ("fabricated-reference", .fabricatedReference), ("misused-citation", .misusedCitation),
   ("no-contribution", .noContribution), ("nomination-noncompliance", .nominationNoncompliance)]

def stageKeys : List (String × Stage) :=
  [("screening", .screening), ("assigned", .assigned), ("in-review", .inReview), ("released", .released)]

def lookupKey {α : Type} (xs : List (String × α)) (k : String) : Except String α :=
  match xs.find? (·.1 == k) with
  | some (_, v) => .ok v
  | none => .error s!"unknown key {k}"

def getD {α : Type} [FromJson α] (j : Json) (k : String) (d : α) : Except String α :=
  match j.getObjVal? k with
  | .ok Json.null => .ok d
  | .ok v => fromJson? v
  | .error _ => .ok d

def parseReading (j : Json) : Except String Reading := do
  let mut r : Reading := {}
  match j with
  | .obj kvs =>
    for (k, v) in kvs.toList do
      let q ← match QId.all.find? (·.code == k) with
        | some q => pure q
        | none => throw s!"unknown question {k}"
      let key ← v.getStr?
      let i := indexIn (q.labels.map (·.1)) key
      if i ≥ q.count then throw s!"{k}: unknown reading {key}"
      r := r.set q i
    pure r
  | .null => pure r
  | _ => throw "reading must be an object"

def parseParams (j : Json) : Except String Params :=
  match j with
  | .null => .ok {}
  | v => do
    let i : Nat ← fromJson? v
    match mutants[i]? with
    | some m => pure m.params
    | none => throw s!"no mutant {i}"

def parseOpinion (j : Json) : Except String Opinion := do
  let tier : Option Tier ← match j.getObjVal? "tier" with
    | .ok (.str "senior") => pure (some .senior)
    | .ok (.str "junior") => pure (some .junior)
    | .ok .null => pure none
    | .error _ => pure none
    | .ok v => throw s!"bad tier {v.compress}"
  pure { who := ← getD j "who" 0, isAc := ← getD j "isAc" false, tier,
         conflicted := ← getD j "conflicted" false, agrees := ← getD j "agrees" true }

def parseReferral (j : Json) : Except String Referral := do
  let ground ← lookupKey groundKeys (← j.getObjValAs? String "ground")
  let stage ← lookupKey stageKeys (← getD j "stage" "screening")
  let ops ← match j.getObjVal? "opinions" with
    | .ok (.arr xs) => xs.toList.mapM parseOpinion
    | _ => pure []
  pure { ac := ← getD j "ac" 1, ground, opinions := ops, stage,
         remedyOffered := ← getD j "remedyOffered" false, remedyDue := ← getD j "remedyDue" 0,
         cured := ← getD j "cured" false, warned := ← getD j "warned" false,
         askedAt := ← getD j "askedAt" 0, now := ← getD j "now" 0 }

def answer (j : Json) : Except String Json := do
  let q ← j.getObjValAs? String "q"
  match q with
  | "ping" => pure (Json.mkObj [("ok", true)])
  | "mayRemove" =>
    let r ← parseReading ((j.getObjVal? "reading").toOption.getD .null)
    let p ← parseParams ((j.getObjVal? "mutant").toOption.getD .null)
    let ref ← parseReferral (← j.getObjVal? "referral")
    pure (Json.mkObj [("result", mayRemove p r ref)])
  | other => throw s!"unknown query {other}"

/-! ### Random corpus -/

def pick {α : Type} [Inhabited α] (xs : List α) (h : Nat) : α := xs.getD (h % xs.length) default

def randomReading (seed : Nat) : Json :=
  Json.mkObj <| QId.all.map fun q =>
    (q.code, Json.str ((q.labels.getD (hash2 seed (q.code.length * 31 + q.count + q.text.length) % q.count) ("?", "?")).1))

def randomReferral (seed : Nat) : Json :=
  let h (k : Nat) := hash2 seed (1000 + k)
  let nOps := h 1 % 5
  let ops := (List.range nOps).map fun i =>
    Json.mkObj [("who", Json.num (h (10 + i) % 5 : Nat)), ("isAc", h (20 + i) % 3 == 0),
      ("tier", match h (30 + i) % 3 with | 0 => Json.str "senior" | 1 => Json.str "junior" | _ => Json.null),
      ("conflicted", h (40 + i) % 8 == 0), ("agrees", h (50 + i) % 7 != 0)]
  Json.mkObj [("ac", Json.num (h 2 % 3 : Nat)), ("ground", (pick groundKeys (h 3)).1),
    ("opinions", Json.arr ops.toArray), ("stage", (pick stageKeys (h 4)).1),
    ("remedyOffered", h 5 % 2 == 0), ("remedyDue", Json.num (h 6 % 100 : Nat)), ("cured", h 7 % 4 == 0),
    ("warned", h 8 % 2 == 0), ("askedAt", Json.num (h 9 % 100 : Nat)), ("now", Json.num (h 11 % 200 : Nat))]

def corpus (rule : String) (n seed : Nat) : IO Unit := do
  for i in [0:n] do
    let s := seed * 1000003 + i
    let mutant : Json := if hash2 s 7 % 4 == 0 then Json.num (hash2 s 8 % mutants.length : Nat) else Json.null
    let query := match rule with
      | _ => Json.mkObj [("q", "mayRemove"), ("reading", randomReading s), ("mutant", mutant), ("referral", randomReferral s)]
    match answer query with
    | .ok a => IO.println (Json.mkObj [("query", query), ("answer", a)]).compress
    | .error e => throw (IO.userError e)

def main (args : List String) : IO UInt32 := do
  match args with
  | ["corpus", rule, n, seed] => corpus rule n.toNat! seed.toNat!; return 0
  | [] =>
    let stdin ← IO.getStdin
    let stdout ← IO.getStdout
    repeat
      let line ← stdin.getLine
      if line.isEmpty then break
      let reply := match Json.parse line.trimAscii.toString with
        | .error e => Json.mkObj [("error", s!"parse: {e}")]
        | .ok j => match answer j with
          | .ok a => a
          | .error e => Json.mkObj [("error", e)]
      stdout.putStrLn reply.compress
      stdout.flush
    return 0
  | _ => IO.eprintln "usage: oracle | oracle corpus <rule> <n> <seed>"; return 2
