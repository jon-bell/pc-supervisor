import ReviewProcess
open ReviewProcess

def pct (a b : Nat) : String := if b == 0 then "n/a" else s!"{a * 100 / b}%"

def showOutcome (name : String) (o : Outcome) (n : Nat) : String :=
  s!"- {name}: composed {o.composed}/{n} ({pct o.composed n}); senior slots unfilled {o.seniorShort}; " ++
  s!"third slots unfilled {o.thirdShort}; senior reviews needed {o.seniorReviewsNeeded} vs capacity {o.seniorCapacity}; " ++
  s!"accepted nominees {o.nominees}, mean owed {showSixths o.meanOwedSixths}, reviews by nominees {o.nomineeReviews}, " ++
  s!"nominees at or above what they owe {pct o.nomineesAtOwed o.nominees}, max nominee load {o.maxNomineeLoad}; " ++
  s!"reviews outside the paper's area {o.crossArea}; reciprocal 2-cycles {o.cyclesFirst} before repair, " ++
  s!"{o.repairs} edges forbidden, {o.cycles} left; load-band violations {o.loadViolations}; " ++
  s!"candidate edges {o.candidateEdges}, objective {o.objective}"

def showCell (c : Cell) : String := c.show.replace "|" "/"

def main (args : List String) : IO Unit := do
  let path := args.headD "answers/synthetic.txt"
  let a := parseAnswers (← IO.FS.readFile path)
  let base := a.base
  IO.println "# Review process: model report"
  IO.println s!"answers file: {path}"
  for e in a.errors do IO.println s!"  ! {e}"
  IO.println s!"questions in the model: {QId.all.length}; readings of the whole text: {readingCount}"
  IO.println s!"answered: {a.given.length}; open: {QId.all.length - a.given.length}"
  IO.println s!"venue parameters: nominees per paper at most {base.venue.nomineesMax} (Q8 \"up to n\"); pattern shown at {base.venue.patternMin} nominations (Q9); accountability grace period {base.venue.accGraceH} h (AR5); Q1 fix window {base.venue.remedyWindowH} h"
  IO.println "not in the model (no rule depends on them yet): Q9 (who may be nominated), Q12 (withholding reviews)"

  IO.println "\n## Legibility: does any card depend on a question it doesn't declare?"
  match legibilityViolations base with
  | [] => IO.println "none"
  | vs => for (c, q) in vs do IO.println s!"- {c} also depends on {q}"

  IO.println "\n## Answered questions: the cards that confirm each answer"
  let (asked, rem) := narrow a
  let mut i := 1
  for x in asked do
    IO.println s!"{i}. [{x.card.id}] {x.card.text}"
    IO.println s!"    outcomes the readings then in play give: {x.options}; the chairs' answer: {x.answer}"
    IO.println s!"    readings left: {", ".intercalate (x.left.map fun (q, n) => s!"{q.code} {n}")}"
    i := i + 1
  let pinned := a.given.filter fun (q, _) => (remOf rem q).length == 1
  IO.println s!"answered questions pinned to one reading by cards: {pinned.length} of {a.given.length}"
  for (q, v) in a.given do
    let left := remOf rem q
    if left.length > 1 then
      let blocked := (cards.filter fun c => c.deps.contains q && c.deps.any (a.get? · |>.isNone)).map fun c =>
        s!"{c.id} (also needs {(c.deps.filter (a.get? · |>.isNone)).map QId.code})"
      IO.println s!"- {q.code} answered \"{q.readingName v}\" is not yet confirmed by a card; it is still indistinguishable from {(left.filter (· != v)).map q.readingName}. Cards that would separate it but depend on open questions: {blocked}"

  IO.println "\n## Open questions: cards to bring, with the outcome under each reading"
  for q in QId.all do
    if (a.get? q).isNone then
      IO.println s!"### {q.code}: {q.text}"
      match splitters base q with
      | [] => IO.println "  (no card splits it yet)"
      | ss =>
        for (c, cond, outs) in ss do
          let when := if cond.isEmpty then "" else
            " (splits it only if " ++ ", ".intercalate (cond.map fun (o, v) => s!"{o.code} = {o.readingName v}") ++ ")"
          IO.println s!"  [{c.id}] {c.text}{when}"
          for (rn, o) in outs do IO.println s!"      if {rn}: {o}"

  IO.println "\n## Readings that break a proved property"
  for (rd, ps) in readingViolations base do IO.println s!"- {rd}: breaks {ps}"

  IO.println "\n## Policy (concepts.md §3.9) at the answered reading"
  IO.println "Cells marked † are set by a ruling; they show the question and the result at this reading. A dot is denied and not yet examined."
  IO.println s!"| Permission | {" | ".intercalate (Role.all.map Role.name)} |"
  IO.println s!"|---|{String.join (Role.all.map fun _ => "---|")}"
  for pm in Perm.all do
    IO.println s!"| {pm.name} | {" | ".intercalate (Role.all.map fun ro => showCell (policy base ro pm))} |"

  IO.println "\n## L1 and L2: trace search over the policy and the rules (signed model, answered reading)"
  IO.println "Every step is taken by a role whose cell is granted (theorem gated_requires_policy); the rules decide whether it has an effect."
  let results := searchAll {} base
  let mut exercised : List (Role × Perm) := []
  let mut l2fail := 0
  for res in results do
    IO.println s!"### {res.sys}: {res.states} states{if res.truncated then " (TRUNCATED)" else ""}"
    for g in res.goals do
      match g.admitted, g.found with
      | true, some t => IO.println s!"- L2 {g.name}: reachable: {t}"
      | true, none => do IO.println s!"- L2 {g.name}: UNREACHABLE although the reading admits it"; l2fail := l2fail + 1
      | false, none => IO.println s!"- {g.name}: not admitted at this reading, and unreachable"
      | false, some t => do IO.println s!"- {g.name}: REACHABLE although the reading does not admit it: {t}"; l2fail := l2fail + 1
    for ((ro, pm), t) in res.uses do
      exercised := exercised ++ [(ro, pm)]
      IO.println s!"- L1 {ro.name} / {pm.name}: {t}"
  let granted := Perm.all.flatMap fun pm => (Role.all.filter fun ro => (policy base ro pm).granted).map (·, pm)
  let gaps := granted.filter fun (ro, pm) => modeledPerms.contains pm && !exercised.contains (ro, pm)
  let unmodeled := granted.filter fun (_, pm) => !modeledPerms.contains pm
  IO.println s!"granted cells: {granted.length}; exercised by a trace: {(granted.filter exercised.contains).length}; L2 failures: {l2fail}"
  IO.println "granted cells on a modeled action that no trace exercises (each is a gap in the model or a cell to deny):"
  for (ro, pm) in gaps do IO.println s!"- {ro.name} / {pm.name}: {(policy base ro pm).show}"
  IO.println s!"granted visibility and configuration cells (no action in the model; enforced by views and the information-flow properties): {unmodeled.length}"

  IO.println "\n## Mutation of the signed specification (at the answered reading)"
  let mut alive : List String := []
  for m in mutants do
    let ks := killingCards m base
    let ps := mutantBreaks m base
    let how := (if ks.isEmpty then [] else [s!"cards {ks}"]) ++ (if ps.isEmpty then [] else [s!"properties {ps}"])
    let note := if !ks.isEmpty then "" else
      match killedElsewhere m base with
      | some (q, v, ks') => s!" — equivalent to the signed model at this reading for every card; card(s) {ks'} would kill it if {q.code} = {q.readingName v}"
      | none => " — no card kills it under any one-question change of reading"
    IO.println s!"- {m.name}: {if how.isEmpty then "SURVIVES" else "killed by " ++ "; ".intercalate how}{note}"
    if ks.isEmpty then alive := alive ++ [m.name]
  IO.println s!"mutants: {mutants.length}; not killed by any card at this reading: {alive.length}"

  IO.println "\n## Consequences on a synthetic conference (the Plan solver: min-cost max-flow, spec §10.5)"
  let (trials, bad) := selfCheck
  IO.println s!"solver self-check: {trials} small random instances against brute force, {bad} disagreements"
  IO.println s!"network: top {topK} candidates per paper slot by affinity, in the paper's area and the two neighboring areas; up to {maxRepairRounds} rounds of cycle repair. Unfilled slots are what no assignment can fill from these candidates under the load bands."
  let s := a.scale
  IO.println s!"scale: {s.papers} papers, {s.areas} areas, {s.seniors} senior and {s.juniors} junior PC, nominees accepted {s.nomineeAcceptPct}%, classified senior {s.nomineeSeniorPct}%; bands: senior {bandMax .senior}, junior {bandMax .junior}; k = {k}"
  let conf := synth s base
  let variants : List (String × Reading) := ("the answered reading", base) ::
    ([QId.q14, .q13, .q18].flatMap fun q => ((List.range q.count).filter (· != base.get q)).map fun v =>
      (s!"if {q.code} = {q.readingName v}", base.set q v))
  let zeroToTwo := indexIn (QId.q13.labels.map (·.1)) "zero-to-two-juniors"
  let variants := variants ++ JuniorSeats.all.map fun m =>
    (s!"if Q13 = zero to two juniors and junior seats = {m.key}", { base.set .q13 zeroToTwo with venue := { base.venue with juniorSeats := m } })
  -- the solves are independent; run them in parallel
  let tasks := variants.map fun (name, r) => (name, Task.spawn fun _ => runConf r conf)
  for (name, t) in tasks do IO.println (showOutcome name t.get s.papers)
  IO.println "early reject, share of papers whose initial reviews are all negative:"
  for v in List.range QId.q15.count do
    let r := base.set .q15 v
    let n := (List.range s.papers).countP fun pp => mayEarlyReject {} r { scores := conf.scores[pp]!, windowClosed := true }
    IO.println s!"- {QId.q15.readingName v}: {pct n s.papers}"

  IO.println "\n## Proved in Lean (ReviewProcess/Properties.lean), for every reading unless noted"
  for t in [ "S1 two-person removal (unless Q2 = the AC alone): s1_two_person, s1_removal",
             "S8 silence never removes; only a chair removes: s8_only_remove, s8_only_chair",
             "S9 removal only at a stage Q3 allows; none after release unless Q3 says any stage: s9_stage, s9_after_release",
             "S10 the Q1 fix window is honored: s10_remedy",
             "Q6 evidence-only reading: a fabricated reference alone never removes: q6_evidence_only",
             "E-1 early reject only on all-negative reviews, no objection, window closed: e1_early_reject",
             "V1 only accepted, consented, unconflicted non-authors are eligible: v1_eligible",
             "Q14 nominee-not-senior: two non-nominee seniors per composed paper: q14_two_real_seniors",
             "V2 (part) a declined share never moves to an unnamed reviewer: v2_no_unnamed",
             "H2 nothing applied without a passing dry run: h2_dry_run",
             "AR2 every counted request was sent by a person: ar2_sent_by_person",
             "AR4 suggestions never change the engagement record: ar4_dispositions_only",
             "AR5 no-reply only after reminder, due date, and grace: ar5_no_reply",
             "AR6 under Q20 = yes, a quality case needs an earlier unanswered or declined request: ar6_request_first",
             "Policy: every trace step is by a role whose cell is granted: gated_requires_policy, env_has_no_perms",
             "S6 the screening agent is granted nothing: s6_agent_granted_nothing",
             "S1/S8 only a PC chair removes: only_pc_chair_removes",
             "AR2 only an AC or the junior PC chair sends requests: only_people_send_requests",
             "H2 only chairs apply a Writeback; PCS never writes HotCRP: only_chairs_apply, pcs_never_writes",
             "Nothing leaves the system: nothing_outside; C2 authors see no findings or identities: authors_see_no_findings",
             "S12 under Q4 = never, no reviewer sees the screening record: q4_never_hides",
             "A2/V1 for the solver: every planned edge is eligible and unforbidden, whatever the flow: a2_plan_eligible" ] do
    IO.println s!"- {t}"
