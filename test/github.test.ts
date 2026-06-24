import { describe, it, expect } from "vitest";
import { jitBody, jitUrl, mintJitConfig, type JitParams } from "../src/github";

const params: JitParams = {
  scope: { kind: "repo", owner: "acme", repo: "app" },
  runnerGroupId: 1,
  labels: ["self-hosted", "cloudflare"],
  name: "cf-42",
  token: "ghp_test",
};

describe("jitUrl", () => {
  it("builds the repo-scoped endpoint", () => {
    expect(jitUrl({ kind: "repo", owner: "acme", repo: "app" })).toBe(
      "https://api.github.com/repos/acme/app/actions/runners/generate-jitconfig",
    );
  });
  it("builds the org-scoped endpoint", () => {
    expect(jitUrl({ kind: "org", org: "acme" })).toBe(
      "https://api.github.com/orgs/acme/actions/runners/generate-jitconfig",
    );
  });
});

describe("jitBody", () => {
  it("builds the GitHub generate-jitconfig request shape", () => {
    expect(jitBody(params)).toEqual({
      name: "cf-42",
      runner_group_id: 1,
      labels: ["self-hosted", "cloudflare"],
      work_folder: "_work",
    });
  });
});

describe("mintJitConfig", () => {
  it("posts to the scoped endpoint with auth + returns encoded_jit_config", async () => {
    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seenUrl = String(url);
      seenInit = init;
      return new Response(JSON.stringify({ encoded_jit_config: "BASE64BLOB" }), { status: 201 });
    }) as typeof fetch;

    const jit = await mintJitConfig(params, fakeFetch);

    expect(jit).toBe("BASE64BLOB");
    expect(seenUrl).toBe(
      "https://api.github.com/repos/acme/app/actions/runners/generate-jitconfig",
    );
    expect(seenInit?.method).toBe("POST");
    expect((seenInit?.headers as Record<string, string>).Authorization).toBe("Bearer ghp_test");
    expect(JSON.parse(seenInit?.body as string)).toMatchObject({ name: "cf-42" });
  });

  it("throws with status + body on a GitHub error", async () => {
    const fakeFetch = (async () =>
      new Response("Bad credentials", { status: 401 })) as typeof fetch;

    await expect(mintJitConfig(params, fakeFetch)).rejects.toThrow(/401.*Bad credentials/);
  });
});
