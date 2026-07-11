# Two Container Classes by Job Label - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One flare-runner Worker serves two container sizes, chosen by a `go` / `node` job label, so a repo can route heavy Go compilation to a big instance and lighter node/test work to a small one.

**Architecture:** A pure discriminator function in `webhook.ts` maps a job's labels to `"go"` or `"node"` and derives the labels the spawned runner must advertise. `index.ts` exports two behaviourally-identical Container classes (`RunnerContainerGo`, `RunnerContainerNode`) over a shared base, binds a Durable Object namespace to each, and routes both spawn and reap to the matching namespace. All three wrangler configs declare both classes and a rename+add migration; only the `instance_type` numbers differ.

**Tech Stack:** TypeScript, `@cloudflare/containers`, Cloudflare Workers + Durable Objects, wrangler, vitest.

**Spec:** `docs/superpowers/specs/2026-07-10-two-class-runners-design.md`
**Repo:** `andrius/flare-runner`, branch `feat/two-class-runners`, cut from `origin/main` at `b305928`.

## Global Constraints

- Default identity `Andrius Kairiukstis <k@c0.lt>` (this is not the pbx repo). No AI co-author trailer, no AI mention in code, comments, or commit messages.
- Commits skip GPG signing: `git commit --no-gpg-sign -m "..."`.
- The em-dash glyph (U+2014) and en-dash (U+2013) are banned everywhere, including comments and commit messages. Use ` - ` as a clause separator and a bare `-` inside compound words.
- `RunnerContainerGo` is the default class: any job that passes the base-label gate but carries neither `go` nor `node` routes to Go. This keeps every current bare-`[self-hosted, cloudflare]` consumer working and, with Go sized at 6 GiB, fixes the flaky `pbx` `test` job the moment this deploys.
- The base-label gate (`shouldSpawn` / `shouldReap` against `RUNNER_LABELS`) is unchanged. The discriminator is a second step layered on top, never a replacement.
- A spawned runner must advertise the discriminator label, or GitHub will not assign it the `[... , node]` / `[... , go]` job and the container long-polls idle. Spawn and reap must resolve to the **same** namespace for a given job, or a leaked container survives.
- Deploy order across repos: this flare-runner change ships and is verified live **before** any `pbx` workflow is relabelled. The `pbx` split is a separate plan in a separate repo and is out of scope here.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/webhook.ts` (modify) | Add `runnerClassFor(body)` and `advertisedLabels(body, base)` pure functions beside `shouldSpawn`/`shouldReap`. |
| `test/webhook.test.ts` (modify) | Unit tests for the two new functions, written first. |
| `src/index.ts` (modify) | `Env` gains `RUNNER_GO`/`RUNNER_NODE`; base class + two subclasses; `fetch` routes spawn (with the advertised labels) and reap to the matching namespace. |
| `wrangler.focusit-us.jsonc` (modify) | Two containers (Go 6 GiB, Node 4 GiB), two bindings, v2 migration. |
| `wrangler.codus-nullus.jsonc` (modify) | Two containers (both 4 GiB), two bindings, v2 migration. |
| `wrangler.jsonc` (modify) | Public default: two containers (both 4 GiB), two bindings, v2 migration. |
| `README.md` (modify) | Document the `go`/`node` label routing and per-class sizing. |

---

### Task 1: Routing functions in `webhook.ts`

Two pure, total functions. Every input returns a value; there is no throwing path.

**Files:**
- Modify: `src/webhook.ts`
- Test: `test/webhook.test.ts`

**Interfaces:**
- Produces, consumed by Task 2:
  - `type RunnerClass = "go" | "node"`
  - `runnerClassFor(body: WorkflowJobEvent): RunnerClass` - `"node"` if the job's labels include `node`; else `"go"` (covers explicit `go`, a bare job, and missing labels). `node` wins if both are present.
  - `advertisedLabels(body: WorkflowJobEvent, baseLabels: string[]): string[]` - `baseLabels` plus the discriminator label the job actually carried (`node` or `go`), or `baseLabels` unchanged for a bare job. Case-insensitive detection; the appended label is lowercase.

- [ ] **Step 1: Write the failing tests**

Append to `test/webhook.test.ts`:

```ts
import { runnerClassFor, advertisedLabels } from "../src/webhook";

function job(labels: string[]): WorkflowJobEvent {
  return {
    action: "queued",
    workflow_job: { id: 1, run_id: 1, labels },
    repository: { full_name: "o/r" },
  };
}

describe("runnerClassFor", () => {
  it("routes a node-labelled job to the node class", () => {
    expect(runnerClassFor(job(["self-hosted", "cloudflare", "node"]))).toBe("node");
  });

  it("routes a go-labelled job to the go class", () => {
    expect(runnerClassFor(job(["self-hosted", "cloudflare", "go"]))).toBe("go");
  });

  it("routes a bare job to the go class by default", () => {
    expect(runnerClassFor(job(["self-hosted", "cloudflare"]))).toBe("go");
  });

  it("routes a job with no labels to the go class", () => {
    expect(runnerClassFor({ action: "queued", workflow_job: { id: 1, run_id: 1, labels: undefined as unknown as string[] }, repository: { full_name: "o/r" } })).toBe("go");
  });

  it("lets node win when a job carries both discriminators", () => {
    expect(runnerClassFor(job(["self-hosted", "cloudflare", "go", "node"]))).toBe("node");
  });

  it("matches the discriminator case-insensitively", () => {
    expect(runnerClassFor(job(["self-hosted", "cloudflare", "Node"]))).toBe("node");
  });
});

describe("advertisedLabels", () => {
  const base = ["self-hosted", "cloudflare"];

  it("appends node for a node job", () => {
    expect(advertisedLabels(job(["self-hosted", "cloudflare", "node"]), base)).toEqual(["self-hosted", "cloudflare", "node"]);
  });

  it("appends go for a go job", () => {
    expect(advertisedLabels(job(["self-hosted", "cloudflare", "go"]), base)).toEqual(["self-hosted", "cloudflare", "go"]);
  });

  it("leaves a bare job's labels as the base set", () => {
    expect(advertisedLabels(job(["self-hosted", "cloudflare"]), base)).toEqual(["self-hosted", "cloudflare"]);
  });

  it("lowercases the appended discriminator", () => {
    expect(advertisedLabels(job(["self-hosted", "cloudflare", "GO"]), base)).toEqual(["self-hosted", "cloudflare", "go"]);
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npm test`
Expected: the new `runnerClassFor` / `advertisedLabels` describe blocks fail to import (`runnerClassFor is not exported` / undefined). Existing `verifySignature`/`shouldSpawn`/`shouldReap` tests still pass.

- [ ] **Step 3: Implement the two functions**

Add to `src/webhook.ts`, after `shouldReap`:

```ts
export type RunnerClass = "go" | "node";

/** The discriminator label a job carried, or null for a bare job. `node` wins over `go`. */
function discriminator(body: WorkflowJobEvent): "go" | "node" | null {
  const jobLabels = new Set((body.workflow_job?.labels ?? []).map((l) => l.toLowerCase()));
  if (jobLabels.has("node")) return "node";
  if (jobLabels.has("go")) return "go";
  return null;
}

/**
 * Which container class serves this job. `node` -> the node class; everything
 * else (explicit `go`, a bare job, missing labels) -> the go class, which is the
 * default so existing bare-label consumers keep working.
 */
export function runnerClassFor(body: WorkflowJobEvent): RunnerClass {
  return discriminator(body) === "node" ? "node" : "go";
}

/**
 * The labels the spawned JIT runner must advertise. GitHub assigns a job to a
 * runner only when the runner's labels are a superset of the job's runs-on, so a
 * `[... , node]` job needs a runner advertising `node`. Bare jobs advertise the
 * base set unchanged.
 */
export function advertisedLabels(body: WorkflowJobEvent, baseLabels: string[]): string[] {
  const disc = discriminator(body);
  return disc ? [...baseLabels, disc] : [...baseLabels];
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npm test`
Expected: all suites green, including the 10 new cases. No type errors.

- [ ] **Step 5: Commit**

```bash
git add src/webhook.ts test/webhook.test.ts
git commit --no-gpg-sign -m "Route jobs to a container class by go/node label

runnerClassFor maps a job's labels to the go or node class (go is the default,
so bare self-hosted,cloudflare jobs are unaffected). advertisedLabels derives
the label set the spawned JIT runner must advertise so GitHub assigns it the
discriminated job. Pure functions, unit-tested."
```

---

### Task 2: Two classes and routed dispatch in `index.ts`

**Files:**
- Modify: `src/index.ts`

**Interfaces:**
- Consumes from Task 1: `runnerClassFor`, `advertisedLabels`, `RunnerClass`.
- Produces: exported classes `RunnerContainerGo`, `RunnerContainerNode`; `Env` fields `RUNNER_GO`, `RUNNER_NODE` (both `DurableObjectNamespace`).

- [ ] **Step 1: Replace the single class with a base + two subclasses**

In `src/index.ts`, change the import to add the routing helpers:

```ts
import { verifySignature, shouldSpawn, shouldReap, runnerClassFor, advertisedLabels, type WorkflowJobEvent } from "./webhook";
```

Replace the `RUNNER` binding in `Env`:

```ts
export interface Env {
  RUNNER_GO: DurableObjectNamespace<RunnerContainerGo>;
  RUNNER_NODE: DurableObjectNamespace<RunnerContainerNode>;
  // vars - set exactly one of GITHUB_REPO ("owner/repo") or GITHUB_ORG ("org").
  GITHUB_REPO?: string;
  GITHUB_ORG?: string;
  RUNNER_GROUP_ID: string; // numeric id; "1" is the Default group
  RUNNER_LABELS: string; // comma-separated base labels, e.g. "self-hosted,cloudflare"
  // secrets
  GITHUB_TOKEN: string; // PAT (POC) / installation token (later)
  WEBHOOK_SECRET: string;
}
```

Replace the `RunnerContainer` class with a shared base and two concrete subclasses. The body is identical to today's `RunnerContainer`; only the shape changes:

```ts
/**
 * One ephemeral GitHub Actions runner per job. No port: the runner is an
 * outbound long-poll client, not an HTTP server. It boots in JIT mode, claims a
 * single job, then exits - Cloudflare reclaims the instance.
 *
 * Two concrete subclasses exist so a single Worker can offer two instance sizes
 * (see the wrangler configs); their behaviour is identical.
 */
class RunnerContainerBase extends Container<Env> {
  // ponytail: no defaultPort - this is the CF "batch/cron" container shape, not a
  // server. Nothing is ever proxied to this container, so renewActivityTimeout()
  // fires only at start: sleepAfter is a hard wall-clock cap on the whole job,
  // NOT an idle timeout. Keep it above the longest job you expect (GitHub caps a
  // job at 6h). It must never be short enough to kill a running job - the old
  // "30s" would have done exactly that had the signal ever landed (see
  // entrypoint.sh). This is the last-resort backstop; reap() below is the
  // precise path.
  sleepAfter = "6h";

  async runJob(jitConfig: string): Promise<void> {
    // Pass the JIT config via env; the image entrypoint runs
    //   ./run.sh --jitconfig "$JIT_CONFIG"
    await this.start({ envVars: { JIT_CONFIG: jitConfig }, enableInternet: true });
  }

  /**
   * Tear the container down once GitHub says the job is over. A JIT runner that
   * claimed a job exits on its own, but one that was never assigned a job
   * long-polls forever and bills its memory the whole time.
   */
  async reap(): Promise<void> {
    if (this.ctx.container?.running) await this.destroy();
  }
}

export class RunnerContainerGo extends RunnerContainerBase {}
export class RunnerContainerNode extends RunnerContainerBase {}
```

- [ ] **Step 2: Route spawn and reap to the matching namespace**

Add a namespace selector above `export default`:

```ts
function namespaceForJob(env: Env, body: WorkflowJobEvent): DurableObjectNamespace {
  return runnerClassFor(body) === "node" ? env.RUNNER_NODE : env.RUNNER_GO;
}
```

In `fetch`, change the reap and spawn blocks to select the namespace and, on spawn, advertise the discriminated labels. The base-label gate (`shouldReap`/`shouldSpawn` against `labels`) is unchanged:

```ts
    // The job ended (succeeded, failed, or was cancelled). Kill its container in
    // the class it was spawned in: reaping the wrong namespace leaks the container.
    if (shouldReap(event, body, labels)) {
      const name = `cf-${body.workflow_job.id}`;
      await getContainer(namespaceForJob(env, body), name).reap();
      return new Response(`reaped ${name}`, { status: 202 });
    }

    if (!shouldSpawn(event, body, labels)) {
      // 204 must have a null body (Workers runtime throws otherwise).
      return new Response(null, { status: 204 });
    }

    // Unique name per job id => a fresh container instance, and idempotent if
    // GitHub re-delivers the same queued event (same DO, same JIT name).
    const name = `cf-${body.workflow_job.id}`;
    const jit = await mintJitConfig({
      scope: scopeFromEnv(env),
      runnerGroupId: Number(env.RUNNER_GROUP_ID || "1"),
      labels: advertisedLabels(body, labels),
      name,
      token: env.GITHUB_TOKEN,
    });

    await getContainer(namespaceForJob(env, body), name).runJob(jit);
    return new Response(`spawned ${name}`, { status: 202 });
```

- [ ] **Step 3: Typecheck and run the suite**

Run: `npx tsc --noEmit && npm test`
Expected: no type errors (the `DurableObjectNamespace` generic on `namespaceForJob` may need to be the un-parameterised `DurableObjectNamespace` since Go/Node namespaces are distinct types - if tsc complains, type the return as `DurableObjectNamespace<RunnerContainerBase>` and confirm `getContainer` accepts it; both subclasses extend the base). All existing tests still pass.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit --no-gpg-sign -m "Bind two container namespaces and route dispatch by class

Env exposes RUNNER_GO and RUNNER_NODE; RunnerContainerGo/Node extend a shared
base. fetch routes both spawn and reap through namespaceForJob so a job's
container lives and dies in one class, and mints the JIT runner with the
discriminated labels so GitHub assigns the go/node job to it."
```

---

### Task 3: Wrangler configs and docs

Three configs, structurally identical, differing only in `instance_type` numbers. Each gains a second container, a second binding, and the v2 migration.

**Files:**
- Modify: `wrangler.focusit-us.jsonc`, `wrangler.codus-nullus.jsonc`, `wrangler.jsonc`
- Modify: `README.md`

**Interfaces:**
- Consumes from Task 2: class names `RunnerContainerGo` / `RunnerContainerNode`, binding names `RUNNER_GO` / `RUNNER_NODE`.

- [ ] **Step 1: `wrangler.focusit-us.jsonc` - Go 6 GiB, Node 4 GiB**

Replace the single `containers` entry, the `durable_objects.bindings`, and the `migrations` with:

```jsonc
  // Two sizes, one Worker. The go class carries the heavy Go compile (pbx's
  // test-go job) at 6 GiB - proven necessary: at 4 GiB the combined test job
  // died with "lost communication ... starves for Memory". The node class
  // carries node typecheck + vitest + a Python venv at 4 GiB. A bare
  // self-hosted,cloudflare job (no go/node label) routes to the go class.
  //
  // disk_mb 8000 leaves ~6.6 GB after the 1.34 GB image. The 16-image build
  // matrix does NOT run here (build-and-push.yml pins it to ubuntu-latest). If a
  // job fails on "no space left on device", raise the relevant class to 12000.
  "containers": [
    {
      "class_name": "RunnerContainerGo",
      "image": "./Dockerfile",
      "max_instances": 20,
      "instance_type": { "vcpu": 1, "memory_mib": 6144, "disk_mb": 8000 }
    },
    {
      "class_name": "RunnerContainerNode",
      "image": "./Dockerfile",
      "max_instances": 20,
      "instance_type": { "vcpu": 1, "memory_mib": 4096, "disk_mb": 8000 }
    }
  ],
  "durable_objects": {
    "bindings": [
      { "class_name": "RunnerContainerGo", "name": "RUNNER_GO" },
      { "class_name": "RunnerContainerNode", "name": "RUNNER_NODE" }
    ]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["RunnerContainer"] },
    {
      "tag": "v2",
      "renamed_classes": [{ "from": "RunnerContainer", "to": "RunnerContainerGo" }],
      "new_sqlite_classes": ["RunnerContainerNode"]
    }
  ]
```

Leave `name`, `main`, `compatibility_date`, `vars`, and the `image`/`max_instances` intent as they are. Remove the old single-container comment block that described one instance type.

- [ ] **Step 2: `wrangler.codus-nullus.jsonc` - both classes 4 GiB**

Apply the same three-block replacement, but both `instance_type`s at `{ "vcpu": 1, "memory_mib": 4096, "disk_mb": 8000 }`, and carry over that file's existing `max_instances` value (do not change it). Add a one-line comment: `// Both classes at one size - codus-nullus jobs carry no go/node label, so all route to the go class; the node class exists only to satisfy the shared Worker shape.`

- [ ] **Step 3: `wrangler.jsonc` - public default, both classes at the file's current size**

Same replacement. Keep whatever `instance_type` this file currently ships as the value for **both** classes (read it first; do not silently change the public default's size). Same one-line comment as Step 2, phrased for the generic default.

- [ ] **Step 4: Validate all three configs**

Run: `npx wrangler deploy --dry-run --config wrangler.focusit-us.jsonc`, then the same for `wrangler.codus-nullus.jsonc` and `wrangler.jsonc`.
Expected: each prints a successful dry-run bundle with two container classes and the v2 migration listed, and no schema error. `--dry-run` neither deploys nor migrates. If wrangler's bundled `config-schema.json` types `instance_type` as a string enum and warns, that warning is benign (the object form is accepted at deploy time, as recorded for the earlier custom-instance-type change); a hard error is not.

- [ ] **Step 5: Document the routing in `README.md`**

Add a short section (place it near the existing instance-sizing note) explaining: a job labelled `[self-hosted, cloudflare, node]` runs on the node class, `[... , go]` or bare `[self-hosted, cloudflare]` runs on the go class; the go class is the default and should be sized for the heaviest job; both classes run the same image and differ only in `instance_type`; a runner advertises the discriminator so GitHub assigns the labelled job. Match the file's existing prose voice. No em-dash.

- [ ] **Step 6: Commit**

```bash
git add wrangler.focusit-us.jsonc wrangler.codus-nullus.jsonc wrangler.jsonc README.md
git commit --no-gpg-sign -m "Declare two container classes in every wrangler config

Each config now binds RUNNER_GO + RUNNER_NODE and carries the v2 rename+add
migration. focusit-us sizes go at 6 GiB and node at 4 GiB; codus-nullus and the
public default put both classes at one size. README documents the go/node
label routing."
```

---

### Task 4: Deploy and verify live (the operator step)

Not a code change. A live Durable Object migration on three deployed Workers, verified against the API - `wrangler`'s `SUCCESS` line is not proof.

**Files:** none.

- [ ] **Step 1: Deploy `focusit-us` and confirm the migration applied**

```bash
npx wrangler deploy --config wrangler.focusit-us.jsonc
```

Then verify against the API (not the CLI output), listing the app's container classes and their memory:

```bash
GH_TOKEN unused here; use the Cloudflare API with the account token.
```

Read the two application configs for `flare-runner-focusit-us` from `GET /accounts/{id}/containers/applications` and confirm two classes exist, `RunnerContainerGo` at 6144 MiB and `RunnerContainerNode` at 4096 MiB, and that the app `version` advanced. If the version did not advance or memory is unchanged, redeploy once and re-check (wrangler has been observed to print `SUCCESS Modified application` without persisting on the first call).

- [ ] **Step 2: Deploy `codus-nullus` and the public default**

```bash
npx wrangler deploy --config wrangler.codus-nullus.jsonc
npx wrangler deploy --config wrangler.jsonc
```

Verify each the same way: two classes present, both at 4096 MiB, version advanced.

- [ ] **Step 3: Exercise the Go (default) path with a real bare-label job**

The existing `pbx` `test` job still uses bare `[self-hosted, cloudflare]`. Trigger it (a no-op PR commit, or `gh workflow run`), and confirm from the run that it ran on a runner and passed - and that the container it used was a `RunnerContainerGo` instance at 6 GiB (check the app's container instances via the API during/after the run). This is the proof that deploying alone fixed the 4 GiB flakiness before any relabel.

- [ ] **Step 4: Record the outcome and hand off to the pbx split**

Note on the tracking issue (or in the branch's follow-up notes): the two-class runner is live, the go class is 6 GiB, the node class is 4 GiB and unproven until the `pbx` `test-node` job exercises it. The `pbx` workflow split (`test` -> `test-go` + `test-node`, `mandatory-gates` -> `go`) is the next, separate change and must not merge until Steps 1-3 here are green.

- [ ] **Step 5: Open the PR**

Ask the operator first. Push `feat/two-class-runners` and open a PR against `andrius/flare-runner` `main`, body summarising the routing, the migration, and the deploy-order dependency for `pbx`.

---

## Self-Review

**Spec coverage.** Routing + default-to-Go: Task 1 (`runnerClassFor`), Global Constraints. Advertised-label derivation (the JIT-assignment requirement): Task 1 (`advertisedLabels`), Task 2 Step 2. Two classes over a shared base: Task 2 Step 1. Reap routes to the same namespace: Task 2 Step 2. Uniform three configs, sizes table: Task 3 Steps 1-3. Migration rename+add: Task 3 Step 1 (and replicated in 2-3). Live migration verified against the API, not the CLI: Task 4 Steps 1-2. Deploy-before-relabel order: Task 4 Step 4, Global Constraints. The pbx split stays out of scope, named as the follow-up.

**Placeholder scan.** No `TBD`/`TODO`. Task 4 Step 1 has a prose line where a Cloudflare-API one-liner belongs; the operator reuses the account-token API pattern already used this session (`GET /accounts/{id}/containers/applications`), and the intent - two classes, 6144 / 4096 MiB, version advanced - is stated exactly. That is an operator action against a live account, not code to transcribe, so it is described rather than scripted.

**Type consistency.** `RunnerClass`, `runnerClassFor`, `advertisedLabels` are named identically in Task 1's implementation, Task 1's tests, and Task 2's import. `RunnerContainerGo` / `RunnerContainerNode` and the bindings `RUNNER_GO` / `RUNNER_NODE` match across `index.ts` (Task 2) and all three wrangler configs (Task 3). The migration renames `RunnerContainer` (the current class name in every config) to `RunnerContainerGo`, matching Task 2's rename.

**One risk flagged for the implementer.** Task 2 Step 3 calls out the `DurableObjectNamespace` generic: `namespaceForJob` returns one of two differently-parameterised namespaces, so its return type must be the shared base (`DurableObjectNamespace<RunnerContainerBase>`) or unparameterised. The step tells the implementer to confirm `getContainer` accepts it and adjust if tsc objects, rather than assuming.
