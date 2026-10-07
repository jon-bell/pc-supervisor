# AGENTS.md

These instructions are for anyone working in this repo, human or coding agent. Read [docs/spec.md](docs/spec.md) and [PLAN.md](PLAN.md) before changing code. Work one PLAN milestone at a time, and say which one in the PR title.

## Non-negotiables

1. **Synthetic data only.** This tool reads confidential peer-review data: reviews, discussions, and reviewer identities. Nothing real may ever enter the repo, issues, PRs, CI logs, screenshots, or test fixtures. All fixtures come from `seed/` scenarios with invented names at `example.org`.
2. **Never point code, tests, or scripts at a real HotCRP instance.** Tests run only against the harness (`scripts/hotcrp-up.sh`). Test helpers must refuse to start unless `PCS_HOTCRP_URL` is a `127.0.0.1`/`localhost` URL. The one exception is `pcs probe` (PLAN M0): it is read-only, prints no content, and the chair runs it by hand.
3. **No writes to HotCRP outside the harness.** The app is read-only until M8, and M8's writes are dry-run-first with explicit confirmation.
4. **No LLM or third-party service ever receives review or comment text.** The only outbound network calls allowed at runtime go to `PCS_HOTCRP_URL`. No telemetry, analytics, error reporters, or CDN fonts.
5. **The token stays server-side.** It is never sent to the browser, logged, or included in error messages.
6. **Never commit `.env*` (except `.env.example`), `*.db`, or `data/`.** These are already in `.gitignore`; don't weaken it.

## Conventions

- **Config is environment variables only.**
  - Every new setting gets a `PCS_*` name, a Zod entry in `server/src/config.ts`, and a documented line in `.env.example`, all in the same PR.
  - Don't add config files or hard-code dates, URLs, or field UIDs.
- **Time:** never call `Date.now()` / `new Date()` directly in logic. Use `server/src/clock.ts`, which honors `PCS_NOW`. Phase logic must be testable at any instant.
- **HotCRP access goes through `server/src/hotcrp/`.** Every response is parsed with its Zod schema. When HotCRP surprises you, fix the schema and add a contract test; don't add a `try/catch` that hides it.
- **Rules (spec §5c):**
  - One function per rule.
  - Each rule's weight and threshold come from env.
  - Each rule returns a reason string containing the actual numbers.
  - If you change a rule's behavior, update the golden table in PLAN.md and the tests together.
- **UI wording follows spec §7.** Write "no comments yet", not "disengaged". Never show a ranked leaderboard of people.
- **Scale:** assume 2,400 papers and 10k reviews. Do the work in SQL with indexes, use virtualized tables, and don't load all text into memory.
- TypeScript strict mode. Keep dependencies minimal; justify new ones in the PR description.

## Running things

```bash
scripts/hotcrp-up.sh             # disposable HotCRP at 127.0.0.1:8080, writes .env.test
scripts/harness-smoke.sh         # canary: seeds 1 paper, checks the API paths we use
docker compose -p pcs -f hotcrp/compose.yaml down -v   # reset

npm ci
npm run lint && npm run typecheck && npm run test:unit
set -a; . ./.env.test; set +a
npm run test:integration
npm run test:e2e
```

To try the UI against seeded data, run `npm run seed -- shadow`, then `npm run dev`.

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

- [ ] Milestone named; its acceptance criteria are listed and pass in CI.
- [ ] New env vars are in `config.ts` and `.env.example`.
- [ ] No real data, no non-harness URLs in tests, no new outbound calls.
- [ ] docs/spec.md updated if behavior or the API understanding changed.
