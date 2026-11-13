import ReviewProcess.Model
/-
  The properties of docs/concepts.md §3.10 that the model proves, for every
  reading unless a hypothesis names one. `{}` is the signed model (no mutant).
  Properties that are checked rather than proved (V2, V5, A1, A3) are in
  Validate.lean, run on the examples and on a synthetic conference.
-/
namespace ReviewProcess

/-! ### Desk reject -/

theorem valid_spec {ref : Referral} {o : Opinion} (h : o ∈ validOpinions {} ref) :
    o ∈ ref.opinions ∧ o.agrees = true ∧ o.who ≠ ref.ac ∧ o.conflicted = false := by
  simp only [validOpinions, List.mem_filter, Bool.and_eq_true, Bool.or_eq_true, bne_iff_ne,
    Bool.not_eq_true'] at h
  obtain ⟨hm, ha, hb⟩ := h
  refine ⟨hm, ha, ?_, ?_⟩
  · rcases hb with hb | hb
    · exact absurd hb (by decide)
    · exact hb.1
  · rcases hb with hb | hb
    · exact absurd hb (by decide)
    · exact hb.2

/-- S1 ◆: unless Q2 is "the AC alone", a removal needs someone other than the
    referring AC, unconflicted, who agreed. -/
theorem s1_two_person (r : Reading) (ref : Referral) (hq : r.q2 ≠ .acAlone)
    (h : twoPerson {} r ref = true) :
    ∃ o ∈ ref.opinions, o.agrees = true ∧ o.who ≠ ref.ac ∧ o.conflicted = false := by
  have hne : (validOpinions {} ref).isEmpty = false := by
    unfold twoPerson at h
    split at h
    · rename_i heq; exact absurd heq hq
    · simp only [Bool.and_eq_true, Bool.not_eq_true'] at h; exact h.1
  clear h
  cases hv : validOpinions {} ref with
  | nil => simp [hv] at hne
  | cons o t =>
    have hm : o ∈ validOpinions {} ref := by rw [hv]; exact List.mem_cons_self
    exact ⟨o, (valid_spec hm).1, (valid_spec hm).2⟩

theorem mayRemove_parts {r : Reading} {ref : Referral} (h : mayRemove {} r ref = true) :
    twoPerson {} r ref = true ∧ groundAdmissible r ref = true ∧
      stageAllowed r.q3 ref.ground ref.stage = true ∧ remedyHonored r ref = true := by
  simp only [mayRemove, Bool.and_eq_true, Bool.or_eq_true] at h
  obtain ⟨⟨⟨h1, h2⟩, h3⟩, h4⟩ := h
  rcases h1 with h1 | h1
  · exact ⟨h1, h2, h3, h4⟩
  · simp at h1

/-- S1 ◆ on the process: a chair's removal that changes the disposition had two people behind it. -/
theorem s1_removal (r : Reading) (s : DRState) (hq : r.q2 ≠ .acAlone)
    (h : (drStep {} r s (.remove true)).disp ≠ s.disp) :
    ∃ o ∈ s.ref.opinions, o.agrees = true ∧ o.who ≠ s.ref.ac ∧ o.conflicted = false := by
  have e : drStep {} r s (.remove true) =
      (if (true && s.disp == .inReview && mayRemove {} r s.ref) = true
       then { s with disp := .removed s.ref.ground } else s) := rfl
  rw [e] at h
  split at h
  · rename_i hc
    simp only [Bool.and_eq_true] at hc
    exact s1_two_person r s.ref hq (mayRemove_parts hc.2).1
  · exact absurd rfl h

/-- S8: silence never removes. Only a chair's `remove` changes a disposition. -/
theorem s8_only_remove (p : Params) (r : Reading) (s : DRState) (a : DRAction)
    (h : ∀ b, a ≠ .remove b) : (drStep p r s a).disp = s.disp := by
  cases a with
  | remove b => exact absurd rfl (h b)
  | _ => rfl

theorem s8_only_chair (p : Params) (r : Reading) (s : DRState) :
    drStep p r s (.remove false) = s := by
  simp [drStep]

/-- S9: a desk reject happens only at a stage Q3 allows for its ground. -/
theorem s9_stage (r : Reading) (ref : Referral) (h : mayRemove {} r ref = true) :
    stageAllowed r.q3 ref.ground ref.stage = true :=
  (mayRemove_parts h).2.2.1

/-- S9, the release clause: under every reading of Q3 except the two "any stage"
    ones, nothing is desk rejected after reviews are released. -/
theorem s9_after_release (r : Reading) (ref : Referral) (h1 : r.q3 ≠ .anonAnyStage)
    (h2 : r.q3 ≠ .anyAnyStage) (hs : ref.stage = .released) : mayRemove {} r ref = false := by
  cases hm : mayRemove {} r ref with
  | false => rfl
  | true =>
    have := s9_stage r ref hm
    rw [hs] at this
    cases hq : r.q3 <;> simp_all [stageAllowed]

/-- S10: under Q1's fix window, an anonymity removal comes only after the remedy
    was offered, its due date passed, and it was not cured. -/
theorem s10_remedy (r : Reading) (ref : Referral) (hg : ref.ground = .anonymity)
    (hq : r.q1 = .fixWindow) (h : mayRemove {} r ref = true) :
    ref.remedyOffered = true ∧ ref.now > ref.remedyDue ∧ ref.cured = false := by
  have := (mayRemove_parts h).2.2.2
  simp [remedyHonored, hg, hq] at this
  exact ⟨this.1.1, this.1.2, this.2⟩

/-- The closed list of grounds: a fabricated reference is grounds only under Q6's "grounds". -/
theorem q6_evidence_only (r : Reading) (ref : Referral) (hg : ref.ground = .fabricatedReference)
    (hq : r.q6 = .evidence) : mayRemove {} r ref = false := by
  cases hm : mayRemove {} r ref with
  | false => rfl
  | true =>
    have := (mayRemove_parts hm).2.1
    simp [groundAdmissible, hg, hq] at this

/-! ### Early reject -/

/-- E-1 ◆: early reject only if every initial review is negative under Q15, no
    AC objection, and, with a bump window, after it closed with no bump. -/
theorem e1_early_reject (r : Reading) (c : ERCase) (h : mayEarlyReject {} r c = true) :
    (∀ s ∈ c.scores, negative r s = true) ∧ c.acObjects = false ∧
      (r.q16 = .bumpWindow → c.windowClosed = true ∧ c.bumped = false) := by
  simp only [mayEarlyReject, Bool.and_eq_true, Bool.or_eq_true, Bool.not_eq_true',
    List.all_eq_true, beq_iff_eq] at h
  obtain ⟨⟨⟨_, hall⟩, hobj⟩, hw⟩ := h
  refine ⟨hall, hobj, fun hb => ?_⟩
  rcases hw with hw | hw
  · rw [hb] at hw; exact absurd hw (by decide)
  · rcases hw with ⟨hc, hbump⟩
    rcases hc with hc | hc
    · exact ⟨hc, hbump⟩
    · exact absurd hc (by decide)

/-! ### The PC -/

/-- V1 ◆: only accepted, consented, unconflicted non-authors are eligible. -/
theorem v1_eligible (m : Member) (pf : PaperFacts) (h : eligible {} m pf = true) :
    m.accepted = true ∧ m.consented = true ∧ pf.authors.contains m.who = false ∧
      pf.conflicts.contains m.who = false := by
  simp only [eligible, Bool.and_eq_true, Bool.or_eq_true, Bool.not_eq_true'] at h
  obtain ⟨⟨⟨_, hacc⟩, ha⟩, hc⟩ := h
  rcases hacc with hacc | hacc
  · exact absurd hacc (by decide)
  · exact ⟨hacc.1, hacc.2, ha, hc⟩

/-- Q14's "nominee never senior": a composition that passes has two seniors who are not nominees. -/
theorem q14_two_real_seniors (r : Reading) (seats : List Member) (hq : r.q14 = .nomineeNotSenior)
    (h : compositionOk r seats = true) :
    (seats.filter fun m => m.tier == some .senior && !m.nominee).length ≥ 2 := by
  simp only [compositionOk, Bool.and_eq_true, decide_eq_true_eq] at h
  have e : fillsSenior r = fun m => m.tier == some .senior && !m.nominee := by
    have hf : (Q14.nomineeNotSenior == Q14.tierDecides) = false := by decide
    funext m; simp [fillsSenior, hq, hf]
  have h1 := h.1
  rw [e] at h1
  exact h1

/-- V2 (the part that is proved): a declined nominee's share never moves to
    someone the authors didn't name. -/
theorem v2_no_unnamed (r : Reading) (pn : PaperNoms) : movedToUnnamed {} r pn = false := by
  simp [movedToUnnamed]

/-! ### Writeback -/

/-- H2: nothing is applied without a confirmed, passing dry run. -/
theorem h2_dry_run (c : Change) (h : mayApply {} c = true) : c.confirmed = true ∧ c.dryRunOk = true := by
  simp only [mayApply, Bool.and_eq_true, Bool.or_eq_true] at h
  rcases h with ⟨hc, hd | hd⟩
  · exact ⟨hc, hd⟩
  · exact absurd hd (by decide)

/-! ### Accountability requests -/

/-- AR2 ◆: every request counted was sent by a person. -/
theorem ar2_sent_by_person (reqs : List Request) : ∀ q ∈ sentRequests {} reqs, q.sentBy.isSome = true := by
  intro q hq
  simp only [sentRequests, List.mem_filter, Bool.or_eq_true] at hq
  rcases hq.2 with h | h
  · exact h
  · exact absurd h (by decide)

/-- AR4 ◆: suggestions, dismissed or not, never change the engagement record. -/
theorem ar4_dispositions_only (reqs : List Request) (sugs : List Suggestion) (u : PersonId) :
    engagement {} reqs sugs u = engagement {} reqs [] u := by
  simp [engagement]

/-- AR5: "no reply" is recorded only after a reminder, the due date, and the grace period. -/
theorem ar5_no_reply (req : Request) (now : Time) (h : mayDispose req .noReply now = true) :
    req.replied = false ∧ req.remindedAt.isSome = true ∧ now > req.due + grace := by
  simp only [mayDispose, Bool.and_eq_true, Bool.not_eq_true', decide_eq_true_eq] at h
  exact ⟨h.1.1, h.1.2, h.2⟩

/-- AR6 ◆: under Q20's "yes", a quality case on a nominee needs an earlier request
    that a person sent and the reviewer declined or left unanswered. -/
theorem ar6_request_first (r : Reading) (reqs : List Request) (hq : r.q20 = .needsRequest)
    (h : caseMayOpen {} r false reqs = true) :
    ∃ q ∈ reqs, q.sentBy.isSome = true ∧ q.disp.any (·.notEngaged) = true := by
  simp only [caseMayOpen, hq, Bool.or_eq_true, Bool.false_eq_true, false_or, beq_iff_eq,
    List.any_eq_true] at h
  rcases h with h | ⟨q, hm, hd⟩
  · exact absurd h (by decide)
  · exact ⟨q, (List.mem_filter.mp hm).1, ar2_sent_by_person reqs q hm, hd⟩

end ReviewProcess
