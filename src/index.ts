import { Container, getContainer } from "@cloudflare/containers";
import { verifySignature, shouldSpawn, shouldReap, type WorkflowJobEvent } from "./webhook";
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
   * long-polls forever and bills 6 GiB of memory the whole time.
   */
  async reap(): Promise<void> {
    if (this.ctx.container?.running) await this.destroy();
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
    const event = request.headers.get("x-github-event");

    // The job ended (succeeded, failed, or was cancelled). Kill its container:
    // if the runner never got the job, it is still long-polling and billing.
    if (shouldReap(event, body, labels)) {
      const name = `cf-${body.workflow_job.id}`;
      await getContainer(env.RUNNER, name).reap();
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
      labels,
      name,
      token: env.GITHUB_TOKEN,
    });

    await getContainer(env.RUNNER, name).runJob(jit);
    return new Response(`spawned ${name}`, { status: 202 });
  },
} satisfies ExportedHandler<Env>;
