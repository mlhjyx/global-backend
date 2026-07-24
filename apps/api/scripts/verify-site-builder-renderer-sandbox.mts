/**
 * R1-safety 真 Astro 探针：父进程带敏感配置时，Renderer 仍只收到显式 allowlist，
 * 并能从随机临时 SiteSpec 生成完整静态产物。无 DB、无 sandbox、无 mock Renderer。
 *
 * 跑：cd apps/api && node --import tsx scripts/verify-site-builder-renderer-sandbox.mts
 */
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildRendererEnv,
  buildSiteSpecWithTemporaryFile,
} from '../src/site-builder/renderer-build';

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`assertion failed: ${message}`);
  console.log(`  ✅ ${message}`);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '../../..');
const fixturePath = path.join(repoRoot, 'apps/site-renderer/fixtures/demo-spec.json');
const outDir = await mkdtemp(path.join(tmpdir(), 'global-renderer-verify-'));
const siteOrigin = 'https://preview.example.test';

process.env.DATABASE_URL = 'must-not-reach-renderer';
process.env.S3_SECRET_KEY = 'must-not-reach-renderer';
process.env.NEW_API_KEY = 'must-not-reach-renderer';
process.env.NODE_OPTIONS = '--title=must-not-reach-renderer';

try {
  console.log('① env allowlist');
  const env = buildRendererEnv({
    specPath: fixturePath,
    outDir,
    basePath: '/preview/r1-safety/',
    siteOrigin,
  });
  check(Object.keys(env).length === 8, 'Renderer 环境固定为 8 个显式变量');
  check(!('DATABASE_URL' in env), '数据库连接串未传入 Renderer');
  check(!('S3_SECRET_KEY' in env), '对象存储密钥未传入 Renderer');
  check(!('NEW_API_KEY' in env), '模型网关密钥未传入 Renderer');
  check(!('NODE_OPTIONS' in env), 'Node 注入参数未传入 Renderer');
  check(!('PATH' in env) && !('HOME' in env), 'Renderer 不依赖宿主 PATH/HOME');

  console.log('② 真 Astro build');
  const spec = JSON.parse(await readFile(fixturePath, 'utf8')) as unknown;
  await buildSiteSpecWithTemporaryFile(spec, {
    outDir,
    basePath: '/preview/r1-safety/',
    siteOrigin,
  });

  for (const relative of ['index.html', 'products/index.html', 'contact/index.html']) {
    await access(path.join(outDir, relative));
  }
  check(true, '首页、产品页、联系页均由真 Astro 生成');
  const index = await readFile(path.join(outDir, 'index.html'), 'utf8');
  check(index.includes('/preview/r1-safety/_astro/'), '静态资产路径使用受控 BASE_PATH');
  check(
    index.includes(`${siteOrigin}/preview/r1-safety/`),
    'SEO 元数据使用受控平台 preview origin',
  );

  console.log('\n🎉 R1 Renderer 隔离真机探针全绿。');
} finally {
  delete process.env.DATABASE_URL;
  delete process.env.S3_SECRET_KEY;
  delete process.env.NEW_API_KEY;
  delete process.env.NODE_OPTIONS;
  await rm(outDir, { recursive: true, force: true });
}
