import { defineConfig, devices } from "@playwright/test";

/**
 * Tests de bout en bout : parcours réels dans un navigateur, sur une base jetable.
 * Lancement : npm run test:e2e (construit l'application, puis démarre le serveur sur 3100).
 */
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: "http://localhost:3100",
    locale: "fr-FR",
    timezoneId: "Europe/Paris",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node scripts/e2e-server.mjs",
    url: "http://localhost:3100/api/health",
    timeout: 300_000,
    reuseExistingServer: false,
    stdout: "pipe",
  },
});
