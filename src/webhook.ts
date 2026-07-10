// GitHub webhook verification + event filtering. Pure functions, no Worker
// runtime dependency, so they are unit-testable under plain vitest.

/** Verify a GitHub `X-Hub-Signature-256` header against the raw request body. */
export async function verifySignature(
  secret: string,
  rawBody: string,
  signatureHeader: string | null,
): Promise<boolean> {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const expected = signatureHeader.slice("sha256=".length);

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const actual = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");

  return timingSafeEqual(expected, actual);
}

/** Length-checked, constant-time string compare (avoids leaking via early exit). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

export interface WorkflowJobEvent {
  action: string;
  workflow_job: { id: number; run_id: number; labels: string[] };
  repository: { full_name: string };
  organization?: { login: string };
}

/** Are the job's labels a superset of the labels our runners advertise? */
function labelsMatch(body: WorkflowJobEvent, requiredLabels: string[]): boolean {
  const jobLabels = new Set((body.workflow_job?.labels ?? []).map((l) => l.toLowerCase()));
  return requiredLabels.every((l) => jobLabels.has(l.toLowerCase()));
}

/**
 * Should this delivery spawn a runner? Only for a `workflow_job` that is
 * `queued` and whose labels are a superset of our required labels - so we never
 * spawn a container for a job that asked for a different runner.
 */
export function shouldSpawn(
  eventHeader: string | null,
  body: WorkflowJobEvent,
  requiredLabels: string[],
): boolean {
  if (eventHeader !== "workflow_job") return false;
  if (body.action !== "queued") return false;
  return labelsMatch(body, requiredLabels);
}

/**
 * Should this delivery reap the container for the job? A JIT runner exits by
 * itself once it has claimed and finished one job, but a runner that was never
 * assigned a job (GitHub gave it to another runner, or the job was cancelled)
 * long-polls forever. Container memory is billed on wall-clock, so such a
 * container bills until something kills it. `workflow_job: completed` is the
 * event that tells us the job is over, whatever its conclusion.
 */
export function shouldReap(
  eventHeader: string | null,
  body: WorkflowJobEvent,
  requiredLabels: string[],
): boolean {
  if (eventHeader !== "workflow_job") return false;
  if (body.action !== "completed") return false;
  return labelsMatch(body, requiredLabels);
}
