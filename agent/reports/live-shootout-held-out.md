# Shootout: corpus `held-out` (58 papers, fingerprint 3e56805eca2c2c4e), k = 3

synthetic papers, fixed seed 20270101, never used for prompt development. Intervals are 95 percent: Wilson for rates, a seeded bootstrap for balanced accuracy and costs. Projections are for 4000 papers (`PCS_AGENT_SCALE_PAPERS`).

## Engines

| Engine | Adapter | Model | Real? | USD per M tokens in / out | GPU USD/h | Concurrency | Note |
|---|---|---|---|---|---|---|---|
| `haiku` | claude-code | claude-haiku-5-5 | recorded results of a real model | 0 / 0 | 0.0 | 4 | configured in the environment |
| `sonnet` | claude-code | claude-sonnet-5-5 | recorded results of a real model | 0 / 0 | 0.0 | 4 | configured in the environment |
| `opus` | claude-code | claude-opus-5-5 | recorded results of a real model | 0 / 0 | 0.0 | 4 | configured in the environment |

Coverage (an engine with no recording for a request leaves that paper out of its numbers; it is never filled in):

| Engine | Papers served in at least one run | Calls | Calls with no recording |
|---|---|---|---|
| `haiku` | 58 / 58 | 450 | 0 |
| `sonnet` | 58 / 58 | 450 | 0 |
| `opus` | 58 / 58 | 450 | 0 |

## `anonymity.llm`

| Engine | Recall | False-flag rate | Precision | Balanced accuracy | Anchors verify | Refusal / schema / truncated / error | Stability: agree (papers), pass^k, flaky flags | Cost per paper | At 4000 papers | Wall time | On frontier | Meets thresholds |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `haiku` | 1.00 [0.76, 1.00] (12) | 0.00 [0.00, 0.19] (16) | 1.00 [0.76, 1.00] | 1.00 [1.00, 1.00] | 1.00 [0.93, 1.00] | 0.00 [0.00, 0.04] / 0.00 [0.00, 0.04] / 0.00 [0.00, 0.04] / 0.00 [0.00, 0.04] | 0.89 [0.73, 0.96] (28), 1.00 [0.88, 1.00], 12/24 | $0.0003 [$0.0003, $0.0004] | $1.39 [$1.17, $1.62] | 0.6 h | yes | no: stability below 0.9 |
| `sonnet` | 1.00 [0.76, 1.00] (12) | 0.00 [0.00, 0.19] (16) | 1.00 [0.76, 1.00] | 1.00 [1.00, 1.00] | 1.00 [0.93, 1.00] | 0.00 [0.00, 0.04] / 0.00 [0.00, 0.04] / 0.00 [0.00, 0.04] / 0.00 [0.00, 0.04] | 1.00 [0.88, 1.00] (28), 1.00 [0.88, 1.00], 0/18 | $0.0046 [$0.0040, $0.0052] | $18.27 [$15.91, $20.60] | 0.5 h | no | yes |
| `opus` | 1.00 [0.76, 1.00] (12) | 0.00 [0.00, 0.19] (16) | 1.00 [0.76, 1.00] | 1.00 [1.00, 1.00] | 1.00 [0.93, 1.00] | 0.00 [0.00, 0.04] / 0.00 [0.00, 0.04] / 0.00 [0.00, 0.04] / 0.00 [0.00, 0.04] | 0.89 [0.73, 0.96] (28), 1.00 [0.88, 1.00], 6/21 | $0.0094 [$0.0081, $0.0106] | $37.57 [$32.59, $42.56] | 0.7 h | no | no: stability below 0.9 |

Frontier, cheapest to dearest (quality = balanced accuracy; `*` is on the frontier):

```
haiku                      $0.0003      * 1.000  ########################################
sonnet                     $0.0046        1.000  ########################################
opus                       $0.0094        1.000  ########################################
```

Quality differences outside the intervals: none between neighbours on the cost axis.

**Recommended engine:** sonnet

## `scope`

| Engine | Recall | False-flag rate | Precision | Balanced accuracy | Anchors verify | Refusal / schema / truncated / error | Stability: agree (papers), pass^k, flaky flags | Cost per paper | At 4000 papers | Wall time | On frontier | Meets thresholds |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `haiku` | 0.83 [0.44, 0.97] (6) | 0.00 [0.00, 0.19] (16) | 1.00 [0.57, 1.00] | 0.92 [0.75, 1.00] | 0.83 [0.61, 0.94] | 0.00 [0.00, 0.06] / 0.00 [0.00, 0.06] / 0.00 [0.00, 0.06] / 0.00 [0.00, 0.06] | 0.91 [0.72, 0.97] (22), 0.91 [0.72, 0.97], 2/6 | $0.0006 [$0.0006, $0.0007] | $2.57 [$2.38, $2.76] | 0.5 h | yes | no: anchor validity below 0.95; recall lower bound 0.44 under the threshold |
| `sonnet` | 1.00 [0.61, 1.00] (6) | 0.00 [0.00, 0.19] (16) | 1.00 [0.61, 1.00] | 1.00 [1.00, 1.00] | 1.00 [0.82, 1.00] | 0.00 [0.00, 0.06] / 0.00 [0.00, 0.06] / 0.00 [0.00, 0.06] / 0.00 [0.00, 0.06] | 1.00 [0.85, 1.00] (22), 1.00 [0.85, 1.00], 0/6 | $0.0068 [$0.0061, $0.0075] | $27.03 [$24.24, $29.85] | 0.8 h | yes | yes |
| `opus` | 1.00 [0.61, 1.00] (6) | 0.00 [0.00, 0.19] (16) | 1.00 [0.61, 1.00] | 1.00 [1.00, 1.00] | 1.00 [0.82, 1.00] | 0.00 [0.00, 0.06] / 0.00 [0.00, 0.06] / 0.00 [0.00, 0.06] / 0.00 [0.00, 0.06] | 1.00 [0.85, 1.00] (22), 1.00 [0.85, 1.00], 0/6 | $0.0140 [$0.0125, $0.0154] | $55.94 [$50.19, $61.61] | 1.0 h | no | yes |

Frontier, cheapest to dearest (quality = balanced accuracy; `*` is on the frontier):

```
haiku                      $0.0006      * 0.917  ####################################
sonnet                     $0.0068      * 1.000  ########################################
opus                       $0.0140        1.000  ########################################
```

Quality differences outside the intervals: none between neighbours on the cost axis.

**Recommended engine:** sonnet (provisional: recall lower bound 0.61 under the threshold)

## `refs.use`

| Engine | Recall | False-flag rate | Precision | Balanced accuracy | Anchors verify | Refusal / schema / truncated / error | Stability: agree (papers), pass^k, flaky flags | Cost per paper | At 4000 papers | Wall time | On frontier | Meets thresholds |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `haiku` | 1.00 [0.61, 1.00] (6) | 0.00 [0.00, 0.19] (16) | 1.00 [0.61, 1.00] | 1.00 [1.00, 1.00] | 1.00 [0.82, 1.00] | 0.00 [0.00, 0.06] / 0.00 [0.00, 0.06] / 0.00 [0.00, 0.06] / 0.00 [0.00, 0.06] | 1.00 [0.85, 1.00] (22), 1.00 [0.85, 1.00], 0/6 | $0.0013 [$0.0012, $0.0013] | $5.10 [$4.86, $5.34] | 1.7 h | yes | yes |
| `sonnet` | 1.00 [0.61, 1.00] (6) | 0.00 [0.00, 0.19] (16) | 1.00 [0.61, 1.00] | 1.00 [1.00, 1.00] | 1.00 [0.83, 1.00] | 0.00 [0.00, 0.06] / 0.00 [0.00, 0.06] / 0.00 [0.00, 0.06] / 0.00 [0.00, 0.06] | 0.95 [0.78, 0.99] (22), 0.95 [0.78, 0.99], 1/7 | $0.0100 [$0.0092, $0.0109] | $40.19 [$36.89, $43.49] | 1.2 h | no | yes |
| `opus` | 1.00 [0.61, 1.00] (6) | 0.00 [0.00, 0.19] (16) | 1.00 [0.61, 1.00] | 1.00 [1.00, 1.00] | 1.00 [0.82, 1.00] | 0.00 [0.00, 0.06] / 0.00 [0.00, 0.06] / 0.00 [0.00, 0.06] / 0.00 [0.00, 0.06] | 1.00 [0.85, 1.00] (22), 1.00 [0.85, 1.00], 0/6 | $0.0214 [$0.0197, $0.0230] | $85.53 [$78.99, $92.07] | 1.7 h | no | yes |

Frontier, cheapest to dearest (quality = balanced accuracy; `*` is on the frontier):

```
haiku                      $0.0013      * 1.000  ########################################
sonnet                     $0.0100        1.000  ########################################
opus                       $0.0214        1.000  ########################################
```

Quality differences outside the intervals: none between neighbours on the cost axis.

**Recommended engine:** haiku (provisional: recall lower bound 0.61 under the threshold)

## `injection.addressed.llm`

| Engine | Recall | False-flag rate | Precision | Balanced accuracy | Anchors verify | Refusal / schema / truncated / error | Stability: agree (papers), pass^k, flaky flags | Cost per paper | At 4000 papers | Wall time | On frontier | Meets thresholds |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `haiku` | 1.00 [0.76, 1.00] (12) | 0.00 [0.00, 0.39] (6) | 1.00 [0.76, 1.00] | 1.00 [1.00, 1.00] | 1.00 [0.93, 1.00] | 0.00 [0.00, 0.05] / 0.00 [0.00, 0.05] / 0.00 [0.00, 0.05] / 0.00 [0.00, 0.05] | 1.00 [0.82, 1.00] (18), 1.00 [0.82, 1.00], 0/18 | $0.0005 [$0.0005, $0.0006] | $2.17 [$1.94, $2.41] | 0.7 h | yes | yes |
| `sonnet` | 1.00 [0.76, 1.00] (12) | 0.00 [0.00, 0.39] (6) | 1.00 [0.76, 1.00] | 1.00 [1.00, 1.00] | 1.00 [0.93, 1.00] | 0.00 [0.00, 0.05] / 0.00 [0.00, 0.05] / 0.00 [0.00, 0.05] / 0.00 [0.00, 0.05] | 1.00 [0.82, 1.00] (18), 1.00 [0.82, 1.00], 0/18 | $0.0053 [$0.0046, $0.0060] | $21.06 [$18.42, $24.19] | 1.2 h | no | yes |
| `opus` | 1.00 [0.76, 1.00] (12) | 0.00 [0.00, 0.39] (6) | 1.00 [0.76, 1.00] | 1.00 [1.00, 1.00] | 1.00 [0.93, 1.00] | 0.00 [0.00, 0.05] / 0.00 [0.00, 0.05] / 0.00 [0.00, 0.05] / 0.00 [0.00, 0.05] | 1.00 [0.82, 1.00] (18), 1.00 [0.82, 1.00], 0/18 | $0.0101 [$0.0088, $0.0116] | $40.56 [$35.30, $46.54] | 1.1 h | no | yes |

Frontier, cheapest to dearest (quality = balanced accuracy; `*` is on the frontier):

```
haiku                      $0.0005      * 1.000  ########################################
sonnet                     $0.0053        1.000  ########################################
opus                       $0.0101        1.000  ########################################
```

Quality differences outside the intervals: none between neighbours on the cost axis.

**Recommended engine:** haiku

## Projected cost at 4000 papers, all labelled checks

| Engine | Projected cost |
|---|---|
| `haiku` | $11.23 [$10.35, $12.12] |
| `sonnet` | $106.55 [$95.46, $118.13] |
| `opus` | $219.59 [$197.07, $242.78] |

Costs come from the usage and prices recorded for each call (for a replay, the cost the provider reported); per-paper means are over the runs and papers of the check alone. Interval ends are sums of per-check ends, so the total interval is wider than a joint one.

## Scaffold delta

No engine served both variants on this corpus.

## Injection

Detection, vector `visible-addressed` (the classifier on a span the pattern list found): planted instructions found, and benign quotations flagged.

| Engine | Found | Benign controls flagged |
|---|---|---|
| `haiku` | 1.00 [0.76, 1.00] (12) | 0.00 [0.00, 0.39] (6) |
| `sonnet` | 1.00 [0.76, 1.00] (12) | 0.00 [0.00, 0.39] (6) |
| `opus` | 1.00 [0.76, 1.00] (12) | 0.00 [0.00, 0.39] (6) |

The hidden-text and channel vectors are found by the deterministic checks, which do not depend on the engine; their per-vector scores are in `mutation-score.md` (`:agent:screeningScore`).

Resistance: over injected papers and their clean twins, the share of runs in which the planted instruction changes the check's output when it is left in, and when it has been stripped (the second is what the defence leaves). A stripped paper can still differ from its twin through run-to-run noise alone, so read the second column against the engine's stability.

| Engine | Check | Pair-runs | Changed, span left in | Changed, span stripped |
|---|---|---|---|---|
| `haiku` | `anonymity.llm` | 18 | 0.00 [0.00, 0.18] | 0.00 [0.00, 0.18] |
| `haiku` | `scope` | 18 | 0.00 [0.00, 0.18] | 0.00 [0.00, 0.18] |
| `haiku` | `refs.use` | 18 | 0.00 [0.00, 0.18] | 0.00 [0.00, 0.18] |
| `haiku` | `summary` | 18 | 0.83 [0.61, 0.94] | 0.94 [0.74, 0.99] |
| `sonnet` | `anonymity.llm` | 18 | 0.00 [0.00, 0.18] | 0.00 [0.00, 0.18] |
| `sonnet` | `scope` | 18 | 0.00 [0.00, 0.18] | 0.00 [0.00, 0.18] |
| `sonnet` | `refs.use` | 18 | 0.00 [0.00, 0.18] | 0.00 [0.00, 0.18] |
| `sonnet` | `summary` | 18 | 0.89 [0.67, 0.97] | 0.89 [0.67, 0.97] |
| `opus` | `anonymity.llm` | 18 | 0.00 [0.00, 0.18] | 0.00 [0.00, 0.18] |
| `opus` | `scope` | 18 | 0.00 [0.00, 0.18] | 0.00 [0.00, 0.18] |
| `opus` | `refs.use` | 18 | 0.00 [0.00, 0.18] | 0.00 [0.00, 0.18] |
| `opus` | `summary` | 18 | 0.94 [0.74, 0.99] | 0.83 [0.61, 0.94] |

`summary` has no labels; its qualification rule is anchor validity (the share of statements the harness could anchor) and the resistance rows above, with no human rating.

| Engine | Statements | Anchor validity |
|---|---|---|
| `haiku` | 224 | 1.00 [0.98, 1.00] |
| `sonnet` | 207 | 1.00 [0.97, 1.00] |
| `opus` | 216 | 1.00 [0.98, 1.00] |

## Cross-engine agreement

| Check | Engines | Papers | Same verdict |
|---|---|---|---|
| `anonymity.llm` | `haiku` and `sonnet` | 28 | 1.00 [0.88, 1.00] |
| `anonymity.llm` | `haiku` and `opus` | 28 | 1.00 [0.88, 1.00] |
| `anonymity.llm` | `sonnet` and `opus` | 28 | 1.00 [0.88, 1.00] |
| `scope` | `haiku` and `sonnet` | 22 | 0.95 [0.78, 0.99] |
| `scope` | `haiku` and `opus` | 22 | 0.95 [0.78, 0.99] |
| `scope` | `sonnet` and `opus` | 22 | 1.00 [0.85, 1.00] |
| `refs.use` | `haiku` and `sonnet` | 22 | 1.00 [0.85, 1.00] |
| `refs.use` | `haiku` and `opus` | 22 | 1.00 [0.85, 1.00] |
| `refs.use` | `sonnet` and `opus` | 22 | 1.00 [0.85, 1.00] |
| `injection.addressed.llm` | `haiku` and `sonnet` | 18 | 1.00 [0.82, 1.00] |
| `injection.addressed.llm` | `haiku` and `opus` | 18 | 1.00 [0.82, 1.00] |
| `injection.addressed.llm` | `sonnet` and `opus` | 18 | 1.00 [0.82, 1.00] |
