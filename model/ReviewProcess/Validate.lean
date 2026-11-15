import ReviewProcess.Properties
/-
  Validation by example (docs/concepts.md §5, steps 2–4 and 6), run on the model.
  1. Example cards. Each declares the questions it depends on; the legibility
     check confirms that no other question changes its outcome.
  2. The chairs' answers (an answers file) narrow each question's readings by
     asking the cards that split them. Open questions get the cards to bring.
  3. The signed specification is mutated; each mutant must be killed by a card
     or rejected by a property.
  4. A synthetic conference shows the consequences of a reading at scale.
-/
namespace ReviewProcess

/-! ### Example cards -/

structure Card where
  id : String
  text : String
  deps : List QId
  /-- Venue parameters the outcome depends on (`nominees-max`, `pattern-min`, `acc-grace-h`, `remedy-window-h`, `junior-seats`, `reviewer-target`). -/
  venueDeps : List String := []
  outcome : Params → Reading → String

def yesNo (b : Bool) (y n : String) : String := if b then y else n

def senior (who : PersonId) (isAc := false) : Opinion := { who, tier := some .senior, isAc }
def junior (who : PersonId) : Opinion := { who, tier := some .junior }

/-- Agreement that satisfies every reading of Q2: a senior who is also an AC,
    another senior, and a junior. Cards that test Q2 pass their own opinions. -/
def everyone : List Opinion := [senior 2 (isAc := true), senior 3, junior 4]

/-- A referral with everyone's agreement, the remedy (if any) offered and expired. -/
def refAt (g : Ground) (st : Stage) (ops : List Opinion := everyone) : Referral :=
  { ac := 1, ground := g, opinions := ops, stage := st, remedyOffered := true, remedyDue := 10, now := 20 }

def removable (p : Params) (r : Reading) (ref : Referral) : String :=
  yesNo (mayRemove p r ref) "may be desk rejected" "stays in review"

def noms (paper : Nat) (xs : List Nominee) : PaperNoms := { paper, nominees := xs }

def showOwes (r : Reading) (o : Option Nat) : String :=
  match o with
  | none => "pooled with the paper's other nominees"
  | some n => (if r.q7 == .upToMax then "may be assigned up to " else "is expected to do ") ++ showSixths n

def cards : List Card :=
  [ -- reciprocal nominees
    { id := "X1", text := "A paper names no nominee", deps := [.q10],
      outcome := fun p r =>
        let g : Referral := { refAt .nominationNoncompliance .screening with warned := false }
        let gw : Referral := { g with warned := true }
        -- only a paper that fails `compliance` can be referred on this ground
        if compliance r (noms 1 []) [] == .ok then "compliant" else
        s!"before any warning: {removable p r g}; after a warning that is ignored: {removable p r gw}" },
    { id := "X2", text := "One junior is the sole nominee of 9 papers (k = 3)", deps := [.q18, .q7],
      outcome := fun p r =>
        let ns := (List.range 9).map fun i => noms i [{ who := 7 }]
        s!"the nominee {showOwes r (owes p r .junior ns 7)} reviews" },
    { id := "X3", text := "A senior author with 6 papers always nominates a different student co-author", deps := [],
      venueDeps := ["pattern-min"],
      outcome := fun _ r =>
        let noms6 := (List.range 6).map fun i => (20 + i, some Tier.junior)
        s!"{yesNo (nominationPattern r.venue 1 (some .senior) noms6) "shown to the PC chairs as a pattern" "nothing to show"}; {patternConsequence}" },
    { id := "X3b", text := "A senior author nominates the same student from 3 papers", deps := [],
      venueDeps := ["pattern-min"],
      outcome := fun _ r =>
        let noms3 := (List.range 3).map fun _ => (20, some Tier.junior)
        s!"{yesNo (nominationPattern r.venue 1 (some .senior) noms3) "shown to the PC chairs as a pattern: every nomination counts, repeats included" "nothing to show"}; {patternConsequence}" },
    { id := "X4", text := "The AC accepts a nominee and classifies them senior", deps := [.q14],
      outcome := fun _ r =>
        yesNo (fillsSenior r { who := 7, tier := some .senior, nominee := true })
          "fills a senior slot" "fills only the third slot; the paper still needs two other seniors" },
    { id := "X5", text := "The AC declines a nominee who is otherwise the best match", deps := [],
      outcome := fun p _ =>
        yesNo (eligible p { who := 7, tier := some .junior, nominee := true, accepted := false } {})
          "assignable" "never assigned" },
    { id := "X6", text := "An accepted nominee never submits; escalation exhausted", deps := [.q11],
      outcome := fun p r => s!"a case {yesNo (caseMayOpen p r true []) "opens" "does not open"}; {consequence r}" },
    { id := "X7", text := "An author is on 11 submissions", deps := [.q17],
      outcome := fun _ r =>
        let n := papersOverCap r 11
        if n > 0 then s!"{n} papers over the cap, reported to the PC chairs" else "nothing to report" },
    { id := "X8", text := "A paper names two nominees and allocates two-thirds and one-third", deps := [.q8, .q19],
      venueDeps := ["nominees-max"],
      outcome := fun p r =>
        if compliance r (noms 1 [{ who := 7, share := 4 }, { who := 8, share := 2 }]) [7, 8] == .tooManyNominees
        then s!"not allowed: at most {if r.q8 == .one then 1 else r.venue.nomineesMax} nominee(s) per paper" else
        match paperShares p r (noms 1 [{ who := 7, share := 4 }, { who := 8, share := 2 }]) with
        | none => "pooled: the two together owe 3 reviews"
        | some ss => ", ".intercalate (ss.map fun (_, n) => showSixths n) ++ " reviews" },
    { id := "X9", text := "A paper names two nominees (split equally); the AC declines one", deps := [.q8, .q19, .q19b],
      venueDeps := ["nominees-max"],
      outcome := fun p r =>
        if compliance r (noms 1 [{ who := 7, share := 3 }, { who := 8, share := 3 }]) [7, 8] == .tooManyNominees
        then s!"not allowed: at most {if r.q8 == .one then 1 else r.venue.nomineesMax} nominee(s) per paper" else
        let pn := noms 1 [{ who := 7, share := 3 }, { who := 8, share := 3, accepted := false }]
        let mine := match paperShares p r pn with
          | none => "the remaining nominee is pooled with the paper's obligation"
          | some ss => s!"the remaining nominee owes {showSixths ((ss.filter (fun (x : PersonId × Nat) => x.1 == 7)).foldl (fun (a : Nat) (x : PersonId × Nat) => a + x.2) 0)}"
        let moved := yesNo (movedToUnnamed p r pn) "; the declined share moves to an unnamed reviewer" ""
        s!"{mine}; the paper is short by {showSixths (paperShortfall p r pn)}{moved}" },
    { id := "X11", text := "A paper names four nominees", deps := [.q8], venueDeps := ["nominees-max"],
      outcome := fun _ r =>
        let pn := noms 1 ((List.range 4).map fun i => { who := 7 + i })
        s!"{match compliance r pn [7, 8, 9, 10] with
          | .ok => "compliant" | .tooManyNominees => "too many nominees: reported, and Q10's consequence applies"
          | c => c.key}" },
    { id := "X12", text := "A PC chair records an accept for a candidate whom no AC of the nominating paper has decided on", deps := [],
      outcome := fun _ _ =>
        let acsOfPaper := [[1, 2]]
        s!"{yesNo (decisionCounts acsOfPaper [1, 2, 3] 9 true) "the decision counts" "never acted on"}; a PC member who is neither the paper's AC nor a chair: {yesNo (decisionCounts acsOfPaper [1, 2, 3] 9 false) "the decision counts" "never acted on"}; an AC of another paper: {yesNo (decisionCounts acsOfPaper [1, 2, 3] 3 false) "the decision counts" "never acted on"}" },
    { id := "X10", text := "An author is the sole nominee of 4 papers and misses every review", deps := [.q11],
      outcome := fun _ r =>
        let ss := (List.range 4).map fun i => ({ paper := 10 + i, owed := 1, done := 0 } : Share)
        s!"{if casesFor ss == 1 then "one case" else "no case"} listing the {(unmetPapers ss).length} papers; {consequence r}" },
    -- assignment
    { id := "P1", text := "Two seniors and two juniors", deps := [.q13],
      outcome := fun _ r => yesNo (compositionOk r [{ who := 1, tier := some .senior }, { who := 2, tier := some .senior },
        { who := 3, tier := some .junior }, { who := 4, tier := some .junior }]) "meets composition" "fails composition" },
    { id := "P2", text := "Two seniors and one accepted nominee the AC classified junior", deps := [.q13, .q14],
      outcome := fun _ r => yesNo (compositionOk r [{ who := 1, tier := some .senior }, { who := 2, tier := some .senior },
        { who := 3, tier := some .junior, nominee := true }]) "meets composition" "fails composition" },
    { id := "P3", text := "Two seniors and nobody else", deps := [.q13],
      outcome := fun _ r => yesNo (compositionOk r [{ who := 1, tier := some .senior }, { who := 2, tier := some .senior }])
        "meets composition" "fails composition" },
    { id := "P4", text := "The authors of A and B are each the best match for the other's paper", deps := [],
      outcome := fun p _ =>
        let authorOf : Nat → List PersonId := fun x => if x == 1 then [10] else if x == 2 then [20] else []
        s!"{twoCycles p [(10, 2), (20, 1)] authorOf} reciprocal 2-cycle(s) found and broken" },
    { id := "P6", text := "Two seniors, a reciprocal nominee junior who owes a review and a PC junior can sit on a paper under zero to two juniors; and the same with only one senior",
      deps := [.q13], venueDeps := ["junior-seats", "reviewer-target"],
      outcome := fun _ r =>
        let m := r.venue.juniorSeats
        let cap := thirdCap r
        let sit (seniors : Nat) :=
          let nom := juniorRoom m r.venue.reviewerTarget true cap seniors 0 |>.min 1
          let pc := juniorRoom m r.venue.reviewerTarget false cap seniors nom |>.min 1
          s!"{nom + pc} junior seat(s) ({nom} reciprocal, {pc} PC)"
        if r.q13 == .zeroToTwoJuniors then s!"two seniors: {sit 2}; one senior: {sit 1}" else s!"the optional seats do not exist: {thirdSlots r} third seat a paper" },
    { id := "P5", text := "A plan is confirmed, but its dry run failed", deps := [],
      outcome := fun p _ => yesNo (mayApply p { dryRunOk := false, confirmed := true }) "applied" "refused" },
    -- screening
    { id := "E3", text := "The artifact README names the authors' lab; found in screening; no fix offered yet", deps := [.q1],
      outcome := fun p r =>
        let ref : Referral := { refAt .anonymity .screening with remedyOffered := false }
        s!"{yesNo (acMayKeep r .anonymity) "the AC may keep it" "the AC may not keep it"}; if referred, {removable p r ref}" },
    { id := "E3b", text := "The chair offers the fix at hour 0 and the author does not cure it; asked at the last hour of the window and an hour later",
      deps := [.q1], venueDeps := ["remedy-window-h"],
      outcome := fun p r =>
        let w := r.venue.remedyWindowH
        let ref : Referral := { refAt .anonymity .screening with remedyOffered := true, remedyDue := remedyDueAt w 0 }
        s!"at hour {w}: {removable p r { ref with now := w }}; at hour {w + 1}: {removable p r { ref with now := w + 1 }}" },
    { id := "E4", text := "A self-reveal is found during review, before reviews are released", deps := [.q3],
      outcome := fun p r => removable p r (refAt .anonymity .inReview) },
    { id := "E4b", text := "A self-reveal is found after reviews are released", deps := [.q3],
      outcome := fun p r => removable p r (refAt .anonymity .released) },
    { id := "E4c", text := "A scope problem is found during review", deps := [.q3],
      outcome := fun p r => removable p r (refAt .scope .inReview) },
    { id := "E6", text := "Two references exist in no index; the AC refers; a senior agrees", deps := [.q6],
      outcome := fun p r => removable p r (refAt .fabricatedReference .screening) },
    { id := "E7", text := "The AC refers a format violation; one senior PC member agrees", deps := [.q2],
      outcome := fun p r => removable p r (refAt .format .screening [senior 2]) },
    { id := "E7b", text := "The AC refers a format violation; another AC agrees", deps := [.q2],
      outcome := fun p r => removable p r (refAt .format .screening [{ who := 3, isAc := true }]) },
    { id := "E7c", text := "The AC refers a format violation; two seniors and a junior agree", deps := [.q2],
      outcome := fun p r => removable p r (refAt .format .screening [senior 2, senior 3, junior 4]) },
    { id := "E7d", text := "The AC refers a format violation and nobody else is asked", deps := [.q2],
      outcome := fun p r => removable p r (refAt .format .screening []) },
    { id := "E8", text := "The AC refers; the second opinion disagrees", deps := [.q5, .q2],
      outcome := fun p r =>
        let ref := refAt .format .screening [{ senior 2 with agrees := false }]
        s!"{removable p r ref}; the second-opinion member {yesNo (r.q5 == .reviews) "reviews it" "does not review it"}" },
    { id := "E9", text := "The AC refers; the only agreement is the AC's own", deps := [.q2],
      outcome := fun p r => removable p r (refAt .format .screening [senior 1 (isAc := true)]) },
    { id := "E11", text := "The AC refers; nobody answers the second-opinion request for 3 days", deps := [.q2],
      outcome := fun p r => removable p r { refAt .format .screening [] with askedAt := 0, now := 80 } },
    -- early reject
    { id := "R1", text := "Three rejects; one reviewer bumps within the window", deps := [.q16],
      outcome := fun p r => yesNo (mayEarlyReject p r { scores := [.reject, .reject, .reject], bumped := true, windowClosed := true })
        "early rejected" "continues to author response" },
    { id := "R2", text := "Three rejects; the window is still open", deps := [.q16],
      outcome := fun p r => yesNo (mayEarlyReject p r { scores := [.reject, .reject, .reject] })
        "early rejected" "waits for the window to close" },
    { id := "R3", text := "Reject, reject, weak reject", deps := [.q15],
      outcome := fun p r => yesNo (mayEarlyReject p r { scores := [.reject, .reject, .weakReject], windowClosed := true })
        "early rejected" "continues to author response" },
    { id := "R4", text := "Reject, weak reject, borderline", deps := [.q15],
      outcome := fun p r => yesNo (mayEarlyReject p r { scores := [.reject, .weakReject, .borderline], windowClosed := true })
        "early rejected" "continues to author response" },
    -- accountability requests
    { id := "C1", text := "An AC sends a request; the reviewer revises the review", deps := [],
      outcome := fun p _ =>
        let (e, n) := engagement p [{ reviewer := 5, sentBy := some 1, replied := true, disp := some .revised }] [] 5
        s!"engaged {e}, not engaged {n}" },
    { id := "C2", text := "The reviewer replies that the review stands, with reasons the AC accepts", deps := [],
      outcome := fun p _ =>
        let (e, n) := engagement p [{ reviewer := 5, sentBy := some 1, replied := true, disp := some .explained }] [] 5
        s!"engaged {e}, not engaged {n}" },
    { id := "C3", text := "A request gets no reply; a reminder; the grace period passes", deps := [],
      venueDeps := ["acc-grace-h"],
      outcome := fun _ r =>
        let q : Request := { reviewer := 5, sentBy := some 1, remindedAt := some 50 }
        let g := r.venue.accGraceH
        let end_ := q.due + g   -- the last hour inside the grace period
        let before := end_ - 6
        s!"no-reply may be recorded at hour {before}: {mayDispose g q .noReply before}; at hour {end_ + 1}: {mayDispose g q .noReply (end_ + 1)}" },
    { id := "C4", text := "The AC dismisses a heuristic suggestion", deps := [],
      outcome := fun p _ =>
        let (e, n) := engagement p [] [{ reviewer := 5, dismissed := true }] 5
        s!"engaged {e}, not engaged {n}" },
    { id := "C5", text := "The reviewer contests the criteria themselves", deps := [],
      outcome := fun p _ =>
        let (e, n) := engagement p [{ reviewer := 5, sentBy := some 1, replied := true, disp := some .disputed }] [] 5
        s!"a junior's request goes to {escalationTarget (some .junior)}, anyone else's to {escalationTarget (some .senior)}; engaged {e}, not engaged {n}" },
    { id := "C6", text := "An accepted nominee wrote two thin reviews; nobody sent a request", deps := [.q20],
      outcome := fun p r => yesNo (caseMayOpen p r false []) "a quality case may open" "no case; send a request first" },
    { id := "C8", text := "A heuristic flagged a nominee's review; nobody sent it; no reply was recorded", deps := [.q20],
      outcome := fun p r => yesNo (caseMayOpen p r false [{ reviewer := 5, sentBy := none, disp := some .noReply }])
        "a quality case may open" "no case; send a request first" },
    { id := "S12", text := "A PC member submits their review of a paper the AC referred and then kept", deps := [.q4],
      outcome := fun _ r => match r.q4 with
        | .never => "they never see the screening record"
        | .afterOwnReview => "they now see the screening record and are asked for feedback on the triage"
        | .always => "they saw the screening record from assignment" },
    { id := "S12b", text := "A PC member opens a paper the AC referred and then kept, before writing their review", deps := [.q4],
      outcome := fun _ r => if r.q4 == .always then "the screening record is shown" else "the screening record is hidden" },
    { id := "C7", text := "The conference ends", deps := [.q21],
      outcome := fun _ r => if r.q21 == .thisConference then "engagement records deleted" else "a summary goes to the next chairs" } ]

/-! ### Answers -/

structure Scale where
  papers : Nat := 4000
  areas : Nat := 20
  seniors : Nat := 450
  juniors : Nat := 300
  nomineeAcceptPct : Nat := 80
  nomineeSeniorPct : Nat := 35
  pcAuthorPct : Nat := 30
  deriving Repr, Inhabited

structure Answers where
  given : List (QId × Nat) := []
  scale : Scale := {}
  venue : Venue := {}
  errors : List String := []

def Answers.get? (a : Answers) (q : QId) : Option Nat := (a.given.find? (·.1 == q)).map (·.2)

def parseAnswers (text : String) : Answers := Id.run do
  let mut a : Answers := {}
  for raw in text.splitOn "\n" do
    let line := ((raw.splitOn "#").headD "").trimAscii.toString
    if line.isEmpty then continue
    match line.splitOn "=" with
    | [k, v] =>
      let k := k.trimAscii.toString
      let v := v.trimAscii.toString
      if k == "venue.junior-seats" then
        match JuniorSeats.ofKey? v with
        | some m => a := { a with venue := { a.venue with juniorSeats := m } }
        | none => a := { a with errors := a.errors ++ [s!"{k}: not one of fill, when-short, reciprocal-only: {v}"] }
      else if k.startsWith "venue." then
        match v.toNat? with
        | none => a := { a with errors := a.errors ++ [s!"{k}: not a number: {v}"] }
        | some n =>
          match k with
          | "venue.nominees-max" => a := { a with venue := { a.venue with nomineesMax := n } }
          | "venue.pattern-min" => a := { a with venue := { a.venue with patternMin := n } }
          | "venue.acc-grace-h" => a := { a with venue := { a.venue with accGraceH := n } }
          | "venue.reviewer-target" => a := { a with venue := { a.venue with reviewerTarget := n } }
          | "venue.remedy-window-h" => a := { a with venue := { a.venue with remedyWindowH := n } }
          | _ => a := { a with errors := a.errors ++ [s!"unknown venue parameter {k}"] }
      else if k.startsWith "scale." then
        let n := v.toNat!
        let s := a.scale
        a := { a with scale := match k with
          | "scale.papers" => { s with papers := n } | "scale.areas" => { s with areas := n }
          | "scale.seniors" => { s with seniors := n } | "scale.juniors" => { s with juniors := n }
          | "scale.nominee-accept-pct" => { s with nomineeAcceptPct := n }
          | "scale.nominee-senior-pct" => { s with nomineeSeniorPct := n }
          | "scale.pc-author-pct" => { s with pcAuthorPct := n }
          | _ => s }
      else
        match QId.all.find? (·.code == k) with
        | none => a := { a with errors := a.errors ++ [s!"unknown question {k}"] }
        | some q =>
          match indexIn (q.labels.map (·.1)) v with
          | i => if i < q.count then a := { a with given := a.given ++ [(q, i)] }
                 else a := { a with errors := a.errors ++ [s!"{k}: unknown reading {v}; one of {q.labels.map (·.1)}"] }
    | _ => a := { a with errors := a.errors ++ [s!"cannot read: {line}"] }
  return a

/-- The reading the model uses: answered questions as answered, open ones at their first reading. -/
def Answers.base (a : Answers) : Reading :=
  a.given.foldl (fun r (q, i) => r.set q i) { venue := a.venue }

/-! ### Narrowing -/

def combos : List (QId × List Nat) → List (List (QId × Nat))
  | [] => [[]]
  | (q, vs) :: rest => vs.flatMap fun v => (combos rest).map ((q, v) :: ·)

def withAll (r : Reading) (xs : List (QId × Nat)) : Reading := xs.foldl (fun r (q, i) => r.set q i) r

def remOf (rem : List (QId × List Nat)) (q : QId) : List Nat :=
  ((rem.find? (·.1 == q)).map (·.2)).getD (List.range q.count)

def outcomesOver (c : Card) (base : Reading) (rem : List (QId × List Nat)) : List String :=
  ((combos (c.deps.map fun q => (q, remOf rem q))).map fun xs => c.outcome {} (withAll base xs)).eraseDups

structure Asked where
  card : Card
  options : Nat
  answer : String
  left : List (QId × Nat)

/-- Ask the splitting cards for the answered questions, most distinct outcomes first. -/
def narrow (a : Answers) : List Asked × List (QId × List Nat) := Id.run do
  let base := a.base
  let mut rem : List (QId × List Nat) := QId.all.map fun q => (q, List.range q.count)
  let mut asked : List Asked := []
  for _ in [0:40] do
    let useful := cards.filter fun c =>
      !c.deps.isEmpty && c.deps.all (a.get? · |>.isSome) && (outcomesOver c base rem).length > 1
    match useful with
    | [] => break
    | c0 :: rest =>
      let best := rest.foldl (fun b c => if (outcomesOver c base rem).length > (outcomesOver b base rem).length then c else b) c0
      let n := (outcomesOver best base rem).length
      let ans := best.outcome {} base
      let cs := (combos (best.deps.map fun q => (q, remOf rem q))).filter fun xs => best.outcome {} (withAll base xs) == ans
      rem := rem.map fun (q, vs) =>
        if best.deps.contains q then (q, vs.filter fun v => cs.any fun xs => xs.contains (q, v)) else (q, vs)
      asked := asked ++ [{ card := best, options := n, answer := ans, left := best.deps.map fun q => (q, (remOf rem q).length) }]
  return (asked, rem)

/-- Cards whose outcome changes with question `q`. If it doesn't at the base
    reading, the other declared questions are varied, and the setting that
    makes the card split `q` is returned as a condition. -/
def splitters (base : Reading) (q : QId) : List (Card × List (QId × Nat) × List (String × String)) :=
  (cards.filter (·.deps.contains q)).filterMap fun c =>
    let others := c.deps.filter (· != q)
    let settings := [] :: (combos (others.map fun o => (o, List.range o.count))).filter (· != [])
    settings.findSome? fun xs =>
      let r := withAll base xs
      let outs := (List.range q.count).map fun i => (q.readingName i, c.outcome {} (r.set q i))
      if (outs.map (·.2)).eraseDups.length > 1 then
        some (c, xs.filter (fun (o, v) => base.get o != v), outs)
      else none

/-- Legibility: a card's outcome must not change with a question it doesn't declare. -/
def legibilityViolations (base : Reading) : List (String × String) :=
  cards.flatMap fun c =>
    (QId.all.filter (!c.deps.contains ·)).filterMap fun q =>
      let outs := ((List.range q.count).map fun i => c.outcome {} (base.set q i)).eraseDups
      if outs.length > 1 then some (c.id, q.code) else none

/-! ### Mutation -/

structure Mutant where
  name : String
  params : Params

def mutants : List Mutant :=
  [ { name := "second opinion from anyone, including the AC", params := { secondOpinionFromAnyone := true } },
    { name := "silence removes (no answer in 72 h counts as agreement)", params := { silenceRemoves := true } },
    { name := "assign someone the AC hasn't accepted", params := { assignUnaccepted := true } },
    { name := "combine ignores the Q18 reading", params := { combineIgnoresQ18 := true } },
    { name := "a declined nominee's share moves to someone the authors didn't name", params := { declinedShareToUnnamed := true } },
    { name := "early reject before the window closes", params := { earlyRejectBeforeWindowCloses := true } },
    { name := "a dismissed suggestion counts against the reviewer", params := { dismissedSuggestionCounts := true } },
    { name := "a heuristic suggestion is sent without an AC", params := { heuristicSendsItself := true } },
    { name := "apply without a dry run", params := { applyWithoutDryRun := true } },
    { name := "cycle-free with K = 1", params := { cycleK1 := true } } ]

def killingCards (m : Mutant) (r : Reading) : List String :=
  (cards.filter fun c => c.outcome m.params r != c.outcome {} r).map (·.id)

/-- For a mutant no card kills at the answered reading: a one-question change
    of reading under which a card would kill it. If none exists, the mutant is
    equivalent at this reading for every card. -/
def killedElsewhere (m : Mutant) (base : Reading) : Option (QId × Nat × List String) :=
  QId.all.findSome? fun q =>
    (List.range q.count).findSome? fun v =>
      if v == base.get q then none else
      match killingCards m (base.set q v) with
      | [] => none
      | ks => some (q, v, ks)

/-- The proved properties, as executable predicates over sample states, so a
    mutant that breaks one is caught even without a card. -/
def sampleRefs : List Referral :=
  [ refAt .format .screening [], refAt .format .screening [senior 1 (isAc := true)],
    refAt .format .screening [{ senior 2 with conflicted := true }],
    { refAt .format .screening [] with now := 80 } ]

def brokenProperties (p : Params) (r : Reading) : List String :=
  let s1 := sampleRefs.all fun ref =>
    !mayRemove p r ref || ref.opinions.any fun o => o.agrees && o.who != ref.ac && !o.conflicted
  let s8 := sampleRefs.all fun ref => !mayRemove p r ref || !ref.opinions.isEmpty
  let v1 := !eligible p { who := 7, tier := some .junior, accepted := false } {}
  let v2 := !movedToUnnamed p r (noms 1 [{ who := 7, share := 3 }, { who := 8, share := 3, accepted := false }])
  let e1 := !mayEarlyReject p r { scores := [.reject, .reject, .reject] } || r.q16 == .noWindow
  let ar2 := (sentRequests p [{ reviewer := 5, sentBy := none }]).isEmpty
  let ar4 := engagement p [] [{ reviewer := 5, dismissed := true }] 5 == engagement p [] [] 5
  let h2 := !mayApply p { dryRunOk := false, confirmed := true }
  let a3 := twoCycles p [(10, 2), (20, 1)] (fun x => if x == 1 then [10] else if x == 2 then [20] else []) > 0
  [("S1", s1), ("S8", s8), ("V1", v1), ("V2", v2), ("E-1", e1), ("AR2", ar2), ("AR4", ar4), ("H2", h2), ("A3", a3)].filterMap
    fun (n, ok) => if ok then none else some n

/-- Properties the mutant breaks that the signed model, at the same reading, keeps. -/
def mutantBreaks (m : Mutant) (r : Reading) : List String :=
  (brokenProperties m.params r).filter fun n => !(brokenProperties {} r).contains n

/-- Properties a reading itself violates (on the signed model): a ◆ property
    that fails under some reading rules that reading out unless the property is dropped. -/
def readingViolations (base : Reading) : List (String × String) :=
  QId.all.flatMap fun q =>
    (List.range q.count).filterMap fun i =>
      let r := base.set q i
      match brokenProperties {} r with
      | [] => none
      | bs => some (s!"{q.code} = {q.readingName i}", ", ".intercalate bs)

/-! ### A synthetic conference -/

def lcg (x : UInt64) : UInt64 := x * 6364136223846793005 + 1442695040888963407
def hash2 (a b : Nat) : Nat := ((lcg (lcg (UInt64.ofNat (a * 1000003 + b)))) >>> 32).toNat

structure Conf where
  nPapers : Nat
  nPc : Nat
  paperArea : Array Nat
  authors : Array (List PersonId)
  personArea : Array Nat
  pcTier : Array (Option Tier)          -- for PC members; none for others
  nominees : Array (List Nominee)       -- per paper
  nomineeTier : Array (Option Tier)     -- the AC's classification, per person
  scores : Array (List Score)

def synth (s : Scale) (r : Reading) : Conf := Id.run do
  let nPc := s.seniors + s.juniors
  let nAuth := s.papers * 3 / 2
  let nPeople := nPc + nAuth
  let mut personArea := Array.replicate nPeople 0
  let mut pcTier := Array.replicate nPeople none
  for u in [0:nPeople] do
    personArea := personArea.set! u (hash2 u 1 % s.areas)
    if u < s.seniors then pcTier := pcTier.set! u (some .senior)
    else if u < nPc then pcTier := pcTier.set! u (some .junior)
  let mut paperArea := Array.replicate s.papers 0
  let mut authors := Array.replicate s.papers []
  let mut nominees := Array.replicate s.papers []
  let mut nomineeTier : Array (Option Tier) := Array.replicate nPeople none
  let mut scores := Array.replicate s.papers []
  for pp in [0:s.papers] do
    let area := hash2 pp 2 % s.areas
    paperArea := paperArea.set! pp area
    let nA := 3 + hash2 pp 3 % 3
    let mut au : List PersonId := []
    for j in [0:nA] do
      au := au ++ [nPc + hash2 pp (10 + j) % nAuth]
    if hash2 pp 4 % 100 < s.pcAuthorPct then au := au ++ [hash2 pp 5 % nPc]
    au := au.eraseDups
    authors := authors.set! pp au
    let candidates := au.filter (· ≥ nPc)
    let want := if r.q8 == .one then 1 else 2
    let chosen := candidates.take want
    let shares := if chosen.length == 2 then [4, 2] else [6]
    let mut ns : List Nominee := []
    for (u, sh) in chosen.zip shares do
      let acc := hash2 u 6 % 100 < s.nomineeAcceptPct
      ns := ns ++ [{ who := u, share := sh, accepted := acc }]
      if acc then
        nomineeTier := nomineeTier.set! u (some (if hash2 u 7 % 100 < s.nomineeSeniorPct then .senior else .junior))
        personArea := personArea.set! u area
    nominees := nominees.set! pp ns
    let quality := hash2 pp 8 % 100
    let mut sc : List Score := []
    for j in [0:3] do
      let x := (hash2 pp (20 + j) % 100 + quality) / 2
      sc := sc ++ [if x < 22 then .strongReject else if x < 34 then .reject else if x < 46 then .weakReject
        else if x < 56 then .borderline else if x < 70 then .weakAccept else if x < 85 then .accept else .strongAccept]
    scores := scores.set! pp sc
  return { nPapers := s.papers, nPc, paperArea, authors, personArea, pcTier, nominees, nomineeTier, scores }

end ReviewProcess
