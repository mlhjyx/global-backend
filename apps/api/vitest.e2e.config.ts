import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@global\/test-support$/,
        replacement: fileURLToPath(
          new URL("../../packages/test-support/src/index.ts", import.meta.url),
        ),
      },
    ],
  },
  test: {
    include: ["test/e2e-precision-intel/**/*.e2e.ts"],
    exclude: ["node_modules/**", "dist/**"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: {
      APP_DATABASE_URL: "",
      PII_KEYRING_JSON: JSON.stringify({
        activeKeyId: "k1",
        keys: { k1: "0".repeat(64) },
      }),
      OUTREACH_DNC_HMAC_PEPPER: "1".repeat(64),
      DATA_PROCESSOR_JURISDICTION: "EU",
      RUN_BUDGET_CENTS: "2000",
      SWEEP_BUDGET_CENTS: "5000",
    },
  },
});
