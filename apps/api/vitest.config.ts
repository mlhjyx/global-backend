import { defineConfig } from "vitest/config";

/**
 * 收口⑥：为单测注入固定 PII_ENCRYPTION_KEY（32 字节 hex）。持久化路径（contact-persist /
 * email-guess-persist）现加密 PII，无 key 会 fail-closed 抛错；测试用固定 dev key 使加密可跑。
 * pii-crypto.spec 内自设/删 key 测 fail-closed，覆盖本默认。
 */
export default defineConfig({
  test: {
    env: {
      PII_ENCRYPTION_KEY: "0".repeat(64),
    },
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.spec.ts", "src/**/testing/**"],
      reporter: ["text", "json-summary"],
      reportOnFailure: true,
      // These are the measured fixed-base floors, not an 80% success claim.
      // The exact-count ratchet and critical cohorts live in
      // config/api-coverage-policy.json and reject declines hidden by rounding.
      thresholds: {
        statements: 70.75,
        branches: 66.89,
        functions: 74.3,
        lines: 72.93,
      },
    },
  },
});
