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
   ("no-contribution", .noContribution), ("nomination-noncompliance", .nominationNoncompliance),
   ("prompt-injection", .promptInjection)]

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

def parseVenue (j : Json) : Except String Venue := do
  let d : Venue := {}
  pure { nomineesMax := ← getD j "nomineesMax" d.nomineesMax, patternMin := ← getD j "patternMin" d.patternMin,
         accGraceH := ← getD j "accGraceH" d.accGraceH, remedyWindowH := ← getD j "remedyWindowH" d.remedyWindowH }

def parseReading (j : Json) : Except String Reading := do
  let mut r : Reading := {}
  match j with
  | .obj kvs =>
    for (k, v) in kvs.toList do
      if k == "venue" then
        r := { r with venue := ← parseVenue v }
        continue
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

def scoreKeys : List (String × Score) :=
  [("strong-reject", .strongReject), ("reject", .reject), ("weak-reject", .weakReject), ("borderline", .borderline),
   ("weak-accept", .weakAccept), ("accept", .accept), ("strong-accept", .strongAccept)]

def dispKeys : List (String × ReqDisposition) :=
  [("revised", .revised), ("explained", .explained), ("declined", .declined), ("no-reply", .noReply), ("disputed", .disputed)]

def parseTier (j : Json) (k : String) : Except String (Option Tier) :=
  match j.getObjVal? k with
  | .ok (.str "senior") => pure (some .senior)
  | .ok (.str "junior") => pure (some .junior)
  | _ => pure none

def parseMember (j : Json) : Except String Member := do
  pure { who := ← getD j "who" 0, tier := ← parseTier j "tier", nominee := ← getD j "nominee" false,
         accepted := ← getD j "accepted" true, consented := ← getD j "consented" true }

def parsePaperNoms (j : Json) : Except String PaperNoms := do
  let ns ← match j.getObjVal? "nominees" with
    | .ok (.arr xs) => xs.toList.mapM fun x => do
        pure ({ who := ← getD x "who" 0, share := ← getD x "share" 0, accepted := ← getD x "accepted" true } : Nominee)
    | _ => pure []
  pure { paper := ← getD j "paper" 0, nominees := ns }

def parseRequest (j : Json) : Except String Request := do
  let sentBy : Option Nat ← match j.getObjVal? "sentBy" with
    | .ok .null => pure none
    | .ok v => some <$> fromJson? v
    | .error _ => pure none
  let disp ← match j.getObjVal? "disp" with
    | .ok (.str k) => some <$> lookupKey dispKeys k
    | _ => pure none
  pure { reviewer := ← getD j "reviewer" 0, sentBy, disp }

/-- Min-cost max-flow with lower bounds, on top of `minCostMaxFlow` (PLAN M14, prop:A5).
    Arcs are (from, to, lower, capacity, cost) with nonnegative costs, none into `s` or out of `t`,
    and no lower bound on an arc out of `s`. Lower bounds become demands met from a super source and
    sink; the flow value is bought with a pre-saturated `t → s` arc of cost `-M` (`M` beats every
    real cost), so its cancellation arc `s → t` has the positive cost `M`. Returns whether the lower
    bounds can be met, the maximum flow value, and its minimum cost. -/
def boundedFlow (n s t : Nat) (arcs : Array (Nat × Nat × Int × Int × Int)) : Bool × Int × Int := Id.run do
  let sp := n
  let tp := n + 1
  let mut u0 : Int := 0
  let mut big : Int := 1
  let mut fixed : Int := 0
  let mut bal : Array Int := Array.replicate n 0
  let mut red : Array (Nat × Nat × Int × Int) := #[]
  for (u, v, lo, cap, c) in arcs do
    if u == s then u0 := u0 + cap
    big := big + cap * c
    fixed := fixed + lo * c
    bal := bal.modify v (· + lo) |>.modify u (· - lo)
    red := red.push (u, v, cap - lo, c)
  bal := bal.modify s (· + u0) |>.modify t (· - u0)
  red := red.push (s, t, u0, big)
  let cancel := red.size - 1
  let mut need : Int := 0
  for x in [0:n] do
    if bal[x]! > 0 then
      red := red.push (sp, x, bal[x]!, 0)
      need := need + bal[x]!
    else if bal[x]! < 0 then
      red := red.push (x, tp, -bal[x]!, 0)
  let (f, flow, total) := minCostMaxFlow (Flow.build (n + 2) red) sp tp
  let y := f.cap[2 * cancel + 1]!
  return (flow == need, u0 - y, total - big * y + fixed)


/-- The Plan on the model's synthetic conference (PLAN M15, spec §10.5): the instance the solver was given and
    the outcome the Lean solver reports, so `core` can solve the same instance and compare. The instance is
    what a solve needs: each reviewer's tier, nominee flag and cap, each paper's authors, and the candidate
    edges after the top-K pruning (before eligibility, which `core` applies itself). -/
def nj (n : Nat) : Json := toJson n

def planQuery (s : Scale) (r : Reading) : Json :=
  let c := synth s r
  let (cap, owed) := loadCaps c r
  let o := runConf r c
  let first := solveOnce c r cap ((cands c {} (rawCands c r).toList))
  let n := c.personArea.size
  let reviewers := (List.range n).filterMap fun u =>
    if c.pcTier[u]!.isSome || c.nomineeTier[u]!.isSome then
      let m := c.member u
      some (Json.mkObj [("who", nj u), ("tier", match m.tier with | some .senior => Json.str "senior" | some .junior => Json.str "junior" | none => Json.null), ("nominee", m.nominee),
        ("cap", nj cap[u]!), ("owed", nj owed[u]!)])
    else none
  let papers := (List.range c.nPapers).map fun pp =>
    Json.mkObj [("pid", nj pp), ("authors", Json.arr (c.authors[pp]!.toArray.map fun u => nj u))]
  let cands := (rawCands c r).map fun e => Json.arr #[nj e.who, nj e.paper, nj e.aff]
  Json.mkObj
    [("reviewers", Json.arr reviewers.toArray), ("papers", Json.arr papers.toArray), ("cands", Json.arr cands),
     ("outcome", Json.mkObj
       [("composed", nj o.composed), ("seniorShort", nj o.seniorShort), ("thirdShort", nj o.thirdShort),
        ("cyclesFirst", nj o.cyclesFirst), ("repairs", nj o.repairs), ("cycles", nj o.cycles),
        ("loadViolations", nj o.loadViolations), ("nominees", nj o.nominees),
        ("nomineeReviews", nj o.nomineeReviews), ("objective", toJson o.objective),
        ("candidateEdges", nj o.candidateEdges),
        ("firstObjective", toJson first.objective), ("firstFilled", nj first.filled)])]

def parseScale (j : Json) : Except String Scale := do
  let d : Scale := {}
  pure { papers := ← getD j "papers" d.papers, areas := ← getD j "areas" d.areas, seniors := ← getD j "seniors" d.seniors,
         juniors := ← getD j "juniors" d.juniors, nomineeAcceptPct := ← getD j "nomineeAcceptPct" d.nomineeAcceptPct,
         nomineeSeniorPct := ← getD j "nomineeSeniorPct" d.nomineeSeniorPct, pcAuthorPct := ← getD j "pcAuthorPct" d.pcAuthorPct }

def answer (j : Json) : Except String Json := do
  let q ← j.getObjValAs? String "q"
  match q with
  | "ping" => pure (Json.mkObj [("ok", true)])
  | "mayRemove" =>
    let r ← parseReading ((j.getObjVal? "reading").toOption.getD .null)
    let p ← parseParams ((j.getObjVal? "mutant").toOption.getD .null)
    let ref ← parseReferral (← j.getObjVal? "referral")
    pure (Json.mkObj [("result", mayRemove p r ref)])
  | "composition" =>
    let r ← parseReading ((j.getObjVal? "reading").toOption.getD .null)
    let seats ← match j.getObjVal? "seats" with
      | .ok (.arr xs) => xs.toList.mapM parseMember
      | _ => pure []
    pure (Json.mkObj [("result", compositionOk r seats)])
  | "owes" =>
    let r ← parseReading ((j.getObjVal? "reading").toOption.getD .null)
    let p ← parseParams ((j.getObjVal? "mutant").toOption.getD .null)
    let tier ← match j.getObjVal? "tier" with
      | .ok (.str "senior") => pure Tier.senior
      | _ => pure Tier.junior
    let papers ← match j.getObjVal? "papers" with
      | .ok (.arr xs) => xs.toList.mapM parsePaperNoms
      | _ => pure []
    let u : Nat ← getD j "u" 0
    pure (Json.mkObj [("result", match owes p r tier papers u with | some n => Json.num n | none => Json.null)])
  | "earlyReject" =>
    let r ← parseReading ((j.getObjVal? "reading").toOption.getD .null)
    let p ← parseParams ((j.getObjVal? "mutant").toOption.getD .null)
    let scores ← match j.getObjVal? "scores" with
      | .ok (.arr xs) => xs.toList.mapM fun x => do lookupKey scoreKeys (← x.getStr?)
      | _ => pure []
    let c : ERCase := { scores, bumped := ← getD j "bumped" false, windowClosed := ← getD j "windowClosed" false,
                        acObjects := ← getD j "acObjects" false }
    pure (Json.mkObj [("result", mayEarlyReject p r c)])
  | "minCostMaxFlow" =>
    let n : Nat ← j.getObjValAs? Nat "n"
    let s : Nat ← j.getObjValAs? Nat "s"
    let t : Nat ← j.getObjValAs? Nat "t"
    let rows : Array (Array Int) ← j.getObjValAs? (Array (Array Int)) "arcs"
    let arcs ← rows.mapM fun r =>
      if r.size == 5 then pure (r[0]!.toNat, r[1]!.toNat, r[2]!, r[3]!, r[4]!) else throw "arc must be [from,to,lower,cap,cost]"
    let (ok, flow, cost) := boundedFlow n s t arcs
    pure (Json.mkObj [("feasible", ok), ("flow", toJson flow), ("cost", toJson cost)])
  | "plan" =>
    let r ← parseReading ((j.getObjVal? "reading").toOption.getD .null)
    let sc ← parseScale ((j.getObjVal? "scale").toOption.getD .null)
    pure (planQuery sc r)
  | "caseMayOpen" =>
    let r ← parseReading ((j.getObjVal? "reading").toOption.getD .null)
    let p ← parseParams ((j.getObjVal? "mutant").toOption.getD .null)
    let reqs ← match j.getObjVal? "requests" with
      | .ok (.arr xs) => xs.toList.mapM parseRequest
      | _ => pure []
    pure (Json.mkObj [("result", caseMayOpen p r (← getD j "missingReview" false) reqs)])
  | "caseListing" =>
    let ss ← match j.getObjVal? "shares" with
      | .ok (.arr xs) => xs.toList.mapM fun x => do
          pure ({ paper := ← getD x "paper" 0, owed := ← getD x "owed" 0, done := ← getD x "done" 0 } : Share)
      | _ => pure []
    pure (Json.mkObj [("result", Json.mkObj [("cases", Json.num (casesFor ss : Nat)), ("papers", Json.arr ((unmetPapers ss).toArray.map fun (n : Nat) => Json.num n))])])
  | "eligible" =>
    let p ← parseParams ((j.getObjVal? "mutant").toOption.getD .null)
    let m ← parseMember (← j.getObjVal? "member")
    let ids (k : String) : Except String (List Nat) := match j.getObjVal? k with
      | .ok (.arr xs) => xs.toList.mapM fromJson?
      | _ => pure []
    pure (Json.mkObj [("result", eligible p m { authors := ← ids "authors", conflicts := ← ids "conflicts" })])
  | "compliance" =>
    let r ← parseReading ((j.getObjVal? "reading").toOption.getD .null)
    let pn ← parsePaperNoms (← j.getObjVal? "paper")
    let reg : List Nat ← match j.getObjVal? "registered" with
      | .ok (.arr xs) => xs.toList.mapM fromJson?
      | _ => pure []
    pure (Json.mkObj [("result", (compliance r pn reg).key)])
  | "pattern" =>
    let author : Nat ← getD j "author" 0
    let tier ← parseTier j "tier"
    let noms ← match j.getObjVal? "noms" with
      | .ok (.arr xs) => xs.toList.mapM fun x => do pure (← getD x "who" 0, ← parseTier x "tier")
      | _ => pure []
    let v ← match j.getObjVal? "venue" with
      | .ok o => parseVenue o
      | _ => pure {}
    pure (Json.mkObj [("result", nominationPattern v author tier noms)])
  | "mayDispose" =>
    let r ← parseReading ((j.getObjVal? "reading").toOption.getD .null)
    let reqJ ← j.getObjVal? "request"
    let disp ← match j.getObjVal? "disp" with
      | .ok (.str k) => lookupKey dispKeys k
      | _ => pure .noReply
    let remindedAt : Option Nat ← match reqJ.getObjVal? "remindedAt" with
      | .ok .null => pure none
      | .ok v => some <$> fromJson? v
      | .error _ => pure none
    let q : Request := { reviewer := 5, sentBy := some 1, due := ← getD reqJ "due" 48, remindedAt, replied := ← getD reqJ "replied" false }
    pure (Json.mkObj [("result", mayDispose r.venue.accGraceH q disp (← getD j "now" 0))])
  | "appointmentAuthority" =>
    let nominating : List (List Nat) ← match j.getObjVal? "nominating" with
      | .ok (.arr xs) => xs.toList.mapM fun x => match x with
          | .arr ys => ys.toList.mapM fromJson?
          | _ => throw "nominating must be a list of lists"
      | _ => pure []
    let acs : List Nat ← match j.getObjVal? "acs" with
      | .ok (.arr xs) => xs.toList.mapM fromJson?
      | _ => pure []
    pure (Json.mkObj [("result", decisionCounts nominating acs (← getD j "decider" 0) (← getD j "isChair" false))])
  | "remedyDue" =>
    let r ← parseReading ((j.getObjVal? "reading").toOption.getD .null)
    pure (Json.mkObj [("result", Json.num (remedyDueAt r.venue.remedyWindowH (← getD j "now" 0)))])
  | "overCap" =>
    let r ← parseReading ((j.getObjVal? "reading").toOption.getD .null)
    pure (Json.mkObj [("result", Json.num (papersOverCap r (← getD j "papers" 0)))])
  | other => throw s!"unknown query {other}"


/-- Answer one query given as JSON text; errors come back as `{"error": ...}`. -/
def answerText (line : String) : String :=
  match Json.parse line with
  | .error e => (Json.mkObj [("error", s!"parse: {e}")]).compress
  | .ok j => match answer j with
    | .ok a => a.compress
    | .error e => (Json.mkObj [("error", e)]).compress

end ReviewProcess
