# Review-process model (Lean 4)

The executable model behind [docs/concepts.md](../docs/concepts.md). It follows the HUSL worked examples: the open questions are types, the rules are functions of a reading, the safety properties are theorems, and the example cards are run on the model.

| File | What it holds |
|---|---|
| `ReviewProcess/Readings.lean` | One type per open question of concepts.md §1 (Q1–Q21, except Q9 and Q12, which no rule depends on yet). A `Reading` answers all of them. |
| `ReviewProcess/Model.lean` | The rules: `may-remove` (triage, second opinion, remedy, Q3 timing), early reject, nominee obligations (Q18, Q19), eligibility and composition (Q13, Q14), reciprocal cycles, Writeback's dry run, and accountability requests. `Params` holds one flag per mutant; `{}` is the signed model. |
| `ReviewProcess/Properties.lean` | Theorems: S1, S8, S9, S10, E-1, V1, V2 (part), H2, AR2, AR4, AR5, AR6, plus the Q6 and Q14 readings. `lake build` checks them. |
| `ReviewProcess/Policy.lean` | The policy table (§3.9) as a function of the reading; theorems about it; `gated`, which refuses any action whose role lacks the cell; and the trace search for L1 and L2 over four subsystems (desk reject, early reject, accountability requests, appointment and Writeback). |
| `ReviewProcess/Solver.lean` | Plan as a solver: min-cost max-flow (primal-dual: Dijkstra on reduced costs, then blocking flows) on the spec §10.5 network, reciprocal-cycle repair, and a self-check against brute force. `a2_plan_eligible` proves that every planned edge is eligible, whatever the flow. |
| `ReviewProcess/Validate.lean` | The example cards (concepts.md §3.11), the answers-file parser, narrowing, the legibility check, mutants, and a synthetic conference. |
| `Report.lean` | Prints the report. |
| `answers/synthetic.txt` | Answers for a synthetic venue. A real venue keeps its answers file outside this repo. |

Venue numbers (`Venue` in `Readings.lean`: nominees per paper under Q8 "up to n", the Q9 pattern threshold, the accountability grace period, the Q1 fix window) are not questions. An answers file sets them with `venue.nominees-max`, `venue.pattern-min`, `venue.acc-grace-h` and `venue.remedy-window-h` (defaults 3, 3, 48, 72), and `venue.junior-seats` (`fill`, `when-short`, `reciprocal-only`; who takes the optional seats under Q13 "zero to two juniors"; default `fill`); and `venue.reviewer-target` (reviewers a paper should have, the target the `when-short` and `reciprocal-only` modes fill toward, still at most two juniors; default 3); the app takes the same six from `PCS_NOMINEES_MAX`, `PCS_PATTERN_MIN`, `PCS_ACC_GRACE_H`, `PCS_REMEDY_WINDOW_H`, `PCS_JUNIOR_SEATS` and `PCS_REVIEWER_TARGET`. The cards that depend on one export a case per sampled value.

## Run

```sh
lake build                                  # checks every proof
lake exe report answers/synthetic.txt       # or the path to a venue's answers file (~15 s; the solves run in parallel)
```

`model-report.txt` is the report on the synthetic answers; regenerate it when the model changes.

## What the report shows

1. **Legibility:** each card declares the questions it depends on. The check varies every other question and fails if the outcome changes.
2. **Answered questions:** the cards that confirm each answer, chosen to split the remaining readings. An answer that no card confirms is listed with the open questions that block it.
3. **Open questions:** the cards to bring to the chairs, with the outcome under each reading. A card that splits a question only under some other answer says so.
4. **Readings that break a proved property:** for example, Q2 = "the AC alone" breaks S1.
5. **Policy:** the §3.9 table at the answered reading, with each † cell resolved.
6. **L1 and L2:** for each subsystem, the shortest trace to each admitted ground, early reject and nominee appointment, and the first trace that uses each granted cell. A ground the reading doesn't admit must be unreachable. Granted cells on a modeled action that no trace uses are listed as gaps.
7. **Mutation:** each mutant must be killed by a card or rejected by a property. A mutant that is equivalent at the answered reading says which change of reading would expose it.
8. **Consequences on a synthetic conference:** the Plan solver under the answered reading and under each alternative reading of Q13, Q14 and Q18 (solved in parallel), plus the early-reject rate under each reading of Q15. Each solve reports filled and unfilled slots, nominee loads against what they owe, reviews outside the paper's area, cycles before and after repair, and load-band violations (A4; always 0 so far). The scale numbers come from the answers file; affinity is synthetic.

## Not yet in the model

- Direct HotCRP writes by the PC chair, ACs, the junior PC chair, and authors (granted cells no trace exercises).
- Mirror, Import, Screening checks, Engines: the model covers the decisions they feed, not their mechanics.
- Real affinity: the solver runs on synthetic affinity. It accepts any candidate list, so imported TPMS scores can replace `Conf.affinity`.
- Q9, Q12.
