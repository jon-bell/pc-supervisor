# CI: how HotCRP is rolled

## Decision

Each CI job builds and starts **its own disposable HotCRP + MariaDB with Docker Compose**, inside a **`ripley-cloud` self-hosted runner**. Those runners are ARC scale sets on the Ripley cluster, in `containerMode: dind`, so every runner pod has a private Docker daemon. The job tears the stack down at the end, and nothing persists between runs.

```
GitHub ──► ARC listener (arc-runners-jon-bell) ──► ephemeral runner pod
                                                   ├─ runner container: node, playwright, scripts/hotcrp-up.sh
                                                   └─ dind sidecar: hotcrp (php:8.3-apache @ HOTCRP_REF) + mariadb:10.11 (tmpfs)
```

`127.0.0.1:8080` is reachable from the runner container because the two containers share the pod's network namespace.

## Why this option

| Option | Verdict |
|---|---|
| **A. Compose in a dind runner, per job** (chosen) | The harness is identical on a laptop and in CI (`scripts/hotcrp-up.sh`), and every run is hermetic. Changing `HOTCRP_REF` is a one-line bump. It costs ~1–2 min of image build per run, which can be cached later (below). |
| B. Upstream-style bare metal: `setup-php` + a MariaDB `services:` container + `php -S` | This is what HotCRP's own CI does. But `php -S` is single-threaded, which hurts once Playwright and the sync run concurrently. It also behaves differently from local dev and depends on how ARC's dind handles `services:`. Rejected. |
| C. A long-lived HotCRP on Ripley k8s, reset per run by DB restore | Faster per run, but shared state means concurrent PRs collide. It's also ops we'd have to keep alive. **Use it only for exploration and scale demos** (a seeded `scale` instance a human can click around), never for per-PR CI. |
| D. A hosted hotcrp.com test instance | No way to reset, seed with batch scripts, or warp time. Rejected. |

## Runner labels

- `ripley-cloud`: the default for the `ci` job (dind; 4 CPU / 8 Gi limit).
- `ripley-cloud-large`: the nightly `scale` job (seeding ~10k reviews plus a full sync).
- `ripley-cloud-ramdisk` is available if MariaDB/tmpfs I/O ever becomes the bottleneck. It shouldn't, since the DB is already on tmpfs inside the container.

## One-time setup (Jon)

1. The repo is `jon-bell/pc-supervisor` (private). The `ripley-cloud-gha` GitHub App installation for the `jon-bell` account (installation `125409090`) must include it. If the installation is "selected repositories", add it at <https://github.com/settings/installations/125409090>. Until then, jobs queue forever, and the listener logs `403 Resource not accessible by integration` (see `k8s/apps/arc/README.md`).
2. **No secrets are needed for CI.** The harness mints its own token. The real instance's token never goes into GitHub, and no CI job talks to a real HotCRP.

## Later: caching the HotCRP image

The image only changes when `hotcrp/` or `HOTCRP_REF` changes. Two options:

- Buildx with the `gha` cache backend. The runners already point `ACTIONS_CACHE_URL` at the in-cluster `gha-cache` server.
- Push `registry.work.ripley.cloud/pc-supervisor/hotcrp:<HOTCRP_REF>` from a small `harness-image` workflow, and pull it in `ci`. This needs the `runner-docker-config` secret copied into `arc-runners-jon-bell`, as in `k8s/apps/arc/README.md`.

Don't do either until build time actually hurts.

## Jobs

| Job | Trigger | Runs |
|---|---|---|
| `ci` | push, PR | harness up → API smoke → (once `package.json` exists) lint, typecheck, unit, contract, seed `golden`, integration, Playwright → artifacts on failure → teardown |
| `nightly` | schedule + manual | the same suite against `HOTCRP_REF=master` (an early warning when upstream changes the API), plus the `scale` scenario on `ripley-cloud-large` |
