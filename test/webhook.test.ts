import { describe, it, expect } from "vitest";
import { verifySignature, shouldSpawn, type WorkflowJobEvent } from "../src/webhook";

// Helper: produce a valid GitHub-style sha256 signature header for a body.
async function sign(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `sha256=${hex}`;
}

describe("verifySignature", () => {
  const secret = "s3cret";
  const body = '{"hello":"world"}';

  it("accepts a correctly signed body", async () => {
    expect(await verifySignature(secret, body, await sign(secret, body))).toBe(true);
  });

  it("rejects a tampered body", async () => {
    const header = await sign(secret, body);
    expect(await verifySignature(secret, body + "x", header)).toBe(false);
  });

  it("rejects the wrong secret", async () => {
    expect(await verifySignature("other", body, await sign(secret, body))).toBe(false);
  });

  it("rejects a missing or malformed header", async () => {
    expect(await verifySignature(secret, body, null)).toBe(false);
    expect(await verifySignature(secret, body, "deadbeef")).toBe(false);
  });
});

describe("shouldSpawn", () => {
  const required = ["self-hosted", "cloudflare"];
  const event = (action: string, labels: string[]): WorkflowJobEvent => ({
    action,
    workflow_job: { id: 1, run_id: 1, labels },
    repository: { full_name: "acme/app" },
  });

  it("spawns for a queued workflow_job whose labels cover the required set", () => {
    expect(shouldSpawn("workflow_job", event("queued", ["self-hosted", "cloudflare", "x64"]), required)).toBe(true);
  });

  it("is case-insensitive on labels", () => {
    expect(shouldSpawn("workflow_job", event("queued", ["Self-Hosted", "Cloudflare"]), required)).toBe(true);
  });

  it("ignores non-queued actions", () => {
    expect(shouldSpawn("workflow_job", event("in_progress", required), required)).toBe(false);
    expect(shouldSpawn("workflow_job", event("completed", required), required)).toBe(false);
  });

  it("ignores jobs missing a required label", () => {
    expect(shouldSpawn("workflow_job", event("queued", ["self-hosted"]), required)).toBe(false);
  });

  it("ignores other event types (e.g. ping, push)", () => {
    expect(shouldSpawn("ping", event("queued", required), required)).toBe(false);
    expect(shouldSpawn(null, event("queued", required), required)).toBe(false);
  });
});
