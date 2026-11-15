# AGENTS.md

These instructions are for anyone working in this repo, human or coding agent. Read [docs/concepts.md](docs/concepts.md), [docs/spec.md](docs/spec.md), and [PLAN.md](PLAN.md) before changing code. Work one PLAN milestone at a time, and say which one in the PR title.

## Non-negotiables

1. **Synthetic data only.** This tool reads confidential peer-review data: reviews, discussions, and reviewer identities. Nothing real may ever enter the repo, issues, PRs, CI logs, screenshots, or test fixtures. All fixtures come from `seed/` scenarios with invented names at `example.org`.
2. **Never point code, tests, or scripts at a real HotCRP instance.** Tests run only against the harness (`scripts/hotcrp-up.sh`). Test helpers must refuse to start unless `PCS_HOTCRP_URL` is a `127.0.0.1`/`localhost` URL. The one exception is `pcs probe` (PLAN M0): it is read-only, prints no content, and the chair runs it by hand.
3. **No writes to HotCRP outside the harness.** The app is read-only until M5. From then on, every write is a Writeback artifact: dry run first, then explicit confirmation by a chair.
4. **No LLM or third-party service ever receives review or comment text.** The screening agent ([docs/agent.md](docs/agent.md)) may send *submission* content only to engines whose clearance covers its data class. That check lives in the dispatcher, and no adapter may bypass it. Its only other network calls are to the reference-resolver allowlist (`PCS_AGENT_EGRESS`), with reference metadata only. CI and tests use the `synthetic` corpus and the `replay` engine, never a live model with non-synthetic data. Argos visual testing is the one exception, and only because it receives **harness screenshots of synthetic data, from CI**. Never run an Argos upload (`CI=1` or `ARGOS_TOKEN` set) against anything except the harness. The only outbound network calls the app makes at runtime go to `PCS_HOTCRP_URL`. No telemetry, analytics, error reporters, auto-update checks, or remote fonts.
5. **Secrets stay in `core` and the OS keychain.** The token and DB key never reach the UI layer, a log, or an error message. Nothing listens on a network port.
6. **Never commit `.env*`, `pcs.conf` (except `pcs.conf.example`), a real answers file, a screening bundle, `*.db`, or `data/`.** These are already in `.gitignore`; don't weaken it.

## Conventions

- **Configuration (spec §4.1).**
  - Policy choices are readings in the answers file, never settings. A rule that depends on an open question reads the reading; an unresolved question blocks it visibly.
  - Every operational setting gets a `PCS_*` name, an entry in `core`'s config loader, and a documented line in `pcs.conf.example`, all in the same PR. Don't hard-code dates, URLs, field UIDs, or tag names.
- **Time:** never call `Clock.System.now()`, `Instant.now()`, or `System.currentTimeMillis()` in logic. Use `core`'s `Clock`, which honors `PCS_NOW`. Phase logic must be testable at any instant.
- **HotCRP access goes through `core`'s HotCRP client.** Every response is decoded strictly. When HotCRP surprises you, fix the schema and add a contract test; don't add a `try/catch` that hides it.
- **`core` has no UI imports.** The app, the CLI, and the agent depend on `core`, never the other way round.
- **Every test names its claims** with `@Covers(...)` (PLAN §A2). Expected results come from the Lean model (the oracle, the cards, or exported traces), never from the test's own reasoning. A PR that finishes a milestone shows that milestone's claims at the PLAN §A7 gates in the assurance report.
- **Rules come from the model.** A rule in concepts.md is implemented once in `core`, and its tests are the model's example cards (generated; PLAN M1). Don't hand-write a test that duplicates a card. When a card and the code disagree, the card wins unless concepts.md changes.
- **Discussion rules (spec §5c):**
  - One function per rule.
  - Each rule's weight and threshold come from settings.
  - Each rule returns a reason string containing the actual numbers.
  - If you change a rule's behavior, update the golden table in PLAN.md and the tests together.
- **HotCRP conventions (spec §11)** are the shared record. A new action by a non-chair role needs a row there, a parser, and a harness test before anything reads it.
- **UI wording follows spec §7.** Write "no comments yet", not "disengaged". Never show a ranked leaderboard of people.
- **Scale:** assume ~4,000 papers, ~12k reviews, and ~3,300 reviewers. Do the work in SQL with indexes, use lazy tables, and don't load all text into memory.
- **Ported code keeps its license notice.** If the solver ports HotCRP's `lib/mincostmaxflow.php` or `src/autoassigner.php` (MIT-style, © Eddie Kohler), keep the copyright notice and a `Ported from hotcrp@<commit>` line at the top of each ported file.
- Kotlin with explicit API mode in `core`; warnings are errors. Keep dependencies minimal; justify new ones in the PR description.
- **Inference goes through `agent`'s engine layer.** Checks never import a provider SDK. Claude is called through Anthropic's SDK clients, or through the `claude` CLI adapter, never through an OpenAI-compatible shim. Don't hard-code model IDs, and don't send sampling parameters.
- **Check changes are versioned by content.** Editing a check's prompt, schema, or code makes a new version, which must be requalified before production use (agent.md §7.4). Include its `pcs agent plan` output in the PR.
- **The concepts and the model change together.** A change to a rule, property, open question, or example card in docs/concepts.md updates `model/` in the same PR: `lake build` must pass (it checks the proofs), and `model/model-report.txt` is regenerated from `answers/synthetic.txt`. A venue's real answers file never enters the repo.

## Running things

```bash
scripts/hotcrp-up.sh             # disposable HotCRP at 127.0.0.1:8080, writes .env.test
scripts/harness-smoke.sh         # canary: seeds 1 paper, checks the API paths we use
docker compose -p pcs -f hotcrp/compose.yaml down -v   # reset

./gradlew check                  # lint, unit, property, model-generated tests; also :app:uiTest when a harness (.env.test) and a display or Xvfb exist, else it says why not
set -a; . ./.env.test; set +a
./gradlew integrationTest
./gradlew uiTest
(cd model && lake build && lake exe report answers/synthetic.txt)
```

To try the app against seeded data, run `./gradlew :seed:run --args="shadow"`, then `./gradlew :app:run`.

## HotCRP harness gotchas (already solved; don't re-learn them)

- **Bearer auth:** Apache needs `SetEnvIf Authorization` to pass the token through. This is set in `hotcrp/Dockerfile`.
- **Review deadlines:** `POST /reviews` ignores `override` for JSON bodies, so open review deadlines in settings instead (see `harness-smoke.sh`).
- **PDFs:** a paper counts as submitted only once it has a PDF. `content_file` paths in `savepapers.php` JSON must be relative to the JSON file's directory.
- **Review `modified_at`:** it is omitted when `reviewModified <= timeRequested`, and that includes same-second seeding. When you time-warp, shift a review's timestamps together, keeping `timeRequested` earliest.
- **Comment authorship:** write comments as other users with `actas=<email>` (chair token), and pass `notify=0` everywhere.
- **Version tags:** review `version` is an opaque vtag. Compare with `!==` only.

## Bumping HotCRP

Change `HOTCRP_REF` in `hotcrp/Dockerfile`, `hotcrp/compose.yaml`, and `.github/workflows/ci.yml` together. Run the contract tests. The nightly job already runs against `master` to warn early.

## PR checklist

- [ ] Milestone named; its acceptance criteria are listed and pass in CI, and its **Evidence** claims meet the PLAN §A7 gates.
- [ ] New settings are in `core`'s config loader and `pcs.conf.example`; policy choices are readings, not settings.
- [ ] No real data, no non-harness URLs in tests, no new outbound calls.
- [ ] docs/spec.md updated if behavior, a HotCRP convention (§11), or the API understanding changed.
- [ ] If docs/concepts.md changed: `model/` updated, `lake build` passes, `model/model-report.txt` regenerated.
