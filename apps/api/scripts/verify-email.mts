/**
 * 自建邮箱验证 · 真实验证。对真实邮箱跑 SelfHostedEmailVerifier(source_policy→MX→SMTP→分级)。
 * SMTP 出网经 ToolBroker 闸门（此脚本无 DB → source_policy reader 缺省=无策略，一律放行）。
 * 注:Mac/多数网络封出网 25 端口 → SMTP 段会 smtp_unreachable→RISKY(诚实降级,非 bug)。
 *   node --import tsx scripts/verify-email.mts [email ...]
 */
import { readFileSync } from 'node:fs';
import { SelfHostedEmailVerifier } from '../src/discovery/providers/email-verify.provider';
import { buildToolBroker } from '../src/tools/tool-broker.factory';

for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !line.trimStart().startsWith('#')) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, '');
}

const targets = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['someone@gmail.com', 'info@trumpf.com', 'not-an-email', 'nobody@nonexistent-domain-zzq-xyz.com'];
const v = new SelfHostedEmailVerifier(buildToolBroker());

for (const email of targets) {
  const t0 = Date.now();
  const r = await v.verifyEmail(email);
  console.log(`${email.padEnd(42)} → ${r.status.padEnd(8)} ${r.detail ?? ''}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}
console.log('\n注:VALID 仅当「SMTP 可达+RCPT接受+非catch-all+非反枚举」;Gmail/M365/catch-all/端口25封 一律 RISKY。');
