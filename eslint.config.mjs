// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

/**
 * 团队 lint 闸（flat config，管所有包）。用 typescript-eslint **recommended（非 type-checked）**：
 * 快、无需 parserOptions.project。策略：真·正确性问题拦为 error；风格/存量噪声降为 warn（不阻断 CI，
 * 但持续可见）。格式交给 prettier（eslint-config-prettier 关掉冲突规则）。
 */
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/*.mjs',
      '**/*.cjs',
      '**/*.d.ts',
      'apps/api/scripts/**', // 一次性 dev/tsx 脚本，不进 lint 闸
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      // 存量噪声降为 warn（可见但不阻断）：真源接入/重构时逐步清理
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-empty': ['warn', { allowEmptyCatch: true }], // fail-safe 空 catch 是本仓刻意模式
      'no-useless-assignment': 'warn', // eslint-10 新规则；存量少量命中，降 warn 不阻断、逐步清
      // worker.ts 合法使用 require.resolve 定位 workflow 包
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
);
