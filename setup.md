# Setup - one instance per GitHub org or repo

Order matters: do the GitHub side first (you need the scope + a token), then deploy
the Worker, then register the webhook, then opt a repo in.

## 0. Prerequisites

- A Cloudflare account with Containers enabled, and `wrangler login` done.
- Admin on the target repo (repo scope) or org (org scope), to add a webhook.
- Docker locally **once** (or use the `deploy` workflow on a GitHub-hosted runner),
  so `wrangler deploy` can build and push the runner image. (No Docker is needed at
  job time - see "Building images without Docker" below.)

## 1. Scope

**Repo scope** (works for user repos): set `vars.GITHUB_REPO = "owner/repo"` in
`wrangler.jsonc`, leave `RUNNER_GROUP_ID` at `"1"`.

**Org scope**: instead set `vars.GITHUB_ORG = "your-org"`. Optionally create a
runner group (Org → Settings → Actions → Runner groups) scoped to chosen repos and
put its numeric id in `RUNNER_GROUP_ID` (Default group is `1`).

## 2. GitHub: auth token (POC)

Create a **fine-grained PAT**:

- Repo scope: owner = you, repository = your repo, permission
  **Repository → Administration → Read and write** (covers self-hosted runners).
- Org scope: owner = org, permission **Organization → Self-hosted runners → R/W**.

This is the POC path - see "Hardening: GitHub App" for the production swap.

```bash
wrangler secret put GITHUB_TOKEN     # paste the PAT
```

### Deploying via the `deploy` workflow instead of locally

Set these as repo **Actions secrets** (Settings → Secrets and variables → Actions):

| secret | value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | CF token with Workers + Containers permissions |
| `CLOUDFLARE_ACCOUNT_ID` | your CF account id |
| `GH_RUNNER_PAT` | the fine-grained PAT from above |
| `WEBHOOK_SECRET` | the webhook secret (step 4) |

Then run the **deploy** workflow (Actions → deploy → Run workflow). The build-push
and demo workflows need no extra secrets (they use the built-in `GITHUB_TOKEN`).

## 3. Deploy the Worker + image

```bash
npm install
wrangler deploy        # builds ./Dockerfile (linux/amd64) and pushes it
```

Note the deployed Worker URL (e.g. `https://flare-runner.<subdomain>.workers.dev`).

## 4. GitHub: webhook

Org → Settings → Webhooks → **Add webhook**:

- **Payload URL**: `<worker-url>/webhook`
- **Content type**: `application/json`
- **Secret**: a high-entropy string - the same value you set here:
  ```bash
  wrangler secret put WEBHOOK_SECRET
  ```
- **Events**: "Let me select individual events" → check **Workflow jobs** only.

## 5. Opt a repo in

In the repo's workflow, target the label set (must include everything in
`vars.RUNNER_LABELS`, default `self-hosted,cloudflare`):

```yaml
jobs:
  test:
    runs-on: [self-hosted, cloudflare]
    steps:
      - uses: actions/checkout@v4
      # ...
```

Push a job. The webhook fires `workflow_job:queued`, the Worker mints a JIT config
and starts a container, the runner claims the job and exits.

## Verify

```bash
wrangler tail                 # watch: "spawned cf-<job_id>"
wrangler containers list      # a live instance during the job; gone after
```

Org → Settings → Actions → Runners shows the ephemeral runner appear and
auto-remove around the job.

## Building images without Docker (when a job needs it)

Cloudflare Containers can't run a Docker daemon. If a job must build/push a
container image, swap `docker build` for a rootless, daemonless builder:

```yaml
- run: |
    buildah bud -t "$REGISTRY/app:$GITHUB_SHA" .
    buildah push "$REGISTRY/app:$GITHUB_SHA"
```

Add `buildah` (or kaniko) to the `Dockerfile`'s apt layer for that org's image.
Heavy multi-image builds may be better left on a Docker-capable runner - the
container disk ceiling is 20 GB (standard-4).

## A second org

Either copy the project and change `name` + `GITHUB_ORG` + `RUNNER_GROUP_ID`, or
add an `env` block to `wrangler.jsonc`:

```jsonc
"env": {
  "another-org": {
    "name": "flare-runner-another-org",
    "vars": { "GITHUB_ORG": "another-org", "RUNNER_GROUP_ID": "1", "RUNNER_LABELS": "self-hosted,cloudflare" }
  }
}
```

```bash
wrangler deploy --env another-org
wrangler secret put GITHUB_TOKEN --env another-org
wrangler secret put WEBHOOK_SECRET --env another-org
```

## Hardening: GitHub App (production auth)

Replace the org PAT with a GitHub App installed on the org:

- Permissions: **Organization self-hosted runners: read & write**.
- Subscribe to **Workflow job** events; point the App webhook at `<worker-url>/webhook`.
- Store the App id + private key as secrets; the Worker exchanges them for a
  short-lived installation token before each `mintJitConfig` call.

The token is the only thing that changes - `src/github.ts` already takes the token
as a parameter, so this is a token-provider swap, not a rewrite.
