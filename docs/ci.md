# CI: how HotCRP is rolled

## Decision

Each CI job builds and starts **its own disposable HotCRP + MariaDB with Docker Compose**, inside a **`ripley-cloud` self-hosted runner**. Those runners are ARC scale sets on the Ripley cluster, in `containerMode: dind`, so every runner pod has a private Docker daemon. The job tears the stack down at the end, and nothing persists between runs.

```
GitHub ──► ARC listener (arc-runners-jon-bell) ──► ephemeral runner pod
                                                   ├─ runner container: JDK 21 + Gradle, xvfb (Compose UI tests), scripts/hotcrp-up.sh
                                                   └─ dind sidecar: hotcrp (php:8.3-apache @ HOTCRP_REF) + mariadb:10.11 (tmpfs)
```

`127.0.0.1:8080` is reachable from the runner container because the two containers share the pod's network namespace.

## Why this option

| Option | Verdict |
|---|---|
| **A. Compose in a dind runner, per job** (chosen) | The harness is identical on a laptop and in CI (`scripts/hotcrp-up.sh`), and every run is hermetic. Changing `HOTCRP_REF` is a one-line bump. It costs ~1–2 min of image build per run, which can be cached later (below). |
| B. Upstream-style bare metal: `setup-php` + a MariaDB `services:` container + `php -S` | This is what HotCRP's own CI does. But `php -S` is single-threaded, which hurts once the UI tests and the sync run concurrently. It also behaves differently from local dev and depends on how ARC's dind handles `services:`. Rejected. |
| C. A long-lived HotCRP on Ripley k8s, reset per run by DB restore | Faster per run, but shared state means concurrent PRs collide. It's also ops we'd have to keep alive. **Use it only for exploration and scale demos** (a seeded `scale` instance a human can click around), never for per-PR CI. |
| D. A hosted hotcrp.com test instance | No way to reset, seed with batch scripts, or warp time. Rejected. |

## Visual testing (Argos)

The Compose UI tests write screenshots to `app/build/screenshots`, and CI uploads them with the Argos CLI. Uploads happen **only in CI**. Auth is tokenless: the Argos GitHub App is installed on the repo, and the SDK proves the job from the GitHub Actions run and job IDs. If an `ARGOS_TOKEN` secret exists, it's used instead.

Tokenless auth also requires an **Argos project linked to this repository** (app.argos-ci.com → new project → import the repo). Without one, the upload fails with `No project found`. `.github/workflows/argos-canary.yml`, which runs on manual dispatch only, screenshots the harness home page with Playwright to check this setup end to end. It is independent of the app's stack.

## Runner gotcha

The stock ARC runner image (`ghcr.io/actions/actions-runner`) has the docker CLI but **not** the compose v2 plugin. `ci.yml` installs a pinned plugin (v2.39.4) into `~/.docker/cli-plugins` before the harness starts.

## Runner labels

- `ripley-cloud`: the default for the `ci` job (dind; 4 CPU / 8 Gi limit).
- `ripley-cloud-large`: the nightly `scale` job (seeding ~10k reviews plus a full sync).
- `ripley-cloud-ramdisk` is available if MariaDB/tmpfs I/O ever becomes the bottleneck. It shouldn't, since the DB is already on tmpfs inside the container.

## One-time setup (maintainer)

1. **Done 2026-10-07** (k8s repo `485205e`, `apps/arc/install-jonbell-pc-supervisor.sh`; App access granted). Kept for reference: **register scale sets for this repo.** On a personal account, ARC scale sets are per repository: `githubConfigUrl` is a repo URL, as in `arc-runners-jon-bell-slopcoder`, `…-teleport-contest`, etc. So no existing `ripley-cloud` set will pick up `jon-bell/pc-supervisor` jobs; they queue forever. To add this repo's sets, clone slopcoder's:

   ```bash
   export KUBECONFIG=~/work/k8s/talos/kube/kubeconfig
   NS=arc-runners-jon-bell-pc-supervisor SRC=arc-runners-jon-bell-slopcoder
   CHART=oci://ghcr.io/actions/actions-runner-controller-charts/gha-runner-scale-set
   kubectl create ns $NS && kubectl label ns $NS pod-security.kubernetes.io/enforce=privileged
   kubectl get secret -n $SRC github-app-credentials -o json \
     | python3 -c "import json,sys; s=json.load(sys.stdin); s['metadata']={'name':'github-app-credentials','namespace':'$NS'}; print(json.dumps(s))" \
     | kubectl apply -f -
   for name in ripley-cloud ripley-cloud-large; do
     helm get values -n $SRC $name -o yaml \
       | sed 's|^githubConfigUrl: .*|githubConfigUrl: https://github.com/jon-bell/pc-supervisor|' \
       | helm upgrade --install $name -n $NS $CHART --version 0.14.2 -f - --wait
   done
   ```

   Then make sure the `ripley-cloud-gha` App installation for `jon-bell` (`125409090`) includes the repo: <https://github.com/settings/installations/125409090>. If it doesn't, the listener logs `403 Resource not accessible by integration` until access is granted, and then fixes itself.
2. **No secrets are needed for CI.** The harness mints its own token. The real instance's token never goes into GitHub, and no CI job talks to a real HotCRP.

## Later: caching the HotCRP image

The image only changes when `hotcrp/` or `HOTCRP_REF` changes. Two options:

- Buildx with the `gha` cache backend. The runners already point `ACTIONS_CACHE_URL` at the in-cluster `gha-cache` server.
- Push `registry.work.ripley.cloud/pc-supervisor/hotcrp:<HOTCRP_REF>` from a small `harness-image` workflow, and pull it in `ci`. This needs the `runner-docker-config` secret copied into `arc-runners-jon-bell`, as in `k8s/apps/arc/README.md`.

Don't do either until build time actually hurts.

## Jobs

| Job | Trigger | Runs |
|---|---|---|
| `ci` | push, PR | harness up → API smoke → (once `settings.gradle.kts` exists) `check`, contract and integration, UI tests, Argos upload → artifacts on failure → teardown |
| `model` | push, PR | `lake build` (checks every proof) and a diff of `model/model-report.txt` against a fresh run |
| `nightly` | schedule + manual | the same suite against `HOTCRP_REF=master` (an early warning when upstream changes the API), plus the `scale` scenario on `ripley-cloud-large` |
