# Two Container Classes by Job Label

**Date:** 2026-07-10
**Scope:** Let one flare-runner Worker serve two runner sizes, chosen by a `go` / `node` job label, so a repo can send its heavy Go compile to a big instance and its lighter node/test work to a small one.
**Status:** design, approved 2026-07-10

---

## Problem

flare-runner spawns one ephemeral container per `workflow_job: queued` webhook, at one fixed `instance_type` per deployment. A repo whose CI has both a memory-heavy job (Go compilation) and a lighter one (node typecheck + tests) must size the single runner for the worst case, or it flakes.

Concretely: `flare-runner-focusit-us` was cut from 6 GiB to 4 GiB on 2026-07-10 for cost. The `pbx` `test` job - `go test ./...` plus two `npm ci` trees plus a Python venv, all in one job - then died on its first run at 4 GiB with `The self-hosted runner lost communication with the server ... starves it for CPU/Memory`, and passed on retry only in 15.5 minutes against a historical 8-13 at 6 GiB. The Go compile needs the memory; the node and python work does not.

The fix is not "raise everything back to 6 GiB" (pays for memory the node work never uses) but "run the two workloads on two differently-sized runners." That needs the runner infrastructure to offer two sizes.

## Why one Worker, not two

A GitHub organization delivers `workflow_job` events to a webhook URL. flare-runner is one Worker behind that URL. Two independently-sized runners could be two Workers, but then the single org webhook can only reach one of them, and jobs for the other never spawn. Two org webhooks would work (each Worker filters its label) but adds a second org-admin webhook to manage and doubles delivered traffic.

The cleaner shape, and the one this design takes: **one Worker, two Container Durable Object classes**, routed by job label. One webhook, no new admin surface, and the routing lives in code that is unit-tested.

## Design

### Routing

The base label gate is unchanged. A job still only concerns this Worker if its labels are a superset of `RUNNER_LABELS` (e.g. `self-hosted,cloudflare`) - that is what `shouldSpawn` / `shouldReap` already enforce, and it stays.

On top of that gate, a **discriminator** label selects the class:

- job labels include `node` -> `RunnerContainerNode`
- job labels include `go` (and not `node`) -> `RunnerContainerGo`
- neither -> `RunnerContainerGo`

`RunnerContainerGo` is the default on purpose. It means a bare `[self-hosted, cloudflare]` job - every existing consumer, before any repo adopts the split - routes to the Go class. Size that class at the safe 6 GiB and **deploying this change alone fixes the flaky `test` job**, before a single workflow is relabelled. The split then becomes an optimization layered on a working base, never a precondition for it.

`node` winning over `go` when a job carries both is an arbitrary tie-break for a misconfiguration; document it, do not agonize over it.

### The label the runner advertises - the non-obvious part

Routing to the right *container* is only half the job. A JIT runner registers with GitHub advertising a label set, and GitHub assigns a queued `workflow_job` to a runner only when the runner's labels are a **superset of the job's `runs-on`**. A job requesting `[self-hosted, cloudflare, node]` will never be assigned to a runner advertising only `[self-hosted, cloudflare]` - it stays queued until it times out, and the container we spawned long-polls idle until reaped.

So the spawned runner must advertise the discriminator too. The labels passed to `mintJitConfig` become:

- discriminator present -> `RUNNER_LABELS + [discriminator]`
- bare job -> `RUNNER_LABELS` (unchanged from today)

A consequence to record, and it is worse than a sizing nicety: label matching is superset-based, so a runner advertising `[self-hosted, cloudflare, node]` *can* be assigned a bare `[self-hosted, cloudflare]` job if one is queued when it comes online (a JIT runner claims a matching job, not necessarily its originating one).

Follow that through. Node runner `N` is spawned for node job `J`, but claims bare job `B` instead. `B` also had a go container spawned for it, and that container **cannot** take `J` - it does not advertise `node`. So `J` has no runner and sits queued until GitHub's queue timeout. Nothing leaks: `N` exits after finishing `B`, and the go container spawned for `B` is reaped by `B`'s `completed` event. But a job stalls.

Impact today is exactly zero, because no `node`-labelled job exists in either org, so no node container is ever spawned. It becomes real the moment a repo runs node-labelled and bare-labelled jobs concurrently in the same org - which is precisely what the `pbx` split will do (`test-go` + `test-node` in parallel, alongside `mandatory-gates`). Watch the first parallel run.

The clean fix, if it bites: give every self-hosted job an explicit discriminator so no bare-label job remains for a node runner to steal. That is a one-line `runs-on` change per job in the consuming repo, not a change here. Do not preemptively build a claim-fencing mechanism in the Worker; GitHub offers no API to bind a JIT runner to a specific job.

### The two classes

The two classes are behaviourally identical - same `sleepAfter`, same `runJob`, same `reap`. Only their `instance_type` in wrangler differs. Express that as a shared base:

```ts
class RunnerContainerBase extends Container<Env> {
  sleepAfter = "6h";
  async runJob(jitConfig: string): Promise<void> { /* unchanged */ }
  async reap(): Promise<void> { /* unchanged */ }
}
export class RunnerContainerGo extends RunnerContainerBase {}
export class RunnerContainerNode extends RunnerContainerBase {}
```

Cloudflare binds each Durable Object namespace to a concrete exported class, so both must be exported even where a deployment only ever uses one.

### Reap routes too

`workflow_job: completed` carries the same `labels`, so the same discriminator function picks the same namespace. Reap the container in the class it was spawned in. Reaping the wrong namespace silently leaves a leaked container alive - the exact bug this project exists to prevent.

### Uniform deployments

Because the Worker exports both classes and binds both namespaces, **every** wrangler config must declare both containers, both `durable_objects.bindings`, and the migration - not only `focusit-us`. The single-size deployments (`codus-nullus`, the public `wrangler.jsonc` default) set both `instance_type`s to their one size (4 GiB). Their jobs carry no `go`/`node` label, so everything routes to the Go class and the Node class sits idle - and an idle Durable Object class costs nothing. This keeps all three configs structurally identical, differing only in numbers.

Per-deployment sizes:

| Deployment | Go class | Node class |
| --- | --- | --- |
| `focusit-us` | 6 GiB | 4 GiB |
| `codus-nullus` | 4 GiB | 4 GiB |
| public default | 4 GiB | 4 GiB |

The node class starts at 4 GiB on an unproven assumption that node typecheck + vitest + a Python venv fit where Go compilation did not. If it flakes the same way, raise it; the failure signature (`lost communication ... starves for Memory`) is unambiguous.

### Migration

Deployed instances carry migration `v1: new_sqlite_classes: [RunnerContainer]`. The change renames that class and adds the second:

```jsonc
"migrations": [
  { "tag": "v1", "new_sqlite_classes": ["RunnerContainer"] },
  { "tag": "v2",
    "renamed_classes": [{ "from": "RunnerContainer", "to": "RunnerContainerGo" }],
    "new_sqlite_classes": ["RunnerContainerNode"] }
]
```

`v1` stays for instances that never migrated. This is a live migration on three deployed Workers; it must be applied by redeploying each, and verified against the API the same way instance-type changes are (`wrangler`'s `SUCCESS` line is not proof - poll the applied config).

## Error handling

- A job whose labels pass the base gate but carry neither `go` nor `node` is not an error: it routes to Go by definition.
- A malformed or missing `workflow_job.labels` is treated as a bare job (Go), consistent with `labelsMatch`'s existing null-guard.
- The routing functions are pure and total - every input returns a class. There is no throwing path to handle.

## Testing

The discriminator and the advertised-label derivation are pure functions in `webhook.ts`, unit-tested under vitest exactly as `shouldSpawn` / `shouldReap` are. Cases, written first and watched fail:

- `node` label -> node class; `go` label -> go class; neither -> go class; both -> node class (tie-break).
- case-insensitive (`Node`, `GO`).
- advertised labels: node job -> base + `node`; go job -> base + `go`; bare job -> base only.
- missing `workflow_job.labels` -> go class, base labels.

The `fetch` wiring (which namespace `getContainer` receives) is integration-level and is verified by the live deploy + a real CI job on each class, not by a unit test - the same evidence standard the reap fix used.

## Rollout order (cross-boundary)

This spans two repos and the order is load-bearing:

1. **flare-runner first.** Land and deploy the two-class Worker to `focusit-us` (Go 6 GiB, Node 4 GiB) and to `codus-nullus` + the public default (both 4 GiB). At this point every existing bare-label job routes to Go 6 GiB - the flaky `test` job is already fixed, nothing in `pbx` has changed.
2. **pbx second, separately.** Split its `test` job into `test-go` (`[self-hosted, cloudflare, go]`) and `test-node` (`[self-hosted, cloudflare, node]`, carrying the node + python steps, running in parallel), and move `mandatory-gates` (which needs both Go and node, so wants the memory) to `[self-hosted, cloudflare, go]`. This PR must not merge until the labels are live on the deployed runner, or its jobs hang queued.

The `pbx` split is out of scope for this design doc; it is a separate change in a separate repo. This doc covers the flare-runner side that must ship first.

## Out of scope

- The `pbx` workflow split (separate repo, separate PR).
- Any change to `github.ts` / JIT minting beyond the label set passed in.
- Autoscaling, more than two classes, per-job custom sizes. Two classes is what the one concrete need requires; add a third only when a third workload proves it needs one.
