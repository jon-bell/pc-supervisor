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
      let reply := answerText line.trimAscii.toString
      stdout.putStrLn reply
      stdout.flush
    return 0
  | _ => IO.eprintln "usage: oracle | oracle corpus <rule> <n> <seed>"; return 2
