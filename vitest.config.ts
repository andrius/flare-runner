import { defineConfig } from "vitest/config";

// Pure-function tests (HMAC, JIT request shape) run in the Node environment;
// crypto.subtle and fetch are globals there. The Worker fetch handler and the
// Container DO are exercised by the live acceptance run, not these unit tests.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
});
