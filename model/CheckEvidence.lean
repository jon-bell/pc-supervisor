import ReviewProcess
import Lean.Data.Json
open ReviewProcess Lean

/-
  `lake exe check-evidence <file or directory>...` re-derives each verdict of an evidence record
  from the model (PLAN §A6), so a reviewer trusts the model, this checker, the bindings, and the
  runner, and not the Kotlin test code that ran the scenario.

  For a trace record it replays the recorded actions through the model's gated step functions and
  compares every recorded outcome and every observation, from every reader that was asked, with
  the model's. For a controls record it re-derives from the recorded runs that every positive
  control agreed with the model, and every negative control (a binding mutant, or a specification
  mutant switched on in `core`) disagreed with it, and that every binding mutant the model lists
  has a control. Exit status 1 if any record disagrees.
-/

def getStr (j : Json) (k : String) : String := ((j.getObjValAs? String k).toOption).getD ""
def getArr (j : Json) (k : String) : Array Json := match j.getObjVal? k with | .ok (.arr a) => a | _ => #[]
def getObj (j : Json) (k : String) : Json := (j.getObjVal? k).toOption.getD Json.null

/-- The disagreements between one trace record and the model's replay of it. -/
def traceDisagreements (rec : Json) : Except String (List String) := do
  let reading ← parseReading (getObj rec "reading")
  let params ← parseParams (getObj rec "modelMutant")
  let mut moves : List Move := []
  for st in getArr rec "steps" do
    let role ← match getObj st "role" with
      | .null => pure none
      | .str k => match roleOfKey? k with | some r => pure (some r) | none => throw s!"unknown role {k}"
      | _ => throw "bad role"
    moves := moves ++ [{ role, act := ← deskActOfJson (getObj st "action") }]
  let mut s : DeskSt := deskSys.init
  let mut bad : List String := []
  let mut outcomes : List Bool := []
  let mut i := 0
  for (st, m) in (getArr rec "steps").toList.zip moves do
    i := i + 1
    let next := gated deskSys params reading s (m.role, m.act)
    let eff := next.isSome
    s := next.getD s
    outcomes := outcomes ++ [eff]
    if getStr st "outcome" != (if eff then "effective" else "refused") then
      bad := bad ++ [s!"step {i} ({showMove deskSys (m.role, m.act)}): the system {getStr st "outcome"}, the model says {if eff then "effective" else "refused"}"]
    let model := deskObserve reading s
    let observed := getObj st "observed"
    for (k, _, readers) in deskObservations do
      let byReader := getObj observed k
      for rd in readers do
        match byReader.getObjVal? rd with
        | .error _ => bad := bad ++ [s!"step {i}: observation {k} not read by the {rd} reader"]
        | .ok v =>
          let want := getObj model k
          if v.compress != want.compress then
            bad := bad ++ [s!"step {i}: {k} read by {rd} is {v.compress}, the model says {want.compress}"]
      match byReader with
      | .obj kvs => for (rd, _) in kvs.toList do
          if !readers.contains rd then bad := bad ++ [s!"step {i}: observation {k} read by unexpected reader {rd}"]
      | _ => pure ()
  let v ← verdictOfJson (getObj (getObj rec "verdict") "claimed")
  let holds := v.holds moves outcomes s
  let claimed := (getObj (getObj rec "verdict") "holds").getBool?.toOption.getD false
  if holds != claimed then
    bad := bad ++ [s!"the record claims the verdict {if claimed then "holds" else "fails"}, the model says {if holds then "holds" else "fails"}"]
  if (getArr rec "steps").size != moves.length then bad := bad ++ ["step count mismatch"]
  return bad

/-- Verdicts must also hold in the model, as the claim of the trace says. -/
def checkTraceRecord (rec : Json) : Except String (List String) := do
  let bad ← traceDisagreements rec
  let claimedHolds := (getObj (getObj rec "verdict") "holds").getBool?.toOption.getD false
  -- the boundary log: nothing but the harness, and no canary anywhere it must not be (PLAN §A6)
  let violations := getArr (getObj rec "boundary") "violations"
  let bad := bad ++ violations.toList.map fun v => s!"boundary violation: {v.getStr?.toOption.getD (v.compress)}"
  let bad := if (getObj rec "boundary") == Json.null then bad ++ ["the record has no boundary log"] else bad
  pure (if claimedHolds then bad else bad ++ ["the claimed verdict does not hold in the model"])

def requiredPositive : List String :=
  ["hotcrp-actor", "clock", "role-reader", "hotcrp-reader", "state-reader", "boundary-observer"]

def observerCaught (c : Json) : Bool :=
  let planted := getArr c "planted"
  let seen := getArr c "seen"
  planted.any fun p => !(seen.any (· == p))

def observerAgrees (c : Json) : Bool := !observerCaught c

def checkControls (rec : Json) : Except String (List String) := do
  let cs := getArr rec "controls"
  let mut bad : List String := []
  let mut caught : List String := []
  let mut passed : List String := []
  for c in cs do
    let name := getStr c "name"
    let pol := getStr c "polarity"
    let binding := getStr c "binding"
    let mutant := getStr c "mutant"
    let disagree ←
      match getObj c "trace" with
      | .null => pure (observerCaught (getObj c "observer"))
      | t => pure (!(← traceDisagreements t).isEmpty)
    let claimed := (getObj c "caught").getBool?.toOption.getD false
    if pol == "negative" then
      if !disagree then bad := bad ++ [s!"control {name}: the mutant {mutant} was not caught (the record agrees with the model)"]
      else caught := caught ++ [mutant]
      if claimed != disagree then bad := bad ++ [s!"control {name}: recorded caught={claimed}, re-derived {disagree}"]
    else
      if disagree then bad := bad ++ [s!"control {name}: the positive control for {binding} disagrees with the model"]
      else passed := passed ++ [binding]
  for (k, b, m) in bindingMutants do
    if m == "M3a" && !caught.contains k then bad := bad ++ [s!"binding mutant {k} ({b}) has no control that catches it"]
  for b in requiredPositive do
    if !passed.contains b then bad := bad ++ [s!"binding {b} has no passing positive control"]
  -- spec mutants switched on in core that the desk-reject traces can catch
  for k in (getArr rec "requiredSpecMutants").toList do
    let k := k.getStr?.toOption.getD ""
    if !caught.contains k then bad := bad ++ [s!"specification mutant {k} was not caught end to end"]
  return bad

partial def collect (path : System.FilePath) : IO (Array System.FilePath) := do
  if ← path.isDir then
    let mut out := #[]
    for e in (← path.readDir).qsort (fun a b => a.fileName < b.fileName) do
      out := out ++ (← collect e.path)
    return out
  else return if path.extension == some "json" then #[path] else #[]

def main (args : List String) : IO UInt32 := do
  if args.isEmpty then IO.eprintln "usage: check-evidence <evidence record or directory>..."; return 2
  let mut files := #[]
  for a in args do files := files ++ (← collect a)
  if files.isEmpty then IO.eprintln "check-evidence: no evidence records found"; return 1
  let mut failures := 0
  let mut checked := 0
  for f in files do
    match Json.parse (← IO.FS.readFile f) with
    | .error e => IO.println s!"FAIL {f}: not JSON: {e}"; failures := failures + 1
    | .ok rec =>
      let res := match getStr rec "kind" with
        | "trace" => checkTraceRecord rec
        | "controls" => checkControls rec
        | k => .error s!"unknown record kind {k}"
      checked := checked + 1
      match res with
      | .error e => IO.println s!"FAIL {f}: {e}"; failures := failures + 1
      | .ok [] => IO.println s!"ok   {f}"
      | .ok bad =>
        failures := failures + 1
        IO.println s!"FAIL {f}"
        for b in bad do IO.println s!"       {b}"
  IO.println s!"check-evidence: {checked} records, {failures} failing"
  return if failures == 0 then 0 else 1
