---
name: flare-runner-design
status: approved
created: 2026-06-24T16:13:10Z
updated: 2026-06-24T16:13:10Z
---

# flare-runner - ephemeral GitHub Actions runners on Cloudflare Containers

> **Historical.** This records the design as approved on 2026-06-24 and is not
> updated as the code moves. Two things below have since changed: the single
> `RunnerContainer` class was split into `RunnerContainerGo` +
> `RunnerContainerNode` (see `2026-07-10-two-class-runners-design.md`), and the
> `sleepAfter="30s"` backstop is now `"6h"` (it is a total-runtime ceiling, not
> an idle timeout - see the container-leak note in `README.md`). For the current
> architecture read `README.md`.

## Goal

A per-org-deployable, open-source system that turns a GitHub `workflow_job:queued`
event into a single-use self-hosted runner running inside a short-lived Cloudflare
Container. The runner claims exactly one job and exits. Scale-to-zero, no standing
VM, per-second billing.

First proving ground: a Go + frontend + Python `tests` job (no Docker). Deployable
by any org - each runs its own instance.

## Why (the problem it replaces)

A persistent self-hosted runner is a single host that runs **one job at a time**
(no parallelism), a full-privilege secret-bearing box that must be started
manually and reused between jobs (`_work/` accumulates). flare-runner replaces
that with on-demand, isolated, ephemeral containers: one container = one job, no
shared state.

## Architecture - one Worker + one Container DO + one image

```
GitHub org ──workflow_job:queued (HMAC webhook)──▶ [Worker]
  [Worker]  verify X-Hub-Signature-256 (HMAC-SHA256)
            filter: event=workflow_job, action=queued, labels ⊇ required
            mint JIT config: POST /orgs/{org}/actions/runners/generate-jitconfig
            getContainer(RUNNER, "cf-"+job_id).runJob(encoded_jit_config)
  [RunnerContainer = Durable Object / @cloudflare/containers Container]
            this.start({ envVars: { JIT_CONFIG }, enableInternet: true })
  [Container linux/amd64]  entrypoint: ./run.sh --jitconfig "$JIT_CONFIG"
            registers ephemeral → claims ONE job → runs → de-registers
            → process exits → container stops → instance reclaimed
```

One container = one job = ephemeral. No `_work/` reuse, no standing secret box.

### Why portless / one-shot is sound

Cloudflare documents `container.start({ entrypoint, envVars, enableInternet })`
explicitly for "a batch job or a cron task" that "does not expose ports." The
runner is an outbound long-poll client, not an HTTP server, so it needs no
`defaultPort`. Confirmed against the `container-class` and `durable-objects/api/container`
docs and a proven `@cloudflare/containers` ^0.3.7 reference setup.

## Components

1. **Worker** (`src/index.ts`): `POST /webhook` only. Verify HMAC; no-op (204)
   unless `workflow_job` + `queued` + labels match; mint JIT; RPC the DO; 202.
   Config in `vars` (org, runner_group_id, labels); creds in secrets
   (`GITHUB_TOKEN`, `WEBHOOK_SECRET`).
2. **`RunnerContainer`** (`src/index.ts`, extends `@cloudflare/containers`
   `Container`): no `defaultPort`; `sleepAfter="30s"` backstop; `runJob(jit)`
   calls `this.start({ envVars:{ JIT_CONFIG }, enableInternet:true })`. Unique
   DO name per `workflow_job.id` => fresh instance, idempotent on webhook retry.
3. **Runner image** (`Dockerfile` + `entrypoint.sh`, linux/amd64): ubuntu 22.04
   + pinned actions runner (v2.335.1) + `installdependencies.sh` + git/curl/jq +
   build-essential + **system python3/venv** (some jobs use the runner's python3
   because `actions/setup-python` has no build for every runner OS). Toolchains
   (Go, Node) are installed at job time by `setup-go`/`setup-node` - kept out of
   the image to stay lean, matching how the existing self-hosted runner works.
   **No Docker daemon.**
4. **GitHub side (per org, one-time)**: a runner group (e.g. `cloudflare-ephemeral`)
   scoped to chosen repos; an org webhook → Worker; repos opt in via
   `runs-on: [self-hosted, cloudflare]`.

## Auth

- **POC**: one fine-grained **org PAT** (`self-hosted runners: write`) as a
  Worker secret. Fastest path to a working loop.
- **v1 hardening**: a **GitHub App** (org install, mints short-lived installation
  tokens, subscribes to `workflow_job`, no standing secret). The Worker reads a
  single token-provider, so the swap is config, not a rewrite.

## Phasing

- **Phase 1 / POC - a no-Docker test job** (Go + frontend + Python). Clean fit,
  no buildah. Prove: push → webhook → Worker → JIT → one `standard-2` container →
  tests → exit. Measure cold-start, wall-time, cost.
- **Phase 2 - a multi-image Docker build matrix.** Either add **buildah** (rootless
  `buildah bud` in place of `docker build`) to the image, or honestly keep it on a
  Docker-capable runner. Many images on a 20 GB disk is where no-DinD genuinely hurts.
- **Phase 3 - image retag/promote** → `skopeo copy` / `buildah manifest` (no daemon).
- **Org-wide** - any pure pnpm/Go org is a trivial fit (zero Docker); each deploys
  its own instance.

## Limits that shape it (Cloudflare Containers, as of 2026-02)

| instance | vCPU | mem | disk |
|---|---|---|---|
| lite | 1/16 | 256 MiB | 2 GB |
| basic | 1/4 | 1 GiB | 4 GB |
| standard-1 | 1/2 | 4 GiB | 8 GB |
| standard-2 | 1 | 6 GiB | 12 GB |
| standard-3 | 2 | 8 GiB | 16 GB |
| standard-4 | 4 | 12 GiB | 20 GB |

Ceiling per instance = standard-4 (custom can't exceed it). Account concurrency
ceiling (1,500 vCPU / 6 TiB / 30 TB) is effectively unlimited at this scale.
POC uses `standard-2`.

## Deliberately NOT built (YAGNI)

Cloudflare Queue between webhook and spawn, a warm pool / autoscaler, a shared
tool-cache (each ephemeral container re-downloads Go/Node via setup-* - accepted
cold-start cost for the POC), non-GitHub support, moving any heavy image build
into phase 1.

## Known risks / open items

- **Webhook double-delivery**: GitHub may resend `queued`. Same DO name per job id
  makes the spawn idempotent; JIT name collision is tolerated for the POC (note,
  don't build dedup yet).
- **Long-job wall-clock**: no documented hard runtime cap (per-second billing);
  validate a multi-minute container isn't capped during the first live run.
- **Tool-cache cold start**: setup-go/node re-download every job. Acceptable now;
  future optimization is an R2/volume-backed `RUNNER_TOOL_CACHE`.

## Tests (runnable checks)

- `src/webhook.ts`: HMAC verify (valid/invalid/missing), event filter
  (ignore non-queued / wrong-label / wrong-event).
- `src/github.ts`: JIT request body shape; `mintJitConfig` success + error path
  (injected fake `fetch`).
- Acceptance gate: manual end-to-end green on a real `tests` job.

## Deliverable layout

```
flare-runner/
  src/{index,webhook,github}.ts
  test/{webhook,github}.test.ts
  Dockerfile  entrypoint.sh
  wrangler.jsonc  package.json  tsconfig.json  vitest.config.ts
  README.md  setup.md  LICENSE (MIT)  .dev.vars.template  .gitignore
  docs/superpowers/specs/2026-06-24-flare-runner-design.md
```
