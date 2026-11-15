# Shootout: corpus `recorded` (11 papers, fingerprint ae6820d2e46fe3e8), k = 3

the development cases of LlmCorpus (seed 20261115) with their live recordings; prompts were written against them, so scores are optimistic. Intervals are 95 percent: Wilson for rates, a seeded bootstrap for balanced accuracy and costs. Projections are for 4000 papers (`PCS_AGENT_SCALE_PAPERS`).

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
| `claude-code-haiku-replay` | 11 / 11 | 33 | 16 |
| `scripted-strong` | 11 / 11 | 33 | 0 |
| `scripted-noisy` | 11 / 11 | 33 | 0 |
| `scripted-selfhosted` | 11 / 11 | 33 | 0 |

## `anonymity.llm`

| Engine | Recall | False-flag rate | Precision | Balanced accuracy | Anchors verify | Refusal / schema / truncated / error | Stability: agree (papers), pass^k, flaky flags | Cost per paper | At 4000 papers | Wall time | On frontier | Meets thresholds |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `claude-code-haiku-replay` | 1.00 [0.34, 1.00] (2) | 0.00 [0.00, 0.79] (1) | 1.00 [0.34, 1.00] | 1.00 [1.00, 1.00] | 1.00 [0.57, 1.00] | 0.00 [0.00, 0.43] / 0.00 [0.00, 0.43] / 0.00 [0.00, 0.43] / 0.00 [0.00, 0.43] | 1.00 [0.21, 1.00] (1), 1.00 [0.21, 1.00], 0/1 | $0.0008 [$0.0007, $0.0009] | $3.29 [$2.67, $3.75] | 2.6 h | yes | yes |
| `scripted-strong` | 1.00 [0.34, 1.00] (2) | 0.00 [0.00, 0.79] (1) | 1.00 [0.34, 1.00] | 1.00 [1.00, 1.00] | 1.00 [0.61, 1.00] | 0.00 [0.00, 0.30] / 0.00 [0.00, 0.30] / 0.00 [0.00, 0.30] / 0.00 [0.00, 0.30] | 1.00 [0.44, 1.00] (3), 1.00 [0.44, 1.00], 0/2 | $0.0040 [$0.0037, $0.0042] | $15.86 [$14.87, $16.86] | 1.3 h | no | yes |
| `scripted-noisy` | 0.50 [0.09, 0.91] (2) | 0.00 [0.00, 0.79] (1) | 1.00 [0.21, 1.00] | 0.75 [0.50, 1.00] | 1.00 [0.51, 1.00] | 0.00 [0.00, 0.30] / 0.00 [0.00, 0.30] / 0.00 [0.00, 0.30] / 0.00 [0.00, 0.30] | 0.00 [0.00, 0.56] (3), 0.00 [0.00, 0.56], 3/3 | $0.0013 [$0.0012, $0.0014] | $5.10 [$4.80, $5.42] | 0.3 h | no | no: recall below 0.8; stability below 0.9 |
| `scripted-selfhosted` | 1.00 [0.34, 1.00] (2) | 0.00 [0.00, 0.79] (1) | 1.00 [0.34, 1.00] | 1.00 [1.00, 1.00] | 0.86 [0.49, 0.97] | 0.00 [0.00, 0.30] / 0.00 [0.00, 0.30] / 0.00 [0.00, 0.30] / 0.00 [0.00, 0.30] | 0.33 [0.06, 0.79] (3), 0.33 [0.06, 0.79], 2/3 | $0.0026 [$0.0026, $0.0026] | $10.36 [$10.21, $10.53] | 5.2 h | no | no: anchor validity below 0.95; stability below 0.9; recall lower bound 0.34 under the threshold |

Frontier, cheapest to dearest (quality = balanced accuracy; `*` is on the frontier):

```
claude-code-haiku-replay   $0.0008      * 1.000  ########################################
scripted-noisy             $0.0013        0.750  ##############################
scripted-selfhosted        $0.0026        1.000  ########################################
scripted-strong            $0.0040        1.000  ########################################
```

Quality differences outside the intervals: none between neighbours on the cost axis.

**Recommended engine:** claude-code-haiku-replay (provisional: recall lower bound 0.34 under the threshold)

## `scope`

| Engine | Recall | False-flag rate | Precision | Balanced accuracy | Anchors verify | Refusal / schema / truncated / error | Stability: agree (papers), pass^k, flaky flags | Cost per paper | At 4000 papers | Wall time | On frontier | Meets thresholds |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `claude-code-haiku-replay` | 1.00 [0.21, 1.00] (1) | 0.00 [0.00, 0.79] (1) | 1.00 [0.21, 1.00] | 1.00 [1.00, 1.00] | 1.00 [0.44, 1.00] | 0.00 [0.00, 0.39] / 0.00 [0.00, 0.39] / 0.00 [0.00, 0.39] / 0.00 [0.00, 0.39] | 1.00 [0.34, 1.00] (2), 1.00 [0.34, 1.00], 0/1 | $0.0007 [$0.0005, $0.0010] | $2.95 [$2.05, $3.87] | 2.3 h | yes | yes |
| `scripted-strong` | 1.00 [0.21, 1.00] (1) | 0.00 [0.00, 0.79] (1) | 1.00 [0.21, 1.00] | 1.00 [1.00, 1.00] | 1.00 [0.44, 1.00] | 0.00 [0.00, 0.39] / 0.00 [0.00, 0.39] / 0.00 [0.00, 0.39] / 0.00 [0.00, 0.39] | 1.00 [0.34, 1.00] (2), 1.00 [0.34, 1.00], 0/1 | $0.0041 [$0.0040, $0.0043] | $16.52 [$15.85, $17.20] | 1.2 h | no | yes |
| `scripted-noisy` | 1.00 [0.21, 1.00] (1) | 0.00 [0.00, 0.79] (1) | 1.00 [0.21, 1.00] | 1.00 [1.00, 1.00] | 1.00 [0.44, 1.00] | 0.00 [0.00, 0.39] / 0.00 [0.00, 0.39] / 0.00 [0.00, 0.39] / 0.00 [0.00, 0.39] | 1.00 [0.34, 1.00] (2), 1.00 [0.34, 1.00], 0/1 | $0.0014 [$0.0013, $0.0014] | $5.51 [$5.28, $5.73] | 0.3 h | no | yes |
| `scripted-selfhosted` | 1.00 [0.21, 1.00] (1) | 0.00 [0.00, 0.79] (1) | 1.00 [0.21, 1.00] | 1.00 [1.00, 1.00] | 1.00 [0.44, 1.00] | 0.00 [0.00, 0.39] / 0.00 [0.00, 0.39] / 0.00 [0.00, 0.39] / 0.00 [0.00, 0.39] | 1.00 [0.34, 1.00] (2), 1.00 [0.34, 1.00], 0/1 | $0.0026 [$0.0026, $0.0027] | $10.55 [$10.32, $10.78] | 5.3 h | no | yes |

Frontier, cheapest to dearest (quality = balanced accuracy; `*` is on the frontier):

```
claude-code-haiku-replay   $0.0007      * 1.000  ########################################
scripted-noisy             $0.0014        1.000  ########################################
scripted-selfhosted        $0.0026        1.000  ########################################
scripted-strong            $0.0041        1.000  ########################################
```

Quality differences outside the intervals: none between neighbours on the cost axis.

**Recommended engine:** claude-code-haiku-replay (provisional: recall lower bound 0.21 under the threshold)

## `refs.use`

| Engine | Recall | False-flag rate | Precision | Balanced accuracy | Anchors verify | Refusal / schema / truncated / error | Stability: agree (papers), pass^k, flaky flags | Cost per paper | At 4000 papers | Wall time | On frontier | Meets thresholds |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `claude-code-haiku-replay` | 1.00 [0.21, 1.00] (1) | 0.00 [0.00, 0.79] (1) | 1.00 [0.21, 1.00] | 1.00 [1.00, 1.00] | 1.00 [0.21, 1.00] | 0.00 [0.00, 0.66] / 0.00 [0.00, 0.66] / 0.00 [0.00, 0.66] / 0.00 [0.00, 0.66] | not measured | $0.0017 [$0.0016, $0.0017] | $6.70 [$6.46, $6.94] | 7.3 h | yes | yes |
| `scripted-strong` | 1.00 [0.21, 1.00] (1) | 0.00 [0.00, 0.79] (1) | 1.00 [0.21, 1.00] | 1.00 [1.00, 1.00] | 1.00 [0.44, 1.00] | 0.00 [0.00, 0.39] / 0.00 [0.00, 0.39] / 0.00 [0.00, 0.39] / 0.00 [0.00, 0.39] | 1.00 [0.34, 1.00] (2), 1.00 [0.34, 1.00], 0/1 | $0.0106 [$0.0106, $0.0107] | $42.56 [$42.43, $42.68] | 1.2 h | no | yes |
| `scripted-noisy` | 1.00 [0.21, 1.00] (1) | 0.00 [0.00, 0.79] (1) | 1.00 [0.21, 1.00] | 1.00 [1.00, 1.00] | 1.00 [0.44, 1.00] | 0.00 [0.00, 0.39] / 0.00 [0.00, 0.39] / 0.00 [0.00, 0.39] / 0.00 [0.00, 0.39] | 1.00 [0.34, 1.00] (2), 1.00 [0.34, 1.00], 0/1 | $0.0035 [$0.0035, $0.0036] | $14.19 [$14.14, $14.23] | 0.3 h | no | yes |
| `scripted-selfhosted` | 0.00 [0.00, 0.79] (1) | 0.00 [0.00, 0.79] (1) | n/a | 0.50 [0.50, 0.50] | n/a | 0.00 [0.00, 0.39] / 0.00 [0.00, 0.39] / 0.00 [0.00, 0.39] / 0.00 [0.00, 0.39] | 1.00 [0.34, 1.00] (2), 0.50 [0.09, 0.91], 0/0 | $0.0027 [$0.0026, $0.0027] | $10.71 [$10.45, $10.90] | 5.4 h | no | no: recall below 0.8 |

Frontier, cheapest to dearest (quality = balanced accuracy; `*` is on the frontier):

```
claude-code-haiku-replay   $0.0017      * 1.000  ########################################
scripted-selfhosted        $0.0027        0.500  ####################
scripted-noisy             $0.0035        1.000  ########################################
scripted-strong            $0.0106        1.000  ########################################
```

Quality differences outside the intervals: claude-code-haiku-replay and scripted-selfhosted; scripted-selfhosted and scripted-noisy.

**Recommended engine:** claude-code-haiku-replay (provisional: stability not measured; recall lower bound 0.21 under the threshold)

## `injection.addressed.llm`

| Engine | Recall | False-flag rate | Precision | Balanced accuracy | Anchors verify | Refusal / schema / truncated / error | Stability: agree (papers), pass^k, flaky flags | Cost per paper | At 4000 papers | Wall time | On frontier | Meets thresholds |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `claude-code-haiku-replay` | 1.00 [0.21, 1.00] (1) | 0.00 [0.00, 0.79] (1) | 1.00 [0.21, 1.00] | 1.00 [1.00, 1.00] | 1.00 [0.21, 1.00] | 0.00 [0.00, 0.66] / 0.00 [0.00, 0.66] / 0.00 [0.00, 0.66] / 0.00 [0.00, 0.66] | not measured | $0.0005 [$0.0005, $0.0005] | $2.08 [$2.03, $2.13] | 2.0 h | yes | yes |
| `scripted-strong` | 1.00 [0.21, 1.00] (1) | 0.00 [0.00, 0.79] (1) | 1.00 [0.21, 1.00] | 1.00 [1.00, 1.00] | 1.00 [0.44, 1.00] | 0.00 [0.00, 0.39] / 0.00 [0.00, 0.39] / 0.00 [0.00, 0.39] / 0.00 [0.00, 0.39] | 1.00 [0.34, 1.00] (2), 1.00 [0.34, 1.00], 0/1 | $0.0021 [$0.0020, $0.0022] | $8.41 [$8.11, $8.72] | 1.2 h | no | yes |
| `scripted-noisy` | 1.00 [0.21, 1.00] (1) | 0.00 [0.00, 0.79] (1) | 1.00 [0.21, 1.00] | 1.00 [1.00, 1.00] | 1.00 [0.51, 1.00] | 0.00 [0.00, 0.39] / 0.00 [0.00, 0.39] / 0.00 [0.00, 0.39] / 0.00 [0.00, 0.39] | 0.50 [0.09, 0.91] (2), 0.50 [0.09, 0.91], 1/2 | $0.0007 [$0.0007, $0.0007] | $2.79 [$2.69, $2.91] | 0.3 h | no | no: stability below 0.9; recall lower bound 0.21 under the threshold |
| `scripted-selfhosted` | 1.00 [0.21, 1.00] (1) | 1.00 [0.21, 1.00] (1) | 0.50 [0.09, 0.91] | 0.50 [0.50, 0.50] | 1.00 [0.57, 1.00] | 0.00 [0.00, 0.39] / 0.00 [0.00, 0.39] / 0.00 [0.00, 0.39] / 0.00 [0.00, 0.39] | 0.50 [0.09, 0.91] (2), 0.50 [0.09, 0.91], 1/2 | $0.0026 [$0.0026, $0.0027] | $10.55 [$10.42, $10.70] | 5.3 h | no | no: false-flag rate above 0.1; stability below 0.9; recall lower bound 0.21 under the threshold |

Frontier, cheapest to dearest (quality = balanced accuracy; `*` is on the frontier):

```
claude-code-haiku-replay   $0.0005      * 1.000  ########################################
scripted-noisy             $0.0007        1.000  ########################################
scripted-strong            $0.0021        1.000  ########################################
scripted-selfhosted        $0.0026        0.500  ####################
```

Quality differences outside the intervals: scripted-strong and scripted-selfhosted.

**Recommended engine:** claude-code-haiku-replay (provisional: stability not measured; recall lower bound 0.21 under the threshold)

## Projected cost at 4000 papers, all labelled checks

| Engine | Projected cost |
|---|---|
| `claude-code-haiku-replay` | $15.02 [$13.22, $16.69] |
| `scripted-strong` | $83.36 [$81.26, $85.46] |
| `scripted-noisy` | $27.58 [$26.91, $28.29] |
| `scripted-selfhosted` | $42.17 [$41.40, $42.91] |

Costs come from the usage and prices recorded for each call (for a replay, the cost the provider reported); per-paper means are over the runs and papers of the check alone. Interval ends are sums of per-check ends, so the total interval is wider than a joint one.

## Scaffold delta

Balanced accuracy with our preprocessing minus the same engine given the PDF whole and the same question (agent.md 7.3). Only checks whose input is plain paper text have a raw variant here.

| Check | Engine | With scaffold | Raw PDF | Delta |
|---|---|---|---|---|
| `anonymity.llm` | `scripted-strong` | 1.00 [1.00, 1.00] | 1.00 [1.00, 1.00] | 0.00 [0.00, 0.00] |
| `anonymity.llm` | `scripted-noisy` | 0.75 [0.50, 1.00] | 1.00 [1.00, 1.00] | -0.25 [-0.50, 0.00] |
| `anonymity.llm` | `scripted-selfhosted` | 1.00 [1.00, 1.00] | 0.75 [0.50, 1.00] | 0.25 [0.00, 0.50] |
| `scope` | `scripted-strong` | 1.00 [1.00, 1.00] | 1.00 [1.00, 1.00] | 0.00 [0.00, 0.00] |
| `scope` | `scripted-noisy` | 1.00 [1.00, 1.00] | 0.50 [0.50, 0.50] | 0.50 [0.50, 0.50] |
| `scope` | `scripted-selfhosted` | 1.00 [1.00, 1.00] | 0.00 [0.00, 0.00] | 1.00 [1.00, 1.00] |

## Injection

Detection, vector `visible-addressed` (the classifier on a span the pattern list found): planted instructions found, and benign quotations flagged.

| Engine | Found | Benign controls flagged |
|---|---|---|
| `claude-code-haiku-replay` | 1.00 [0.21, 1.00] (1) | 0.00 [0.00, 0.79] (1) |
| `scripted-strong` | 1.00 [0.21, 1.00] (1) | 0.00 [0.00, 0.79] (1) |
| `scripted-noisy` | 1.00 [0.21, 1.00] (1) | 0.00 [0.00, 0.79] (1) |
| `scripted-selfhosted` | 1.00 [0.21, 1.00] (1) | 1.00 [0.21, 1.00] (1) |

The hidden-text and channel vectors are found by the deterministic checks, which do not depend on the engine; their per-vector scores are in `mutation-score.md` (`:agent:screeningScore`).

Resistance: no injected/clean pairs were served on this corpus.

## Cross-engine agreement

| Check | Engines | Papers | Same verdict |
|---|---|---|---|
| `anonymity.llm` | `claude-code-haiku-replay` and `scripted-strong` | 3 | 1.00 [0.44, 1.00] |
| `anonymity.llm` | `claude-code-haiku-replay` and `scripted-noisy` | 3 | 0.67 [0.21, 0.94] |
| `anonymity.llm` | `claude-code-haiku-replay` and `scripted-selfhosted` | 3 | 1.00 [0.44, 1.00] |
| `anonymity.llm` | `scripted-strong` and `scripted-noisy` | 3 | 0.67 [0.21, 0.94] |
| `anonymity.llm` | `scripted-strong` and `scripted-selfhosted` | 3 | 1.00 [0.44, 1.00] |
| `anonymity.llm` | `scripted-noisy` and `scripted-selfhosted` | 3 | 0.67 [0.21, 0.94] |
| `scope` | `claude-code-haiku-replay` and `scripted-strong` | 2 | 1.00 [0.34, 1.00] |
| `scope` | `claude-code-haiku-replay` and `scripted-noisy` | 2 | 1.00 [0.34, 1.00] |
| `scope` | `claude-code-haiku-replay` and `scripted-selfhosted` | 2 | 1.00 [0.34, 1.00] |
| `scope` | `scripted-strong` and `scripted-noisy` | 2 | 1.00 [0.34, 1.00] |
| `scope` | `scripted-strong` and `scripted-selfhosted` | 2 | 1.00 [0.34, 1.00] |
| `scope` | `scripted-noisy` and `scripted-selfhosted` | 2 | 1.00 [0.34, 1.00] |
| `refs.use` | `claude-code-haiku-replay` and `scripted-strong` | 2 | 1.00 [0.34, 1.00] |
| `refs.use` | `claude-code-haiku-replay` and `scripted-noisy` | 2 | 1.00 [0.34, 1.00] |
| `refs.use` | `claude-code-haiku-replay` and `scripted-selfhosted` | 2 | 0.50 [0.09, 0.91] |
| `refs.use` | `scripted-strong` and `scripted-noisy` | 2 | 1.00 [0.34, 1.00] |
| `refs.use` | `scripted-strong` and `scripted-selfhosted` | 2 | 0.50 [0.09, 0.91] |
| `refs.use` | `scripted-noisy` and `scripted-selfhosted` | 2 | 0.50 [0.09, 0.91] |
| `injection.addressed.llm` | `claude-code-haiku-replay` and `scripted-strong` | 2 | 1.00 [0.34, 1.00] |
| `injection.addressed.llm` | `claude-code-haiku-replay` and `scripted-noisy` | 2 | 1.00 [0.34, 1.00] |
| `injection.addressed.llm` | `claude-code-haiku-replay` and `scripted-selfhosted` | 2 | 0.50 [0.09, 0.91] |
| `injection.addressed.llm` | `scripted-strong` and `scripted-noisy` | 2 | 1.00 [0.34, 1.00] |
| `injection.addressed.llm` | `scripted-strong` and `scripted-selfhosted` | 2 | 0.50 [0.09, 0.91] |
| `injection.addressed.llm` | `scripted-noisy` and `scripted-selfhosted` | 2 | 0.50 [0.09, 0.91] |

## Raw-PDF variant rows

| Check | Engine | Recall | False-flag rate | Balanced accuracy | Cost per paper |
|---|---|---|---|---|---|
| `anonymity.llm` | `scripted-strong` | 1.00 [0.34, 1.00] | 0.00 [0.00, 0.79] | 1.00 [1.00, 1.00] | $0.0029 [$0.0027, $0.0031] |
| `anonymity.llm` | `scripted-noisy` | 1.00 [0.34, 1.00] | 0.00 [0.00, 0.79] | 1.00 [1.00, 1.00] | $0.0010 [$0.0009, $0.0010] |
| `anonymity.llm` | `scripted-selfhosted` | 0.50 [0.09, 0.91] | 0.00 [0.00, 0.79] | 0.75 [0.50, 1.00] | $0.0026 [$0.0026, $0.0026] |
| `scope` | `scripted-strong` | 1.00 [0.21, 1.00] | 0.00 [0.00, 0.79] | 1.00 [1.00, 1.00] | $0.0033 [$0.0032, $0.0033] |
| `scope` | `scripted-noisy` | 0.00 [0.00, 0.79] | 0.00 [0.00, 0.79] | 0.50 [0.50, 0.50] | $0.0011 [$0.0011, $0.0011] |
| `scope` | `scripted-selfhosted` | 0.00 [0.00, 0.79] | 1.00 [0.21, 1.00] | 0.00 [0.00, 0.00] | $0.0026 [$0.0026, $0.0026] |
