# PC Supervisor

A desktop app for the chairs of a program committee that runs on HotCRP. It supports the whole review process: reciprocal-reviewer nominations and PC appointments, submission screening and desk reject, assignment, reviewing with accountability requests, early reject, and discussion. During discussion it answers three questions:

- **Papers:** which papers are in trouble? It ranks them, with plain reasons: split scores with no movement, silent discussion, an AC who hasn't posted, a looming deadline with no consensus.
- **Area chairs:** which ACs are keeping their papers moving? It shows coverage, time to first post, nudges, and stale papers, alongside each AC's load.
- **Reviewers:** who is engaging in discussion? It lists outliers, such as reviewers silent on split papers or with unanswered pings, split by senior, junior, and nominee.

Each chair runs their own copy. It syncs from the HotCRP API into an encrypted local SQLite file, keeps snapshots so it can see change over time, and drafts every change to HotCRP as an artifact a chair dry-runs and confirms. HotCRP stays the shared record, so there is no server.

> **Status:** pre-alpha. The harness, CI, the conceptual design, and its Lean model are in place; the app is not built yet. See [PLAN.md](PLAN.md).

## Docs

- [docs/concepts.md](docs/concepts.md): the review process it supports: concepts, rules, policy, properties, and examples.
- [docs/spec.md](docs/spec.md): how it's built: the HotCRP API facts it relies on, the architecture, the data model, the rules, the HotCRP conventions, and testing.
- [docs/agent.md](docs/agent.md): the submission-screening agent.
- [model/](model/README.md): the Lean model of concepts.md, with proofs, example cards, the policy table, and a reference assignment solver.
- [PLAN.md](PLAN.md): milestones, acceptance criteria, and the golden test scenario.
- [AGENTS.md](AGENTS.md): rules for contributors and coding agents. Read this before writing code.
- [docs/ci.md](docs/ci.md): how CI runs a disposable HotCRP on the Ripley self-hosted runners.

## Development

You need Docker (with Compose v2), JDK 21, and, for the model, Lean (`elan`).

```bash
scripts/hotcrp-up.sh        # throwaway HotCRP + MariaDB at http://127.0.0.1:8080
scripts/harness-smoke.sh    # seeds one paper and checks the API paths the app uses
docker compose -p pcs -f hotcrp/compose.yaml down -v    # throw it away
```

`hotcrp-up.sh` creates a chair account (`admin@example.org`), mints an API token, and writes `PCS_HOTCRP_URL` and `PCS_HOTCRP_TOKEN` to `.env.test`. Once the app exists, see AGENTS.md for the Gradle commands.

## Using it on a real conference

1. Install the signed release for your OS.
2. Get a chair API token: HotCRP → Account settings → Developer. The app stores it in the OS keychain.
3. Write the conference file (`pcs.conf`; `pcs.conf.example` documents every key) and the answers file with the chairs' rulings. Keep both outside this repo.
4. Run `pcs probe` once to confirm the instance's review-form field UIDs, score scales, and tag settings.
5. Open the app, pick the conference, and sync.
6. When the PC is over, run `pcs wipe`.

The local database holds every review and comment. Keep it off synced folders and backups that leave the machine, and never share screenshots of the real data.

## CI

GitHub Actions on the `ripley-cloud` self-hosted runners. Each job builds HotCRP from a pinned commit, seeds it, and runs unit, model-generated, contract, integration, and UI tests, and checks the Lean proofs. A nightly job also tests against HotCRP `master` and runs the 4,000-paper scale scenario. CI never touches a real conference. Details are in [docs/ci.md](docs/ci.md).
