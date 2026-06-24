import { Container, getContainer } from "@cloudflare/containers";
import { verifySignature, shouldSpawn, type WorkflowJobEvent } from "./webhook";
import { mintJitConfig, type Scope } from "./github";

export interface Env {
  RUNNER: DurableObjectNamespace<RunnerContainer>;
  // vars - set exactly one of GITHUB_REPO ("owner/repo") or GITHUB_ORG ("org").
  GITHUB_REPO?: string;
  GITHUB_ORG?: string;
  RUNNER_GROUP_ID: string; // numeric id; "1" is the Default group
  RUNNER_LABELS: string; // comma-separated, e.g. "self-hosted,cloudflare"
  // secrets
  GITHUB_TOKEN: string; // PAT (POC) / installation token (later)
  WEBHOOK_SECRET: string;
}

/**
 * One ephemeral GitHub Actions runner per job. No port: the runner is an
 * outbound long-poll client, not an HTTP server. It boots in JIT mode, claims a
 * single job, then exits - Cloudflare reclaims the instance.
 */
export class RunnerContainer extends Container<Env> {
  // ponytail: no defaultPort - this is the CF "batch/cron" container shape, not a
  // server. sleepAfter is only a backstop; run.sh exits on its own after one job.
  sleepAfter = "30s";

  async runJob(jitConfig: string): Promise<void> {
    // Pass the JIT config via env; the image entrypoint runs
    //   ./run.sh --jitconfig "$JIT_CONFIG"
    await this.start({ envVars: { JIT_CONFIG: jitConfig }, enableInternet: true });
  }
}

function scopeFromEnv(env: Env): Scope {
  if (env.GITHUB_REPO) {
    const [owner, repo] = env.GITHUB_REPO.split("/");
    return { kind: "repo", owner, repo };
  }
  if (env.GITHUB_ORG) return { kind: "org", org: env.GITHUB_ORG };
  throw new Error("set GITHUB_REPO or GITHUB_ORG");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/webhook") {
      return new Response("flare-runner", { status: 200 });
    }

    const raw = await request.text();
    const ok = await verifySignature(
      env.WEBHOOK_SECRET,
      raw,
      request.headers.get("x-hub-signature-256"),
    );
    if (!ok) return new Response("bad signature", { status: 401 });

    const labels = env.RUNNER_LABELS.split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const body = JSON.parse(raw) as WorkflowJobEvent;

    if (!shouldSpawn(request.headers.get("x-github-event"), body, labels)) {
      return new Response("ignored", { status: 204 });
    }

    // Unique name per job id => a fresh container instance, and idempotent if
    // GitHub re-delivers the same queued event (same DO, same JIT name).
    const name = `cf-${body.workflow_job.id}`;
    const jit = await mintJitConfig({
      scope: scopeFromEnv(env),
      runnerGroupId: Number(env.RUNNER_GROUP_ID || "1"),
      labels,
      name,
      token: env.GITHUB_TOKEN,
    });

    await getContainer(env.RUNNER, name).runJob(jit);
    return new Response(`spawned ${name}`, { status: 202 });
  },
} satisfies ExportedHandler<Env>;
