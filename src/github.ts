// Mint an ephemeral just-in-time (JIT) runner config from GitHub. A JIT runner
// is inherently single-use: it registers, claims one job, and auto-removes.
// Works for both org-scoped and repo-scoped self-hosted runners (user repos have
// no runner groups, so they must register at the repo level).
// https://docs.github.com/rest/actions/self-hosted-runners

export type Scope =
  | { kind: "org"; org: string }
  | { kind: "repo"; owner: string; repo: string };

export function jitUrl(scope: Scope): string {
  return scope.kind === "org"
    ? `https://api.github.com/orgs/${scope.org}/actions/runners/generate-jitconfig`
    : `https://api.github.com/repos/${scope.owner}/${scope.repo}/actions/runners/generate-jitconfig`;
}

export interface JitParams {
  scope: Scope;
  runnerGroupId: number;
  labels: string[];
  name: string;
  /** Org/repo PAT (POC) or App installation token (later) - the Worker decides which. */
  token: string;
}

export function jitBody(p: Pick<JitParams, "name" | "runnerGroupId" | "labels">) {
  return {
    name: p.name,
    runner_group_id: p.runnerGroupId,
    labels: p.labels,
    work_folder: "_work",
  };
}

export async function mintJitConfig(
  p: JitParams,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const res = await fetchImpl(jitUrl(p.scope), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${p.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "flare-runner",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(jitBody(p)),
  });

  if (!res.ok) {
    throw new Error(`generate-jitconfig failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { encoded_jit_config: string };
  return data.encoded_jit_config;
}
