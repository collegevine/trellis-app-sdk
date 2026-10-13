import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    env: {
      TRELLIS_APP_COOKIE_SIGNING_KEY: "ab".repeat(32),
      TRELLIS_APP_COOKIE_NAME_PREFIX: "6f1c2b8e-1138-4e2a-9d3f-a1b2c3d4e5f6"
    }
  }
})
