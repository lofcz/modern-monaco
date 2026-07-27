import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  timeout: 90_000,
  use: {
    baseURL: "http://127.0.0.1:8123",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "bun scripts/e2e-server.ts",
    url: "http://127.0.0.1:8123/e2e-node-modules-resolution.html",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
