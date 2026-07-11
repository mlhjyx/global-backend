import { defineConfig } from 'vitest/config';

/**
 * 收口⑥：为单测注入固定 PII_ENCRYPTION_KEY（32 字节 hex）。持久化路径（contact-persist /
 * email-guess-persist）现加密 PII，无 key 会 fail-closed 抛错；测试用固定 dev key 使加密可跑。
 * pii-crypto.spec 内自设/删 key 测 fail-closed，覆盖本默认。
 */
export default defineConfig({
  test: {
    env: {
      PII_ENCRYPTION_KEY: '0'.repeat(64),
    },
  },
});
