import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    env: { TRELLIS_APP_SESSION_SIGNING_KEY: "ab".repeat(32) },
    include: ["src/**/*.test.ts"]
  }
})
