import ReviewProcess.Solver
import Lean.Data.Json
open Lean
/-
  The oracle's query language (PLAN §A3): JSON queries about expected behavior, answered
  by the model. Used by `lake exe oracle` (a process the JVM tests talk to) and by
  `ReviewProcess.Ffi` (the same answers, in-process, through a native library).
-/
namespace ReviewProcess

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


/-- Answer one query given as JSON text; errors come back as `{"error": ...}`. -/
def answerText (line : String) : String :=
  match Json.parse line with
  | .error e => (Json.mkObj [("error", s!"parse: {e}")]).compress
  | .ok j => match answer j with
    | .ok a => a.compress
    | .error e => (Json.mkObj [("error", e)]).compress

end ReviewProcess
