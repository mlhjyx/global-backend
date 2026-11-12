import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * 收口⑥：为单测注入固定 PII_ENCRYPTION_KEY（32 字节 hex）。持久化路径（contact-persist /
 * email-guess-persist）现加密 PII，无 key 会 fail-closed 抛错；测试用固定 dev key 使加密可跑。
 * pii-crypto.spec 内自设/删 key 测 fail-closed，覆盖本默认。
 */
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
    exclude: ["src/site-builder/eval/**", "node_modules/**", "dist/**"],
    env: {
      PII_ENCRYPTION_KEY: "0".repeat(64),
      DATA_PROCESSOR_JURISDICTION: "EU",
      RUN_BUDGET_CENTS: "2000",
      SWEEP_BUDGET_CENTS: "5000",
    },
  },
  // G18（2026-11-12）：每周覆盖率棘轮。Temporal 工作流与 site-builder eval 不参与
  // （replay/评测对插桩敏感）；基线为 2026-11-12 实测值向下取整。
  coverage: {
    provider: "v8",
    include: ["src/**/*.ts"],
    exclude: [
      "src/temporal/**",
      "src/site-builder/eval/**",
      "src/**/*.spec.ts",
      "src/**/*.test.ts",
      "src/**/*.d.ts",
    ],
    reporter: ["text-summary", "json-summary"],
    reportsDirectory: "../../coverage/api",
    thresholds: {
      lines: 88,
      statements: 86,
      functions: 87,
      branches: 80,
    },
  },
});
