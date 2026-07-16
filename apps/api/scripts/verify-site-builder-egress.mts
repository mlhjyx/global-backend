/**
 * R1-safety ② 真机探针：Ubuntu mihomo fake-IP + API pinned HTTP + Crawl4AI 容器。
 * 不使用 sandbox/mock，不写数据库；需要 docker compose 的 crawl4ai 已启动。
 *
 * 跑：cd apps/api && node --import tsx scripts/verify-site-builder-egress.mts
 */
import 'dotenv/config';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { isPrivateIp, resolvePublicIp } from '../src/adapters/net-guard';
import { requestPublicHttp } from '../src/adapters/guarded-http';
import { resolvePublicHttpUrl } from '../src/adapters/url-guard';
import { crawlHtml, crawlUrl } from '../src/adapters/web-crawler';

const crawlerBase = process.env.CRAWLER_URL ?? 'http://127.0.0.1:11235';
// Compose 的开发 token 是公开本地值；若环境 .env 另有历史 token，不应误打当前容器。
const crawlerToken = process.env.R1_CRAWLER_TOKEN ?? 'global-local-crawl-token';
process.env.CRAWLER_URL = crawlerBase;
process.env.CRAWLER_TOKEN = crawlerToken;
const execFileAsync = promisify(execFile);

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`assertion failed: ${message}`);
  console.log(`  ✅ ${message}`);
}

async function expectBlocked(url: string): Promise<void> {
  try {
    await resolvePublicHttpUrl(url);
  } catch (error) {
    check(
      error instanceof Error && error.name === 'EgressBlockedError',
      `${url} 被 API egress gate 拒绝`,
    );
    return;
  }
  throw new Error(`assertion failed: ${url} 未被拒绝`);
}

console.log('① 容器运行态无 broad allow-internal');
const { stdout: crawlerEnvJson } = await execFileAsync('docker', [
  'inspect',
  'global-crawl4ai',
  '--format',
  '{{json .Config.Env}}',
]);
const crawlerEnv = JSON.parse(crawlerEnvJson) as string[];
check(
  !crawlerEnv.some((entry) => entry.startsWith('CRAWL4AI_ALLOW_INTERNAL_URLS=')),
  '运行容器未设置 CRAWL4AI_ALLOW_INTERNAL_URLS',
);
check(
  crawlerEnv.includes('CRAWL4AI_FAKEIP_DOH_FALLBACK=true'),
  '运行容器只启用 fake-IP 窄 DoH 回退',
);

console.log('② fake-IP 窄回退 + 公网 pin');
const publicResolution = await resolvePublicIp('example.com');
check(publicResolution.safe && !!publicResolution.ip, 'example.com 解析为可连接公网 pin');
check(!isPrivateIp(publicResolution.ip), 'pin 是 global unicast，不是 198.18/15/私网/保留地址');

console.log('③ API 连接层 pinning 正向');
const publicResponse = await requestPublicHttp('https://example.com/', {
  timeoutMs: 15_000,
  maxBytes: 200_000,
});
check(publicResponse.ok && publicResponse.text.includes('Example Domain'), '固定 IP + 原 Host/SNI 真取公网 HTTPS');

console.log('④ API private/loopback/metadata 负向');
for (const url of [
  'http://127.0.0.1:3000/admin',
  'http://10.0.0.1/internal',
  'http://169.254.169.254/latest/meta-data/',
  'http://[::ffff:127.0.0.1]/',
]) {
  await expectBlocked(url);
}

console.log('⑤ API redirect 逐跳负向');
try {
  await requestPublicHttp(
    'https://httpbin.org/redirect-to?url=http%3A%2F%2F169.254.169.254%2Flatest%2Fmeta-data%2F',
    { timeoutMs: 20_000, maxBytes: 200_000 },
  );
  throw new Error('redirect to metadata unexpectedly allowed');
} catch (error) {
  check(
    error instanceof Error && error.name === 'EgressBlockedError',
    '公网 302 跳 metadata 在第二跳连接前被拒绝',
  );
}

console.log('⑥ Crawl4AI 公网正向（/md + /crawl）');
const markdown = await crawlUrl('https://example.com/');
check(markdown.text.includes('Example Domain'), 'Crawl4AI /md 在关闭 allow-internal 后仍可抓公网');
const rendered = await crawlHtml('https://example.com/');
check(rendered.html.includes('Example Domain'), 'Crawl4AI /crawl 浏览器路径仍可抓公网');

console.log('⑦ Crawl4AI 容器私网负向');
for (const url of [
  'http://127.0.0.1:3000/admin',
  'http://10.0.0.1/internal',
  'http://169.254.169.254/latest/meta-data/',
  'http://[::ffff:127.0.0.1]/',
]) {
  const response = await fetch(`${crawlerBase}/crawl`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${crawlerToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ urls: [url] }),
    signal: AbortSignal.timeout(10_000),
  });
  check(response.status === 400, `Crawl4AI seed guard 400 拒绝 ${url}`);
}

console.log('⑧ Crawl4AI 真 Chromium redirect 到 metadata 负向');
const proxyVerifier = fileURLToPath(
  new URL('../../../infra/crawl4ai/verify_egress_proxy.py', import.meta.url),
);
const { stdout: proxyVerification } = await execFileAsync(
  'docker',
  [
    'run',
    '--rm',
    '--entrypoint',
    'python',
    '-e',
    'CRAWL4AI_FAKEIP_DOH_FALLBACK=true',
    '-v',
    `${proxyVerifier}:/tmp/verify.py:ro`,
    'global-crawl4ai:local',
    '/tmp/verify.py',
  ],
  { timeout: 60_000 },
);
check(
  proxyVerification.includes('真 Chromium 跟随公网 redirect 后由 pinning proxy 403 metadata'),
  'Crawl4AI browser proxy 对公网 302 后的 metadata 返回固定 403',
);

console.log('\n🎉 R1-safety ② API/Crawl4AI 真机 egress 探针全绿。');
