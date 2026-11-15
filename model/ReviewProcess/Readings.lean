/-
  The open questions of docs/concepts.md §1, one type per question.
  A `Reading` picks one answer to every question. The chairs' answers live in
  an answers file outside the model (answers/*.txt), so the model holds no
  venue's decisions.
-/
namespace ReviewProcess

class Enum (α : Type) extends BEq α, Inhabited α where
  all : List α
  key : α → String
  desc : α → String

def indexIn {α : Type} [BEq α] : List α → α → Nat
  | [], _ => 0
  | x :: xs, a => if x == a then 0 else indexIn xs a + 1

def Enum.idx {α : Type} [Enum α] (a : α) : Nat := indexIn (Enum.all : List α) a
def Enum.ofIdx {α : Type} [Enum α] (i : Nat) : α := (Enum.all : List α).getD i default

inductive Q1 | rejectAtOnce | fixWindow | acDecides
  deriving DecidableEq, Repr, Inhabited
instance : Enum Q1 where
  all := [.rejectAtOnce, .fixWindow, .acDecides]
  key | .rejectAtOnce => "reject-at-once" | .fixWindow => "fix-window" | .acDecides => "ac-decides"
  desc | .rejectAtOnce => "reject at once" | .fixWindow => "fix window, then reject if uncured"
       | .acDecides => "the AC decides"

inductive Q2 | acPlusSenior | acPlusAc | vote | acAlone
  deriving DecidableEq, Repr, Inhabited
instance : Enum Q2 where
  all := [.acPlusSenior, .acPlusAc, .vote, .acAlone]
  key | .acAlone => "ac-alone" | .acPlusSenior => "ac-plus-senior" | .acPlusAc => "ac-plus-ac" | .vote => "vote"
  desc | .acAlone => "the AC alone" | .acPlusSenior => "AC triage, then one senior PC member agrees"
       | .acPlusAc => "AC plus a second AC" | .vote => "two senior and one junior PC member all agree"

inductive Q3 | beforeAssignment | anonUntilRelease | anyUntilRelease | anonAnyStage | anyAnyStage
  deriving DecidableEq, Repr, Inhabited
instance : Enum Q3 where
  all := [.beforeAssignment, .anonUntilRelease, .anyUntilRelease, .anonAnyStage, .anyAnyStage]
  key | .beforeAssignment => "before-assignment" | .anonUntilRelease => "anonymity-until-release"
      | .anyUntilRelease => "any-until-release" | .anonAnyStage => "anonymity-any-stage"
      | .anyAnyStage => "any-any-stage"
  desc | .beforeAssignment => "before assignment only" | .anonUntilRelease => "anonymity only, until reviews are released"
       | .anyUntilRelease => "any ground, until reviews are released" | .anonAnyStage => "anonymity at any stage"
       | .anyAnyStage => "any ground at any stage"

inductive Q4 | never | afterOwnReview | always
  deriving DecidableEq, Repr, Inhabited
instance : Enum Q4 where
  all := [.never, .afterOwnReview, .always]
  key | .never => "never" | .afterOwnReview => "after-own-review" | .always => "always"
  desc | .never => "never" | .afterOwnReview => "after their own review is in, with a feedback form on the triage"
       | .always => "always"

inductive Q5 | reviews | doesNotReview
  deriving DecidableEq, Repr, Inhabited
instance : Enum Q5 where
  all := [.reviews, .doesNotReview]
  key | .reviews => "yes" | .doesNotReview => "no"
  desc | .reviews => "the second-opinion member reviews it" | .doesNotReview => "they do not review it"

inductive Q6 | grounds | evidence
  deriving DecidableEq, Repr, Inhabited
instance : Enum Q6 where
  all := [.grounds, .evidence]
  key | .grounds => "grounds" | .evidence => "evidence"
  desc | .grounds => "a fabricated reference is grounds on its own" | .evidence => "it is evidence for the AC only"

inductive Q7 | upToMax | expectedK
  deriving DecidableEq, Repr, Inhabited
instance : Enum Q7 where
  all := [.upToMax, .expectedK]
  key | .upToMax => "up-to-max" | .expectedK => "expected-k"
  desc | .upToMax => "may be assigned, up to what they owe" | .expectedK => "is expected to do what they owe"

inductive Q8 | one | upToN | atLeastOne
  deriving DecidableEq, Repr, Inhabited
instance : Enum Q8 where
  all := [.one, .upToN, .atLeastOne]
  key | .one => "one" | .upToN => "up-to-n" | .atLeastOne => "at-least-one"
  desc | .one => "exactly one nominee" | .upToN => "up to n nominees, chosen by the authors"
       | .atLeastOne => "at least one, no upper limit"

inductive Q10 | deskReject | warnThenReject | warnOnly
  deriving DecidableEq, Repr, Inhabited
instance : Enum Q10 where
  all := [.deskReject, .warnThenReject, .warnOnly]
  key | .deskReject => "desk-reject" | .warnThenReject => "warn-then-reject" | .warnOnly => "warn-only"
  desc | .deskReject => "desk reject" | .warnThenReject => "warning, then desk reject" | .warnOnly => "warning only"

inductive Q11 | rejectOwnPapers | recordOnly | nothing
  deriving DecidableEq, Repr, Inhabited
instance : Enum Q11 where
  all := [.rejectOwnPapers, .recordOnly, .nothing]
  key | .rejectOwnPapers => "reject-own-papers" | .recordOnly => "record-only" | .nothing => "none"
  desc | .rejectOwnPapers => "desk reject the nominating papers" | .recordOnly => "recorded for the PC chairs only"
       | .nothing => "no consequence"

inductive Q13 | oneJunior | oneOrTwoJuniors | zeroToTwoJuniors | oneJuniorOrNominee
  deriving DecidableEq, Repr, Inhabited
instance : Enum Q13 where
  all := [.oneJunior, .oneOrTwoJuniors, .zeroToTwoJuniors, .oneJuniorOrNominee]
  key | .oneJunior => "one-junior" | .oneOrTwoJuniors => "one-or-two-juniors"
      | .zeroToTwoJuniors => "zero-to-two-juniors" | .oneJuniorOrNominee => "one-junior-or-nominee"
  desc | .oneJunior => "exactly one junior" | .oneOrTwoJuniors => "one or two juniors"
       | .zeroToTwoJuniors => "zero to two juniors" | .oneJuniorOrNominee => "exactly one, a junior or a nominee"

inductive Q14 | tierDecides | nomineeNotSenior
  deriving DecidableEq, Repr, Inhabited
instance : Enum Q14 where
  all := [.tierDecides, .nomineeNotSenior]
  key | .tierDecides => "tier-decides" | .nomineeNotSenior => "nominee-not-senior"
  desc | .tierDecides => "a nominee fills the slot of their tier"
       | .nomineeNotSenior => "a nominee never fills a senior slot"

inductive Q15 | rejectOnly | rejectOrWeak | belowAccept
  deriving DecidableEq, Repr, Inhabited
instance : Enum Q15 where
  all := [.rejectOnly, .rejectOrWeak, .belowAccept]
  key | .rejectOnly => "reject-only" | .rejectOrWeak => "reject-or-weak" | .belowAccept => "below-accept"
  desc | .rejectOnly => "reject or strong reject" | .rejectOrWeak => "weak reject or below"
       | .belowAccept => "anything below the accept side"

inductive Q16 | noWindow | bumpWindow
  deriving DecidableEq, Repr, Inhabited
instance : Enum Q16 where
  all := [.noWindow, .bumpWindow]
  key | .noWindow => "no-window" | .bumpWindow => "bump-window"
  desc | .noWindow => "scores decide" | .bumpWindow => "reviewers may bump within a window"

inductive Q17 | noCap | cap9
  deriving DecidableEq, Repr, Inhabited
instance : Enum Q17 where
  all := [.noCap, .cap9]
  key | .noCap => "none" | .cap9 => "9"
  desc | .noCap => "no cap" | .cap9 => "9 submissions per author"

inductive Q18 | once | perPaper | shareWeighted | cappedAtBand
  deriving DecidableEq, Repr, Inhabited
instance : Enum Q18 where
  all := [.once, .perPaper, .shareWeighted, .cappedAtBand]
  key | .once => "once" | .perPaper => "per-paper" | .shareWeighted => "share-weighted" | .cappedAtBand => "capped-at-band"
  desc | .once => "k once, however many papers" | .perPaper => "k per nominating paper"
       | .shareWeighted => "their share of k, summed over papers"
       | .cappedAtBand => "their shares summed, capped at the tier's band"

inductive Q19 | equal | authorsAllocate | solverPooled
  deriving DecidableEq, Repr, Inhabited
instance : Enum Q19 where
  all := [.equal, .authorsAllocate, .solverPooled]
  key | .equal => "equal" | .authorsAllocate => "authors-allocate" | .solverPooled => "solver"
  desc | .equal => "split equally" | .authorsAllocate => "split as the authors allocate"
       | .solverPooled => "pooled; the solver splits it"

inductive Q19b | othersAbsorb | paperShort
  deriving DecidableEq, Repr, Inhabited
instance : Enum Q19b where
  all := [.othersAbsorb, .paperShort]
  key | .othersAbsorb => "others-absorb" | .paperShort => "paper-short"
  desc | .othersAbsorb => "the other nominees absorb a declined nominee's share"
       | .paperShort => "the paper is short by that share"

inductive Q20 | needsRequest | noRequestNeeded
  deriving DecidableEq, Repr, Inhabited
instance : Enum Q20 where
  all := [.needsRequest, .noRequestNeeded]
  key | .needsRequest => "yes" | .noRequestNeeded => "no"
  desc | .needsRequest => "a quality consequence needs an earlier declined or unanswered request"
       | .noRequestNeeded => "no earlier request needed"

inductive Q21 | thisConference | handedOn
  deriving DecidableEq, Repr, Inhabited
instance : Enum Q21 where
  all := [.thisConference, .handedOn]
  key | .thisConference => "this-conference" | .handedOn => "handed-on"
  desc | .thisConference => "kept for this conference only" | .handedOn => "summarized for the next chairs"

/-- Venue parameters: numbers a venue sets, not questions with readings. Each is a setting in the app
    (`PCS_NOMINEES_MAX`, `PCS_PATTERN_MIN`, `PCS_ACC_GRACE_H`, `PCS_REMEDY_WINDOW_H`) and a `venue.*` line in an answers file. -/
structure Venue where
  /-- Q8 "up to n": the most nominees a paper may name (the owner's ruling: a venue parameter, default 3). -/
  nomineesMax : Nat := 3
  /-- Q9: a pattern shows once a senior has made this many nominations, repeats of one junior included. -/
  patternMin : Nat := 3
  /-- AR5: hours after a request's due date before "no reply" may be recorded. -/
  accGraceH : Nat := 48
  /-- Q1 "fix window": hours the author has to cure an anonymity problem once the chair offers the fix (the owner's ruling: a venue parameter, default 72). -/
  remedyWindowH : Nat := 72
  deriving DecidableEq, Repr, Inhabited

structure Reading where
  venue : Venue := {}
  q1 : Q1 := default
  q2 : Q2 := default
  q3 : Q3 := default
  q4 : Q4 := default
  q5 : Q5 := default
  q6 : Q6 := default
  q7 : Q7 := default
  q8 : Q8 := default
  q10 : Q10 := default
  q11 : Q11 := default
  q13 : Q13 := default
  q14 : Q14 := default
  q15 : Q15 := default
  q16 : Q16 := default
  q17 : Q17 := default
  q18 : Q18 := default
  q19 : Q19 := default
  q19b : Q19b := default
  q20 : Q20 := default
  q21 : Q21 := default
  deriving DecidableEq, Repr, Inhabited

/-- The questions the model covers, for generic narrowing and printing. -/
inductive QId | q1 | q2 | q3 | q4 | q5 | q6 | q7 | q8 | q10 | q11 | q13 | q14 | q15 | q16 | q17 | q18 | q19 | q19b | q20 | q21
  deriving DecidableEq, Repr, Inhabited

def QId.all : List QId :=
  [.q1, .q2, .q3, .q4, .q5, .q6, .q7, .q8, .q10, .q11, .q13, .q14, .q15, .q16, .q17, .q18, .q19, .q19b, .q20, .q21]

def QId.code : QId → String
  | .q1 => "Q1" | .q2 => "Q2" | .q3 => "Q3" | .q4 => "Q4" | .q5 => "Q5" | .q6 => "Q6" | .q7 => "Q7" | .q8 => "Q8"
  | .q10 => "Q10" | .q11 => "Q11" | .q13 => "Q13" | .q14 => "Q14" | .q15 => "Q15" | .q16 => "Q16"
  | .q17 => "Q17" | .q18 => "Q18" | .q19 => "Q19" | .q19b => "Q19b" | .q20 => "Q20" | .q21 => "Q21"

def QId.text : QId → String
  | .q1 => "double-anonymity violation" | .q2 => "who must agree to a desk reject"
  | .q3 => "until when a desk reject is possible" | .q4 => "when reviewers see the screening record"
  | .q5 => "the second-opinion member reviews the paper if it stays"
  | .q6 => "a fabricated reference is grounds on its own" | .q7 => "what an accepted nominee commits to"
  | .q8 => "nominees per paper" | .q10 => "consequence of naming no nominee"
  | .q11 => "consequence of a failed nominee review" | .q13 => "the slots beyond the two senior ones"
  | .q14 => "does a senior-classified nominee fill a senior slot" | .q15 => "what counts as a negative initial review"
  | .q16 => "a last word before early reject" | .q17 => "a cap on submissions per author"
  | .q18 => "how a nominee's obligation adds up across papers"
  | .q19 => "how a paper's obligation is split across its nominees"
  | .q19b => "a declined co-nominee's share" | .q20 => "a quality consequence needs an earlier request"
  | .q21 => "how long engagement records are kept"

/-- Keys and descriptions of the readings of a question, in order. -/
def labelsOf (α : Type) [Enum α] : List (String × String) :=
  (Enum.all : List α).map fun a => (Enum.key a, Enum.desc a)

def QId.labels : QId → List (String × String)
  | .q1 => labelsOf Q1 | .q2 => labelsOf Q2 | .q3 => labelsOf Q3 | .q4 => labelsOf Q4 | .q5 => labelsOf Q5
  | .q6 => labelsOf Q6 | .q7 => labelsOf Q7 | .q8 => labelsOf Q8 | .q10 => labelsOf Q10
  | .q11 => labelsOf Q11 | .q13 => labelsOf Q13 | .q14 => labelsOf Q14 | .q15 => labelsOf Q15
  | .q16 => labelsOf Q16 | .q17 => labelsOf Q17 | .q18 => labelsOf Q18 | .q19 => labelsOf Q19
  | .q19b => labelsOf Q19b | .q20 => labelsOf Q20 | .q21 => labelsOf Q21

def QId.count (q : QId) : Nat := q.labels.length

def Reading.get (r : Reading) : QId → Nat
  | .q1 => Enum.idx r.q1 | .q2 => Enum.idx r.q2 | .q3 => Enum.idx r.q3 | .q4 => Enum.idx r.q4 | .q5 => Enum.idx r.q5
  | .q6 => Enum.idx r.q6 | .q7 => Enum.idx r.q7 | .q8 => Enum.idx r.q8 | .q10 => Enum.idx r.q10
  | .q11 => Enum.idx r.q11 | .q13 => Enum.idx r.q13 | .q14 => Enum.idx r.q14 | .q15 => Enum.idx r.q15
  | .q16 => Enum.idx r.q16 | .q17 => Enum.idx r.q17 | .q18 => Enum.idx r.q18 | .q19 => Enum.idx r.q19
  | .q19b => Enum.idx r.q19b | .q20 => Enum.idx r.q20 | .q21 => Enum.idx r.q21

def Reading.set (r : Reading) : QId → Nat → Reading
  | .q1, i => { r with q1 := Enum.ofIdx i } | .q2, i => { r with q2 := Enum.ofIdx i }
  | .q3, i => { r with q3 := Enum.ofIdx i } | .q4, i => { r with q4 := Enum.ofIdx i }
  | .q5, i => { r with q5 := Enum.ofIdx i }
  | .q6, i => { r with q6 := Enum.ofIdx i } | .q7, i => { r with q7 := Enum.ofIdx i }
  | .q8, i => { r with q8 := Enum.ofIdx i } | .q10, i => { r with q10 := Enum.ofIdx i }
  | .q11, i => { r with q11 := Enum.ofIdx i } | .q13, i => { r with q13 := Enum.ofIdx i }
  | .q14, i => { r with q14 := Enum.ofIdx i } | .q15, i => { r with q15 := Enum.ofIdx i }
  | .q16, i => { r with q16 := Enum.ofIdx i } | .q17, i => { r with q17 := Enum.ofIdx i }
  | .q18, i => { r with q18 := Enum.ofIdx i } | .q19, i => { r with q19 := Enum.ofIdx i }
  | .q19b, i => { r with q19b := Enum.ofIdx i } | .q20, i => { r with q20 := Enum.ofIdx i }
  | .q21, i => { r with q21 := Enum.ofIdx i }

def QId.readingName (q : QId) (i : Nat) : String := (q.labels.getD i ("?", "?")).2

/-- Number of readings of the whole text: the product over the questions. -/
def readingCount : Nat := QId.all.foldl (fun acc q => acc * q.count) 1

end ReviewProcess
