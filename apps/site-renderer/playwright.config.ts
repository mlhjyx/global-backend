import { defineConfig } from "@playwright/test";

const BREAKPOINTS = [
  { name: "mobile-375", width: 375, height: 900 },
  { name: "tablet-768", width: 768, height: 1024 },
  { name: "desktop-1440", width: 1440, height: 1000 },
] as const;

const siteSpecPath =
  process.env.SITESPEC_PATH ?? "fixtures/technical-baseline-spec.json";
const snapshotPathTemplate = process.env.COMPONENT_QUALIFICATION_COMPONENT
  ? "{testDir}/__screenshots__/qualification/{projectName}/{arg}{ext}"
  : process.env.M1EB_GOLDEN_ID
    ? "{testDir}/__screenshots__/m1-e-b/{projectName}/{arg}{ext}"
    : "{testDir}/__screenshots__/{projectName}/{arg}{ext}";

export default defineConfig({
  testDir: "./visual-tests",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? "line" : "list",
  snapshotPathTemplate,
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
    command: `SITESPEC_PATH=${siteSpecPath} pnpm dev --host 127.0.0.1 --port 4325`,
    url: "http://127.0.0.1:4325",
    reuseExistingServer:
      !process.env.CI &&
      !process.env.COMPONENT_QUALIFICATION_COMPONENT &&
      !process.env.M1EB_GOLDEN_ID,
    timeout: 60_000,
  },
});
