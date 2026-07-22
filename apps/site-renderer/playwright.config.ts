import { defineConfig } from "@playwright/test";

const BREAKPOINTS = [
  { name: "mobile-375", width: 375, height: 900 },
  { name: "tablet-768", width: 768, height: 1024 },
  { name: "desktop-1440", width: 1440, height: 1000 },
] as const;

export default defineConfig({
  testDir: "./visual-tests",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? "line" : "list",
  snapshotPathTemplate: "{testDir}/__screenshots__/{projectName}/{arg}{ext}",
  use: {
    baseURL: "http://127.0.0.1:4325",
    channel: "chrome",
    colorScheme: "light",
    locale: "en-US",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: BREAKPOINTS.map(({ name, width, height }) => ({
    name,
    use: { viewport: { width, height } },
  })),
  webServer: {
    command:
      "SITESPEC_PATH=fixtures/technical-baseline-spec.json pnpm dev --host 127.0.0.1 --port 4325",
    url: "http://127.0.0.1:4325",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
