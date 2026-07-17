/**
 * 幂等配置 New API → 本机 Ollama BGE-M3，并创建只允许本机别名的专用令牌。
 *
 * 前置：在 New API 个人设置生成管理员 access token（不是 sk- 模型令牌）：
 *   NEW_API_ADMIN_ACCESS_TOKEN=... NEW_API_ADMIN_USER_ID=1 \
 *   pnpm --filter @global/api new-api:ensure-embeddings -- --write-env
 *
 * 默认只配置并真探；--write-env 会以 0600 权限更新当前 apps/api/.env，且绝不打印 key。
 */
import 'dotenv/config';
import { resolve } from 'node:path';
import {
  provisionLocalEmbeddingGateway,
  writeEmbeddingEnv,
} from '../src/site-builder/new-api-embeddings-bootstrap';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const modelGatewayUrl = process.env.MODEL_GATEWAY_URL?.trim() ?? 'http://localhost:3001/v1';
const adminBaseUrl = (
  process.env.NEW_API_ADMIN_URL?.trim() ?? modelGatewayUrl.replace(/\/v1\/?$/, '')
).replace(/\/+$/, '');
const adminUserId = Number(required('NEW_API_ADMIN_USER_ID'));

const result = await provisionLocalEmbeddingGateway({
  adminBaseUrl,
  adminAccessToken: required('NEW_API_ADMIN_ACCESS_TOKEN'),
  adminUserId,
});

const explicitEnv = process.argv.find((arg) => arg.startsWith('--env-file='))?.slice(11);
if (process.argv.includes('--write-env') || explicitEnv) {
  const envPath = explicitEnv ? resolve(explicitEnv) : resolve(process.cwd(), '.env');
  await writeEmbeddingEnv(envPath, result, modelGatewayUrl);
  console.log(`✓ local embedding route ready; dedicated token written to ${envPath} (0600)`);
} else {
  console.log('✓ local embedding route and dedicated token ready; endpoint returned 1024 dimensions');
  console.log('  rerun with --write-env to store the dedicated token in apps/api/.env');
}
