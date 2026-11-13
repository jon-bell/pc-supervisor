# PC Supervisor: submission-screening agent

The conceptual design (concepts, rules, policy, properties, and examples in HUSL style) is [concepts.md](concepts.md). Where the two disagree, concepts.md wins and this file gets fixed. In concepts.md, decision records are called **rulings**.

This document specifies the agent that screens submissions before review. It finds evidence for desk-reject decisions, writes structured contribution summaries for area chairs, and does it for any model on any inference engine. It extends [spec.md](spec.md) §10.4 B (the desk-reject tracker), which previously expected an external `refcheck` import. Milestones are M8–M12 in [PLAN.md](../PLAN.md), with triage and desk reject in M13.

> **Decided:**
> - The agent **only flags**. It never rejects, never scores, and never writes to HotCRP. Every desk-reject decision is made by people, and never by one person alone (§2).
> - "This paper appears AI-written" is **not** a flag. The grounds are format, scope, anonymity, references, and the paper's claimed contribution, each with quoted evidence.
> - **Inference is pluggable.** Every check runs on any engine that implements §4, and the choice of engine per check is data that comes from a measured comparison (§7), not code.
> - **Data never goes to an engine that isn't cleared for it** (§5). This is enforced in code, below the adapters.

---

## 1. Design principles

The agent is built so that the policy, the checks, and the inference can each change without touching the others, and so that every change costs only what it touches. Policy is still being decided while the software is written, and the best model next summer won't be today's.

1. **Decisions are first-class data.** Every policy choice the agent depends on is a *decision record* with a status (§3.1). An example is "missing DOIs are not grounds this cycle." Checks name the decisions they depend on. A check whose output depends on an `unresolved` decision is still computed, but its flags carry that dependency, and the UI shows them as blocked.
2. **Every judgment the system makes is listed in a manifest, in exactly one category** (§3.3):
   - deterministic, with evidence;
   - LLM judgment, bounded;
   - escalated to a person.

   Make the deterministic layer as thick as it honestly can be. Use the LLM only where a rule can't do the job, and say who is affected if it's wrong.
3. **People confirm views, not model prose.** An area chair reads a *flag card* (§6), which a fixed, deterministic renderer builds from the structured output. Every claim on a card is anchored to a quotation that the harness has checked against the extracted text. Model text that can't be anchored never reaches a person.
4. **Propose, never apply.** The agent's outputs are proposals stored locally. Like the rest of the tool (spec §10), the only way anything reaches HotCRP is a generated artifact (tags or comments) that a chair applies through HotCRP, with a dry run first.
5. **The same check runs on every engine.** A check is a versioned specification: inputs, preprocessing, prompt, output schema, evidence rule, and oracle. Engines are adapters. Swapping a model, a provider, or a prompt is a configuration change, and it is **qualified** by rerunning that check's evaluation (§7.4) before it touches real submissions.
6. **Cost follows the change.** Results are content-addressed (§4.4). Changing one check's prompt reruns that check only. A decision change reruns only the checks that cite it. A plan command shows what will rerun, what it will cost, and which flags it would move, before anything runs.

---

## 2. The process the agent serves

```
submission deadline
  └─ extract (deterministic): text with page anchors, parsed references, layout facts, hidden-text scan
       └─ checks (§3.2) ──► flags + summary, stored as proposals
            └─ AC triage (per paper, from flag cards + summary)
                 ├─ keep in review ────────────────────────────► assignment
                 └─ lean reject / unsure ──► second opinion (1 PC member, light load, not counted toward review load)
                                               ├─ keep ──────────────────► assignment (that PC member may stay on as a reviewer)
                                               └─ agree ──► chair action: desk reject (or fix window, if the policy grants one)
late anonymity violations (found during review) ──► same queue, allowed until reviews are released to authors
```

- The **desk-reject phase** has its own window between submission and final assignment (`PCS_PHASE_DESKREJECT_DUE`), and the authors are told the date. After it closes, desk rejects are corner cases (late anonymity violations) and are tracked as such.
- **The AC queue is ordered by evidence, not by verdict.** The UI never shows "the agent recommends rejecting these". It shows the flags and their evidence, plus papers with no flags as a separate, collapsed list.
- **Consistency across ACs** is monitored (spec §10.4 B): flag rates and desk-reject rates per AC and per topic area, with their spread. Wildly different rates across ACs are the failure to catch early.

---

## 3. Checks, decisions, and the manifest

### 3.1 Decision records

```
decision(id, title, status, statement, owner_role, decided_at, source, supersedes NULL)
  status ∈ settled | provisional | assumed | unresolved | referred
```

- `settled`: in force. `provisional`: in force but open to revision. `assumed`: the tool's default, which nobody has confirmed, and the UI shows it that way. `unresolved`: blocks every flag that depends on it. `referred`: outside the process chairs' authority (e.g. publisher policy).
- Decisions live **outside the repo**, in the instance's data directory (`PCS_AGENT_DECISIONS`, a YAML file), because their content is venue-specific. The repo holds the schema and synthetic examples only.
- Each check lists `depends_on: [decision ids]`. When a decision changes status or statement, the planner (§4.4) marks those checks stale.

### 3.2 Check catalog (initial)

| Check | Category | Method | Bound |
|---|---|---|---|
| `format` | deterministic | Page count, template and font facts, and margins from the PDF's layout. No LLM. | Flag with the measured values |
| `refs.doi` | deterministic | Parse the bibliography (local GROBID), then resolve DOIs and metadata against public indexes (§5.3). Missing DOIs are reported but are not grounds unless a decision says otherwise. | Flag non-resolving or mismatched references, with the bibliography entry |
| `anonymity` | deterministic, then bounded LLM | Deterministic scan of the paper, PDF metadata, and the artifact (author names, affiliations, URLs, repository owners, acknowledgments). Then an LLM pass for self-revealing phrasing ("our prior tool X [12]"). | Flag with the anchored span. Never infers identity |
| `scope` | bounded LLM | Is the paper within the call's topics, given the CFP text? | Flag with the paper's own claims, anchored |
| `refs.use` | bounded LLM | For each in-text citation: the citing sentence plus the cited work's abstract (or full text, as a variant). Is the work cited for something it doesn't say? | Flag per citation with both quotations. Never a paper-level verdict |
| `summary` | bounded LLM | A structured summary of about 500 words: claimed contributions, evaluation, the stated relation to prior work, and the closest cited work. Every field is anchored. | A view for triage, never a recommendation |
| `hidden-text` | deterministic | Text that is invisible when rendered (white-on-white, tiny fonts, off-page, rendered under images) that contains instructions. It is stripped before any LLM sees the paper, and flagged as an integrity issue in its own right. | Flag with the extracted text |
| `novelty` | **not in v1** | Recorded so the manifest shows it as an escalated judgment: ACs judge novelty and significance. The summary helps them decide where to look. | |

Each check is a directory, `agent/checks/<id>/`, containing:
- `check.yaml`: id, version, category, `depends_on`, the inputs, the output schema reference, the evidence rule, and who is affected if it's wrong;
- `prompt.md`, for LLM checks;
- `schema.json` (JSON Schema, from which the Kotlin output type is generated);
- `oracle/`: synthetic and public labeled examples, plus the mutation operators that create its known positives (§7.2).

The version is a content hash of the directory, so any edit is a new version.

### 3.3 The manifest

`pcs agent manifest` renders one table from the check directories, the decision file, and the qualification records (§7.4). Each row covers one judgment:
- its category;
- what establishes it (rule, labeled examples, mutation score, cross-engine agreement);
- the engine and version it is qualified on;
- the decisions it depends on, with their status;
- who is affected if it's wrong.

The program chairs sign off on this table, never on prompts or code. The CFP's description of desk-reject criteria is a view of the same data, so what the venue publishes and what the tool checks can't drift apart.

---

## 4. Inference engines

### 4.1 Workflow first, agent loop optional

Every v1 check is a **workflow**: deterministic code fetches, parses, and slices, then makes one or more single structured calls. Few model capabilities are needed (structured output and a context window), so every engine can run every check, and the comparison measures models, not harnesses.

An **agent-loop variant** (the model drives read-only tools such as `search_text`, `get_reference`, and `read_artifact_file`) is a shootout variable, not the default. The tools are implemented once and exposed two ways: as in-process functions for our own loop, and as an **MCP server** for harness engines (Claude Code). An agent loop is adopted for a check only if it beats the workflow version on that check's evaluation by more than it costs.

### 4.2 The interface

```kotlin
enum class DataClass { SYNTHETIC, PUBLIC, CONFIDENTIAL }

interface Engine {
    val id: String                    // e.g. "bedrock/<model>", "openai-compat/<host>/<model>"
    val clearance: DataClass          // §5; ceiling enforced outside the adapter
    val caps: Caps
    suspend fun call(req: CallRequest): CallResult
    suspend fun submitBatch(reqs: List<CallRequest>): BatchHandle? = null   // null: no batch support
    fun collectBatch(h: BatchHandle): Flow<CallResult> = emptyFlow()
}

data class Caps(
    val structured: Structured,       // NATIVE | GRAMMAR | TOOL | PROMPT: how JSON is guaranteed
    val pdfInput: Boolean,            // accepts a PDF directly
    val maxInputTokens: Int,
    val batch: Boolean,               // asynchronous batch submission
    val promptCache: Boolean,
    val toolLoop: ToolLoop,           // NONE | OWN | HARNESS
)

data class CallRequest(
    val key: String,                  // content address (§4.4)
    val check: CheckRef,              // id + version
    val dataClass: DataClass,
    val system: String,               // stable, cacheable prefix
    val parts: List<Part>,            // text with anchors | pdf | reference records
    val schema: JsonObject,           // the check's schema.json
    val effort: Effort? = null,       // LOW | MEDIUM | HIGH; mapped per provider, ignored where unsupported
    val maxOutputTokens: Int,
)

data class CallResult(
    val key: String,
    val status: Status,               // OK | SCHEMA_INVALID | REFUSAL | TRUNCATED | ERROR
    val output: JsonElement?,         // validated against schema
    val servedModel: String,          // as reported by the provider, not as requested
    val usage: Usage,                 // input, output, cacheRead, cacheWrite
    val costUsd: BigDecimal,          // usage × price table (settings), recorded at call time
    val latencyMs: Long,
    val attempts: Int,
    val raw: String,                  // stored encrypted; never logged
)
```

**There are no sampling parameters.** Several providers now reject `temperature` and similar settings, and nondeterminism is something we measure (§7.3), not something we try to switch off. `effort` is the only quality knob, and each adapter maps it to its provider's equivalent or drops it.

### 4.3 Adapters

Each adapter uses its provider's official client. Claude is always called through Anthropic's SDK clients, never through an OpenAI-compatible shim.

| Adapter | Covers | Structured output | Notes |
|---|---|---|---|
| `claude-code` | Claude through the `claude` CLI (`claude -p`) | `--json-schema` | **The development engine.** Authenticates with the developer's Claude Code login (OAuth), so no API key is needed. Uses isolation flags so a call carries only our prompt: `--strict-mcp-config --setting-sources "" --tools "" --system-prompt … --no-session-persistence --output-format json`. `--bare` is **not** usable here, because it reads only an API key. Cost, tokens, model, and latency come from the JSON envelope. Harness mode (`--mcp-config` pointed at the agent's tool server) runs the agent-loop variant. The same adapter also runs with an API key, or through Claude Code's cloud-provider modes (Bedrock / Vertex / Foundry environment switches; check the names against current Claude Code docs), which lets us confirm that dev and production produce the same results. |
| `anthropic` | Claude on the first-party API, Amazon Bedrock (Mantle client), Microsoft Foundry, Google Vertex | native (`output_config.format`) | Message Batches where the platform offers them. Prompt caching on the stable prefix (system + CFP + instructions). Handle the `refusal` stop reason explicitly. |
| `openai-compat` | Self-hosted servers (vLLM, SGLang, llama.cpp), Azure OpenAI, other OpenAI-API hosts | `response_format: json_schema` where supported, otherwise grammar (vLLM guided decoding), otherwise tool-call | The self-hosted path. The base URL and model come from env. Capabilities are probed at startup (`pcs agent probe <engine>`), not assumed. |
| `bedrock-converse` | Non-Claude models on Bedrock | tool-call JSON | Only if the comparison needs Bedrock-hosted open models. |
| `replay` | Recorded results | n/a | Serves stored `CallResult`s by key. Used in CI and to re-render views without spending tokens. |

Engines are declared entirely in env, one block per engine:

```
PCS_ENGINES=dev,api-sonnet,bedrock-a,selfhost-a
PCS_ENGINE_dev_ADAPTER=claude-code          PCS_ENGINE_dev_MODEL=<model id>
PCS_ENGINE_bedrock-a_ADAPTER=anthropic      PCS_ENGINE_bedrock-a_PLATFORM=bedrock  PCS_ENGINE_bedrock-a_REGION=…
PCS_ENGINE_selfhost-a_ADAPTER=openai-compat PCS_ENGINE_selfhost-a_BASE_URL=…      PCS_ENGINE_selfhost-a_MODEL=…
PCS_ENGINE_<id>_CLEARANCE=synthetic|public|confidential
PCS_ENGINE_<id>_CLEARANCE_DECISION=<decision id>   # required for confidential (§5)
PCS_ENGINE_<id>_PRICE_IN / _PRICE_OUT / _PRICE_CACHE_READ   # USD per 1M tokens; self-hosted: 0 + PCS_ENGINE_<id>_GPU_HOUR_USD
PCS_ENGINE_<id>_CONCURRENCY, _RPM, _TPM
PCS_CHECK_<check>_ENGINE=<engine id>        # production routing, set from the shootout (§7)
```

Model IDs are never hard-coded. A model whose provider can't offer the retention terms the instance requires is simply not given `confidential` clearance.

### 4.4 Content addressing, caching, and planning

- `key = H(input artifact hashes, check version, decision versions it depends on, engine id, requested model, effort, variant)`.
- Results are stored by key in the encrypted store, with a `run` table (who ran what, when, why, and the cost).
- `pcs agent plan <change>` takes a proposed change (an edited check, a different engine, or a decision edit) and reports four things without spending tokens:
  - which keys go stale;
  - the projected cost (from the usage recorded for those keys);
  - the projected wall time under the engine's rate limits;
  - after a run on the evaluation corpus, **which flags the change moves**: the diff of flags between the old and new configuration.
- `pcs agent run` executes a plan. It is resumable and idempotent, and it uses batch submission when the engine supports it and the deadline allows.

---

## 5. Confidentiality

### 5.1 Data classes and clearance

Every input carries a data class:
- `synthetic` covers generated papers;
- `public` covers published or preprint papers and public metadata;
- `confidential` covers anything from a live submission system, including titles, abstracts, PDFs, and artifacts.

A call is refused, with an error naming the engine and the class, unless `engine.clearance ≥ req.dataClass`. The check happens in the dispatcher, not in the adapters, so a new adapter can't skip it.

- `confidential` clearance additionally requires `PCS_ENGINE_<id>_CLEARANCE_DECISION` to name a `settled` decision record. That record states the agreement the engine runs under: the provider, zero or limited retention, and no training. The chairs settle it; the tool only checks that it exists.
- The **`claude-code` adapter defaults to a `public` ceiling**. A personal or seat login is a development credential. Raising it needs the same settled decision (for example, after an institutional agreement has been reviewed for this use).

### 5.2 Prompt injection

Submissions are adversarial input.
- Hidden text is removed and flagged before any model call (`hidden-text`).
- Paper content is always passed as delimited data, never as instructions.
- Outputs are schema-bound.
- Tools are read-only and scoped to the one paper being checked.
- No tool can reach the network except the reference resolver (§5.3).

The evaluation measures injection resistance directly (§7.2): how often an injected instruction changes a check's output.

### 5.3 Egress

The only runtime destinations are the HotCRP instance, the configured engines' endpoints, and the reference resolver's public indexes (`PCS_AGENT_EGRESS`, an allowlist: DOI resolution, Crossref, OpenAlex, arXiv). Resolver queries contain only reference metadata, never submission text or paper IDs. They go through one cache shared across all papers, and they use a generic client name. Fetched abstracts and open-access full texts are cached as `public` data.

### 5.4 Storage

Extracted text, call payloads, raw outputs, and flags live in the SQLCipher store (spec §7). The repo, CI, issues, and screenshots contain synthetic or public data only, as everywhere else in this project.

---

## 6. Outputs

- **Flag:** `(pid, check id + version, decision deps, kind, anchors[], explanation fields, engine, key)`. An anchor is `(page, char range, quoted text)`. Before a flag is stored, the harness checks that the quoted text appears at the anchor, with whitespace- and ligature-tolerant matching. A flag whose anchors fail is stored as `unverified` and is never shown to an AC. The unverified rate is an evaluation metric.
- **Flag card:** a fixed rendering of the check's name, the evidence with page links, the decisions it relies on (with their status), and the engine and version. The same renderer produces the CLI, web, and HotCRP-comment forms.
- **HotCRP artifacts** (spec §10): per-check tags (`#dr-format`, `#dr-anon`, …) and an optional AC-visible comment containing the flag card and the summary. These are generated as an assignment CSV and a comment batch, which a chair applies with a dry run first.

---

## 7. Evaluation and the model comparison

The same harness serves three purposes: developing a check, comparing engines, and qualifying a change.

### 7.1 Corpora, by data class

| Corpus | Class | Source | Use |
|---|---|---|---|
| `synthetic` | synthetic | Generated papers with planted defects | CI, development on any engine |
| `public` | public | Published SE papers (open access and preprints), plus the mutants of §7.2 | The main comparison. Development on the `claude-code` engine |
| `held-out` | public | A fixed sample of `public` that is never used while writing prompts | Reporting. Prevents tuning to the test set |
| `confidential` | confidential | Past decisions from a real venue, **only with that venue's chairs' permission** | Optional final check, on confidential-cleared engines only |

### 7.2 Oracles by mutation

Most checks have no labeled data, so known positives are made by **mutating clean public papers**. Each operator plants exactly one defect and records where it is:
- insert an author name, affiliation, or self-revealing sentence (in the paper or the artifact);
- corrupt a DOI, or add a plausible reference that doesn't exist;
- re-point a citation to a real but wrong work;
- swap the paper's domain so it falls outside the CFP;
- break the template;
- add hidden instructions.

The metrics are:
- **mutation score** per check (planted defects found, with correct anchors);
- **false-flag rate** on the unmutated originals;
- **non-vacuity**: a check that flags no mutant of its own kind fails qualification, however clean its false-flag rate looks.

For `summary`, which has no single right answer, the metrics are:
- anchor validity;
- coverage of the contributions the authors themselves list (mechanically extracted from the introduction);
- a small set of human ratings on `public` papers.

Any LLM judge used to score summaries is validated against those human ratings before its scores are trusted.

### 7.3 What is measured, per check × engine × variant

Each check runs `k` times (default 3) per paper. The measurements are:
- quality: precision and recall against the oracles, with confidence intervals;
- the share of anchors that verify;
- **flag stability**: agreement across the `k` runs. A flag that appears in some runs and not others is a *flaky flag*, and it is reported as such. Pass^k is used for the decisions that matter;
- refusal, schema-failure, and truncation rates;
- cost per paper, and cost projected to the instance size (`PCS_AGENT_SCALE_PAPERS`);
- latency, and projected wall time for the whole corpus under the engine's rate limits;
- injection resistance: how often a hidden-instruction mutant changes the output;
- **scaffold delta**: the score with our preprocessing (extraction, slicing, reference fetching) minus the score of the same model given only the raw PDF and the question. A delta that shrinks as models get stronger marks engineering we can drop. A delta that holds marks engineering worth maintaining;
- cross-engine agreement on `held-out`.

Variants include: the effort level; PDF input vs. extracted text; abstract-only vs. full-text `refs.use`; workflow vs. agent loop; and batch vs. online (cost only).

`pcs agent shootout --corpus held-out --checks … --engines …` writes a report. For each check it shows the quality/cost frontier across engines, with confidence intervals, and a recommended engine.

### 7.4 Qualification

A `(check version, engine, model, variant)` tuple may run on `confidential` data only if it has a **qualification record**: an evaluation run on `held-out` that meets the check's thresholds (`check.yaml`: minimum recall on its mutants, maximum false-flag rate, minimum anchor validity, minimum stability). Production runs refuse unqualified tuples.

Every change to the agent falls into one of three classes:
1. **Covered by existing evidence**, such as a price or concurrency change. Nothing reruns.
2. **Needs requalification**, such as a model upgrade, a prompt edit, or an engine swap. That check's evaluation reruns, and the result is compared with the previous qualification. Flags it moves on `held-out` are listed for review.
3. **Needs new evidence**, such as a new check, a new input kind, or a new mutation operator. It needs new oracles before it can be qualified.

The planner (§4.4) reports which class a change falls into. Failures found in production become new oracle cases.

---

## 8. Layout

```
agent/            Gradle module (Kotlin); depends on core
  engines/        adapters (§4.3) + dispatcher with the clearance check (§5.1)
  extract/        PDF text + anchors (PDFBox), GROBID client, layout facts, hidden-text scan
  tools/          read-only tools; exported in-process and as an MCP server
  checks/runner/  runner, anchor verification, flag-card renderer
  checks/<id>/    check specs (§3.2)
  eval/           corpora manifests (no PDFs in git for non-synthetic), mutation operators, shootout + qualification
```

The CLI commands are `pcs agent probe | plan | run | manifest | shootout | qualify | export-hotcrp | bundle`. `pcs agent bundle` writes the encrypted screening bundle that the chairs' apps import (spec §4, §10.3). GROBID runs as a local container next to the HotCRP harness, or in-process where its native libraries support the platform.
