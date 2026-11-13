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

def randomQuery (rule : String) (s : Nat) : Json :=
  let h (k : Nat) := hash2 s (5000 + k)
  let mutant : Json := if hash2 s 7 % 4 == 0 then Json.num (hash2 s 8 % mutants.length : Nat) else Json.null
  let tierJ (k : Nat) : Json := match h k % 3 with | 0 => Json.str "senior" | 1 => Json.str "junior" | _ => Json.null
  match rule with
  | "composition" =>
    let n := 1 + h 1 % 4
    Json.mkObj [("q", "composition"), ("reading", randomReading s),
      ("seats", Json.arr ((List.range n).toArray.map fun i =>
        Json.mkObj [("who", Json.num (i : Nat)), ("tier", if i < 2 && h 2 % 5 != 0 then Json.str "senior" else tierJ (10 + i)),
          ("nominee", h (20 + i) % 3 == 0)]))]
  | "owes" =>
    let nPapers := h 1 % 5
    let papers := (List.range nPapers).toArray.map fun i =>
      let nn := 1 + h (30 + i) % 3
      Json.mkObj [("paper", Json.num (i : Nat)), ("nominees", Json.arr ((List.range nn).toArray.map fun k =>
        Json.mkObj [("who", Json.num ((if k == 0 && h (40 + i) % 2 == 0 then 7 else 100 + h (50 + i * 3 + k) % 4 : Nat))),
          ("share", Json.num (h (60 + i * 3 + k) % 7 : Nat)), ("accepted", h (70 + i * 3 + k) % 5 != 0)]))]
    Json.mkObj [("q", "owes"), ("reading", randomReading s), ("mutant", mutant),
      ("tier", if h 2 % 2 == 0 then "senior" else "junior"), ("papers", Json.arr papers), ("u", Json.num (7 : Nat))]
  | "earlyReject" =>
    let n := h 1 % 4
    Json.mkObj [("q", "earlyReject"), ("reading", randomReading s), ("mutant", mutant),
      ("scores", Json.arr ((List.range n).toArray.map fun i => Json.str (pick scoreKeys (h (10 + i) % 4)).1)),
      ("bumped", h 2 % 3 == 0), ("windowClosed", h 3 % 2 == 0), ("acObjects", h 4 % 6 == 0)]
  | "caseMayOpen" =>
    let n := h 1 % 3
    Json.mkObj [("q", "caseMayOpen"), ("reading", randomReading s), ("mutant", mutant), ("missingReview", h 2 % 4 == 0),
      ("requests", Json.arr ((List.range n).toArray.map fun i =>
        Json.mkObj [("reviewer", Json.num (5 : Nat)), ("sentBy", if h (10 + i) % 3 == 0 then Json.null else Json.num (1 : Nat)),
          ("disp", if h (20 + i) % 4 == 0 then Json.null else Json.str (pick dispKeys (h (30 + i))).1)]))]
  | _ => Json.mkObj [("q", "mayRemove"), ("reading", randomReading s), ("mutant", mutant), ("referral", randomReferral s)]

def corpus (rule : String) (n seed : Nat) : IO Unit := do
  for i in [0:n] do
    let s := seed * 1000003 + i
    let query := if rule == "mayRemove" then
        let mutant : Json := if hash2 s 7 % 4 == 0 then Json.num (hash2 s 8 % mutants.length : Nat) else Json.null
        Json.mkObj [("q", "mayRemove"), ("reading", randomReading s), ("mutant", mutant), ("referral", randomReferral s)]
      else randomQuery rule s
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
