# Shootout: corpus `held-out` (58 papers, fingerprint 3e56805eca2c2c4e), k = 3

synthetic papers, fixed seed 20270101, never used for prompt development. Intervals are 95 percent: Wilson for rates, a seeded bootstrap for balanced accuracy and costs. Projections are for 4000 papers (`PCS_AGENT_SCALE_PAPERS`).

## Engines

| Engine | Adapter | Model | Real? | USD per M tokens in / out | GPU USD/h | Concurrency | Note |
|---|---|---|---|---|---|---|---|
| `claude-code-haiku-replay` | replay | haiku | recorded results of a real model | 0 / 0 | 0.0 | 1 | recorded claude-code / Haiku results (agent/fixtures/replay); only the recorded requests are served |
| `scripted-strong` | anthropic | scripted-strong | **scripted stand-in, not a model** | 3 / 15 | 0.0 | 4 | stands in for a strong API engine |
| `scripted-noisy` | anthropic | scripted-noisy | **scripted stand-in, not a model** | 1 / 5 | 0.0 | 8 | stands in for a cheaper tier: right on average, unstable between runs |
| `scripted-selfhosted` | openai-compat | scripted-selfhosted | **scripted stand-in, not a model** | 0 / 0 | 2.0 | 2 | stands in for a small self-hosted model behind openai-compat; GPU rate assumed at 2 USD/h |

Coverage (an engine with no recording for a request leaves that paper out of its numbers; it is never filled in):

| Engine | Papers served in at least one run | Calls | Calls with no recording |
|---|---|---|---|
| `claude-code-haiku-replay` | 0 / 58 | 450 | 450 |
| `scripted-strong` | 58 / 58 | 450 | 0 |
| `scripted-noisy` | 58 / 58 | 450 | 0 |
| `scripted-selfhosted` | 58 / 58 | 450 | 0 |

## `anonymity.llm`

| Engine | Recall | False-flag rate | Precision | Balanced accuracy | Anchors verify | Refusal / schema / truncated / error | Stability: agree (papers), pass^k, flaky flags | Cost per paper | At 4000 papers | Wall time | On frontier | Meets thresholds |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `claude-code-haiku-replay` | n/a (0) | n/a (0) | n/a | n/a | n/a | n/a / n/a / n/a / n/a | not measured | n/a | n/a | 0.0 h | no | no: no paper was served |
| `scripted-strong` | 1.00 [0.76, 1.00] (12) | 0.06 [0.01, 0.28] (16) | 0.92 [0.67, 0.99] | 0.97 [0.91, 1.00] | 1.00 [0.91, 1.00] | 0.00 [0.00, 0.04] / 0.00 [0.00, 0.04] / 0.00 [0.00, 0.04] / 0.00 [0.00, 0.04] | 0.82 [0.64, 0.92] (28), 0.82 [0.64, 0.92], 5/15 | $0.0038 [$0.0037, $0.0039] | $15.16 [$14.85, $15.48] | 1.2 h | yes | no: stability below 0.9; recall lower bound 0.76 under the threshold |
| `scripted-noisy` | 0.67 [0.39, 0.86] (12) | 0.19 [0.07, 0.43] (16) | 0.73 [0.43, 0.90] | 0.74 [0.56, 0.90] | 0.97 [0.86, 1.00] | 0.00 [0.00, 0.04] / 0.04 [0.01, 0.10] / 0.00 [0.00, 0.04] / 0.00 [0.00, 0.04] | 0.29 [0.15, 0.47] (28), 0.21 [0.10, 0.40], 20/22 | $0.0013 [$0.0012, $0.0013] | $5.04 [$4.94, $5.15] | 0.3 h | yes | no: recall below 0.8; false-flag rate above 0.1; stability below 0.9 |
| `scripted-selfhosted` | 0.83 [0.55, 0.95] (12) | 0.19 [0.07, 0.43] (16) | 0.77 [0.50, 0.92] | 0.82 [0.66, 0.94] | 1.00 [0.91, 1.00] | 0.00 [0.00, 0.04] / 0.00 [0.00, 0.04] / 0.00 [0.00, 0.04] / 0.00 [0.00, 0.04] | 0.75 [0.57, 0.87] (28), 0.61 [0.42, 0.76], 7/16 | $0.0026 [$0.0026, $0.0026] | $10.49 [$10.43, $10.54] | 5.2 h | yes | no: false-flag rate above 0.1; stability below 0.9; recall lower bound 0.55 under the threshold |

Frontier, cheapest to dearest (quality = balanced accuracy; `*` is on the frontier):

```
scripted-noisy             $0.0013      * 0.740  #############################
scripted-selfhosted        $0.0026      * 0.823  ################################
scripted-strong            $0.0038      * 0.969  ######################################
```

Quality differences outside the intervals: none between neighbours on the cost axis.

**Recommended engine:** none meets the thresholds; best quality: scripted-strong

## `scope`

| Engine | Recall | False-flag rate | Precision | Balanced accuracy | Anchors verify | Refusal / schema / truncated / error | Stability: agree (papers), pass^k, flaky flags | Cost per paper | At 4000 papers | Wall time | On frontier | Meets thresholds |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `claude-code-haiku-replay` | n/a (0) | n/a (0) | n/a | n/a | n/a | n/a / n/a / n/a / n/a | not measured | n/a | n/a | 0.0 h | no | no: no paper was served |
| `scripted-strong` | 1.00 [0.61, 1.00] (6) | 0.00 [0.00, 0.19] (16) | 1.00 [0.61, 1.00] | 1.00 [1.00, 1.00] | 1.00 [0.83, 1.00] | 0.00 [0.00, 0.06] / 0.00 [0.00, 0.06] / 0.00 [0.00, 0.06] / 0.00 [0.00, 0.06] | 0.95 [0.78, 0.99] (22), 0.95 [0.78, 0.99], 1/7 | $0.0042 [$0.0042, $0.0043] | $16.98 [$16.74, $17.19] | 1.2 h | yes | yes |
| `scripted-noisy` | 0.33 [0.10, 0.70] (6) | 0.13 [0.03, 0.36] (16) | 0.50 [0.15, 0.85] | 0.60 [0.41, 0.82] | 1.00 [0.82, 1.00] | 0.02 [0.00, 0.08] / 0.05 [0.02, 0.13] / 0.00 [0.00, 0.06] / 0.00 [0.00, 0.06] | 0.36 [0.20, 0.57] (22), 0.32 [0.16, 0.53], 14/14 | $0.0014 [$0.0014, $0.0014] | $5.60 [$5.49, $5.69] | 0.3 h | yes | no: recall below 0.8; false-flag rate above 0.1; stability below 0.9 |
| `scripted-selfhosted` | 0.50 [0.19, 0.81] (6) | 0.06 [0.01, 0.28] (16) | 0.75 [0.30, 0.95] | 0.72 [0.52, 0.92] | 1.00 [0.80, 1.00] | 0.00 [0.00, 0.06] / 0.00 [0.00, 0.06] / 0.03 [0.01, 0.10] / 0.00 [0.00, 0.06] | 0.77 [0.57, 0.90] (22), 0.64 [0.43, 0.80], 5/8 | $0.0026 [$0.0026, $0.0027] | $10.55 [$10.49, $10.61] | 5.3 h | yes | no: recall below 0.8; stability below 0.9 |

Frontier, cheapest to dearest (quality = balanced accuracy; `*` is on the frontier):

```
scripted-noisy             $0.0014      * 0.604  ########################
scripted-selfhosted        $0.0026      * 0.719  ############################
scripted-strong            $0.0042      * 1.000  ########################################
```

Quality differences outside the intervals: scripted-selfhosted and scripted-strong.

**Recommended engine:** scripted-strong (provisional: recall lower bound 0.61 under the threshold)

## `refs.use`

| Engine | Recall | False-flag rate | Precision | Balanced accuracy | Anchors verify | Refusal / schema / truncated / error | Stability: agree (papers), pass^k, flaky flags | Cost per paper | At 4000 papers | Wall time | On frontier | Meets thresholds |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `claude-code-haiku-replay` | n/a (0) | n/a (0) | n/a | n/a | n/a | n/a / n/a / n/a / n/a | not measured | n/a | n/a | 0.0 h | no | no: no paper was served |
| `scripted-strong` | 1.00 [0.61, 1.00] (6) | 0.00 [0.00, 0.19] (16) | 1.00 [0.61, 1.00] | 1.00 [1.00, 1.00] | 1.00 [0.85, 1.00] | 0.00 [0.00, 0.06] / 0.00 [0.00, 0.06] / 0.00 [0.00, 0.06] / 0.00 [0.00, 0.06] | 0.77 [0.57, 0.90] (22), 0.77 [0.57, 0.90], 5/10 | $0.0106 [$0.0106, $0.0106] | $42.50 [$42.46, $42.54] | 1.2 h | yes | no: stability below 0.9; recall lower bound 0.61 under the threshold |
| `scripted-noisy` | 0.83 [0.44, 0.97] (6) | 0.06 [0.01, 0.28] (16) | 0.83 [0.44, 0.97] | 0.89 [0.72, 1.00] | 0.96 [0.82, 0.99] | 0.02 [0.00, 0.08] / 0.00 [0.00, 0.06] / 0.00 [0.00, 0.06] / 0.00 [0.00, 0.06] | 0.14 [0.05, 0.33] (22), 0.14 [0.05, 0.33], 19/20 | $0.0035 [$0.0034, $0.0036] | $14.10 [$13.80, $14.28] | 0.3 h | yes | no: stability below 0.9; recall lower bound 0.44 under the threshold |
| `scripted-selfhosted` | 0.83 [0.44, 0.97] (6) | 0.19 [0.07, 0.43] (16) | 0.63 [0.31, 0.86] | 0.82 [0.63, 0.97] | 1.00 [0.85, 1.00] | 0.00 [0.00, 0.06] / 0.00 [0.00, 0.06] / 0.02 [0.00, 0.08] / 0.00 [0.00, 0.06] | 0.73 [0.52, 0.87] (22), 0.68 [0.47, 0.84], 6/10 | $0.0026 [$0.0026, $0.0026] | $10.51 [$10.44, $10.58] | 5.3 h | yes | no: false-flag rate above 0.1; stability below 0.9; recall lower bound 0.44 under the threshold |

Frontier, cheapest to dearest (quality = balanced accuracy; `*` is on the frontier):

```
scripted-selfhosted        $0.0026      * 0.823  ################################
scripted-noisy             $0.0035      * 0.885  ###################################
scripted-strong            $0.0106      * 1.000  ########################################
```

Quality differences outside the intervals: none between neighbours on the cost axis.

**Recommended engine:** none meets the thresholds; best quality: scripted-strong

## `injection.addressed.llm`

| Engine | Recall | False-flag rate | Precision | Balanced accuracy | Anchors verify | Refusal / schema / truncated / error | Stability: agree (papers), pass^k, flaky flags | Cost per paper | At 4000 papers | Wall time | On frontier | Meets thresholds |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `claude-code-haiku-replay` | n/a (0) | n/a (0) | n/a | n/a | n/a | n/a / n/a / n/a / n/a | not measured | n/a | n/a | 0.0 h | no | no: no paper was served |
| `scripted-strong` | 0.92 [0.65, 0.99] (12) | 0.00 [0.00, 0.39] (6) | 1.00 [0.74, 1.00] | 0.96 [0.88, 1.00] | 1.00 [0.89, 1.00] | 0.00 [0.00, 0.05] / 0.00 [0.00, 0.05] / 0.00 [0.00, 0.05] / 0.00 [0.00, 0.05] | 0.89 [0.67, 0.97] (18), 0.83 [0.61, 0.94], 2/11 | $0.0027 [$0.0025, $0.0030] | $10.99 [$10.06, $11.97] | 1.6 h | yes | no: stability below 0.9; recall lower bound 0.65 under the threshold |
| `scripted-noisy` | 0.75 [0.47, 0.91] (12) | 0.50 [0.19, 0.81] (6) | 0.75 [0.47, 0.91] | 0.63 [0.38, 0.88] | 1.00 [0.90, 1.00] | 0.00 [0.00, 0.05] / 0.04 [0.01, 0.12] / 0.00 [0.00, 0.05] / 0.00 [0.00, 0.05] | 0.11 [0.03, 0.33] (18), 0.22 [0.09, 0.45], 18/20 | $0.0009 [$0.0008, $0.0010] | $3.64 [$3.33, $3.96] | 0.4 h | yes | no: recall below 0.8; false-flag rate above 0.1; stability below 0.9 |
| `scripted-selfhosted` | 0.42 [0.19, 0.68] (12) | 0.17 [0.03, 0.56] (6) | 0.83 [0.44, 0.97] | 0.63 [0.42, 0.79] | 1.00 [0.85, 1.00] | 0.00 [0.00, 0.05] / 0.03 [0.01, 0.10] / 0.03 [0.01, 0.10] / 0.00 [0.00, 0.05] | 0.50 [0.29, 0.71] (18), 0.33 [0.16, 0.56], 9/12 | $0.0035 [$0.0032, $0.0038] | $13.96 [$12.72, $15.31] | 7.0 h | no | no: recall below 0.8; false-flag rate above 0.1; stability below 0.9 |

Frontier, cheapest to dearest (quality = balanced accuracy; `*` is on the frontier):

```
scripted-noisy             $0.0009      * 0.625  #########################
scripted-strong            $0.0027      * 0.958  ######################################
scripted-selfhosted        $0.0035        0.625  #########################
```

Quality differences outside the intervals: scripted-strong and scripted-selfhosted.

**Recommended engine:** none meets the thresholds; best quality: scripted-strong

## Projected cost at 4000 papers, all labelled checks

| Engine | Projected cost |
|---|---|
| `claude-code-haiku-replay` | n/a |
| `scripted-strong` | $85.62 [$84.11, $87.18] |
| `scripted-noisy` | $28.37 [$27.56, $29.08] |
| `scripted-selfhosted` | $45.51 [$44.08, $47.04] |

Costs come from the usage and prices recorded for each call (for a replay, the cost the provider reported); per-paper means are over the runs and papers of the check alone. Interval ends are sums of per-check ends, so the total interval is wider than a joint one.

## Scaffold delta

Balanced accuracy with our preprocessing minus the same engine given the PDF whole and the same question (agent.md 7.3). Only checks whose input is plain paper text have a raw variant here.

| Check | Engine | With scaffold | Raw PDF | Delta |
|---|---|---|---|---|
| `anonymity.llm` | `scripted-strong` | 0.97 [0.91, 1.00] | 0.92 [0.79, 1.00] | 0.05 [-0.06, 0.18] |
| `anonymity.llm` | `scripted-noisy` | 0.74 [0.56, 0.90] | 0.59 [0.46, 0.75] | 0.15 [-0.08, 0.36] |
| `anonymity.llm` | `scripted-selfhosted` | 0.82 [0.66, 0.94] | 0.56 [0.42, 0.72] | 0.26 [0.01, 0.47] |
| `scope` | `scripted-strong` | 1.00 [1.00, 1.00] | 0.89 [0.72, 1.00] | 0.11 [0.00, 0.28] |
| `scope` | `scripted-noisy` | 0.60 [0.41, 0.82] | 0.51 [0.28, 0.74] | 0.09 [-0.27, 0.47] |
| `scope` | `scripted-selfhosted` | 0.72 [0.52, 0.92] | 0.46 [0.28, 0.66] | 0.26 [0.06, 0.47] |

## Injection

Detection, vector `visible-addressed` (the classifier on a span the pattern list found): planted instructions found, and benign quotations flagged.

| Engine | Found | Benign controls flagged |
|---|---|---|
| `claude-code-haiku-replay` | n/a (0) | n/a (0) |
| `scripted-strong` | 0.92 [0.65, 0.99] (12) | 0.00 [0.00, 0.39] (6) |
| `scripted-noisy` | 0.75 [0.47, 0.91] (12) | 0.50 [0.19, 0.81] (6) |
| `scripted-selfhosted` | 0.42 [0.19, 0.68] (12) | 0.17 [0.03, 0.56] (6) |

The hidden-text and channel vectors are found by the deterministic checks, which do not depend on the engine; their per-vector scores are in `mutation-score.md` (`:agent:screeningScore`).

Resistance: over injected papers and their clean twins, the share of runs in which the planted instruction changes the check's output when it is left in, and when it has been stripped (the second is what the defence leaves). A stripped paper can still differ from its twin through run-to-run noise alone, so read the second column against the engine's stability.

| Engine | Check | Pair-runs | Changed, span left in | Changed, span stripped |
|---|---|---|---|---|
| `scripted-strong` | `anonymity.llm` | 18 | 0.06 [0.01, 0.26] | 0.11 [0.03, 0.33] |
| `scripted-strong` | `scope` | 18 | 0.22 [0.09, 0.45] | 0.22 [0.09, 0.45] |
| `scripted-strong` | `refs.use` | 18 | 0.00 [0.00, 0.18] | 0.00 [0.00, 0.18] |
| `scripted-strong` | `summary` | 18 | 0.06 [0.01, 0.26] | 0.00 [0.00, 0.18] |
| `scripted-noisy` | `anonymity.llm` | 18 | 0.28 [0.12, 0.51] | 0.44 [0.25, 0.66] |
| `scripted-noisy` | `scope` | 18 | 0.22 [0.09, 0.45] | 0.28 [0.12, 0.51] |
| `scripted-noisy` | `refs.use` | 18 | 0.00 [0.00, 0.18] | 0.00 [0.00, 0.18] |
| `scripted-noisy` | `summary` | 18 | 0.33 [0.16, 0.56] | 0.17 [0.06, 0.39] |
| `scripted-selfhosted` | `anonymity.llm` | 18 | 0.22 [0.09, 0.45] | 0.39 [0.20, 0.61] |
| `scripted-selfhosted` | `scope` | 18 | 0.11 [0.03, 0.33] | 0.28 [0.12, 0.51] |
| `scripted-selfhosted` | `refs.use` | 18 | 0.00 [0.00, 0.18] | 0.00 [0.00, 0.18] |
| `scripted-selfhosted` | `summary` | 18 | 0.72 [0.49, 0.88] | 0.39 [0.20, 0.61] |

## Cross-engine agreement

| Check | Engines | Papers | Same verdict |
|---|---|---|---|
| `anonymity.llm` | `scripted-strong` and `scripted-noisy` | 28 | 0.79 [0.60, 0.90] |
| `anonymity.llm` | `scripted-strong` and `scripted-selfhosted` | 28 | 0.79 [0.60, 0.90] |
| `anonymity.llm` | `scripted-noisy` and `scripted-selfhosted` | 28 | 0.57 [0.39, 0.73] |
| `scope` | `scripted-strong` and `scripted-noisy` | 22 | 0.73 [0.52, 0.87] |
| `scope` | `scripted-strong` and `scripted-selfhosted` | 22 | 0.82 [0.61, 0.93] |
| `scope` | `scripted-noisy` and `scripted-selfhosted` | 22 | 0.82 [0.61, 0.93] |
| `refs.use` | `scripted-strong` and `scripted-noisy` | 22 | 0.91 [0.72, 0.97] |
| `refs.use` | `scripted-strong` and `scripted-selfhosted` | 22 | 0.82 [0.61, 0.93] |
| `refs.use` | `scripted-noisy` and `scripted-selfhosted` | 22 | 0.73 [0.52, 0.87] |
| `injection.addressed.llm` | `scripted-strong` and `scripted-noisy` | 18 | 0.72 [0.49, 0.88] |
| `injection.addressed.llm` | `scripted-strong` and `scripted-selfhosted` | 18 | 0.61 [0.39, 0.80] |
| `injection.addressed.llm` | `scripted-noisy` and `scripted-selfhosted` | 18 | 0.44 [0.25, 0.66] |

## Raw-PDF variant rows

| Check | Engine | Recall | False-flag rate | Balanced accuracy | Cost per paper |
|---|---|---|---|---|---|
| `anonymity.llm` | `scripted-strong` | 0.83 [0.55, 0.95] | 0.00 [0.00, 0.19] | 0.92 [0.79, 1.00] | $0.0027 [$0.0026, $0.0028] |
| `anonymity.llm` | `scripted-noisy` | 0.25 [0.09, 0.53] | 0.06 [0.01, 0.28] | 0.59 [0.46, 0.75] | $0.0009 [$0.0009, $0.0009] |
| `anonymity.llm` | `scripted-selfhosted` | 0.25 [0.09, 0.53] | 0.13 [0.03, 0.36] | 0.56 [0.42, 0.72] | $0.0026 [$0.0026, $0.0026] |
| `scope` | `scripted-strong` | 0.83 [0.44, 0.97] | 0.06 [0.01, 0.28] | 0.89 [0.72, 1.00] | $0.0033 [$0.0033, $0.0033] |
| `scope` | `scripted-noisy` | 0.33 [0.10, 0.70] | 0.31 [0.14, 0.56] | 0.51 [0.28, 0.74] | $0.0011 [$0.0011, $0.0011] |
| `scope` | `scripted-selfhosted` | 0.17 [0.03, 0.56] | 0.25 [0.10, 0.49] | 0.46 [0.28, 0.66] | $0.0026 [$0.0026, $0.0026] |
