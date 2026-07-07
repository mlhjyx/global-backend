/**
 * 邮箱验证合规门 · 验证。证明：探测**人名邮箱**前先过 lawful-basis / LIA 门。
 *
 * #14 后 SMTP 出网走 ToolBroker、SelfHostedEmailVerifier 聚焦出网机制；**合规门在服务层**
 * （verifyContactPoint）先于选择/调用任何验证器裁决——provider 无关，防 kill-switch 落到忽略
 * ctx 的 sandbox/public_web 绕过。本脚本离线跑纯裁决 evaluateEmailGate + 佐证 sandbox 不设防。
 *   node --import tsx scripts/verify-email-gate.mts
 */
import { evaluateEmailGate, resolveEmailVerificationPolicy } from '../src/discovery/compliance/email-verification-gate';
import type { LawfulBasis } from '../src/discovery/provider-contract';

const strict = resolveEmailVerificationPolicy(); // env 未设 → allowPersonalWithoutBasis=false

const cases: { label: string; email: string; lawfulBasis?: LawfulBasis; suppressed?: boolean; allow?: boolean }[] = [
  { label: '职能邮箱·无需 basis', email: 'info@acme.de' },
  { label: '人名邮箱·无 basis（默认拦）', email: 'max.mustermann@acme.de' },
  { label: '人名邮箱·显式 LIA', email: 'max.mustermann@acme.de', lawfulBasis: { basis: 'legitimate_interest', ref: 'LIA-2026-DEMO' } },
  { label: '人名邮箱·显式开关', email: 'jane.doe@acme.de', allow: true },
  { label: '人名邮箱·禁联命中', email: 'max.mustermann@acme.de', suppressed: true, lawfulBasis: { basis: 'consent' } },
  { label: '畸形+禁联（先于语法）', email: 'not-an-email', suppressed: true },
];

console.log('— evaluateEmailGate（服务层权威裁决，纯逻辑）—');
for (const c of cases) {
  const d = evaluateEmailGate({
    email: c.email,
    lawfulBasis: c.lawfulBasis,
    suppressed: c.suppressed,
    policy: c.allow ? { allowPersonalWithoutBasis: true } : strict,
  });
  const basis = d.lawfulBasis ? ` basis=${d.lawfulBasis.basis}` : '';
  console.log(
    `${c.label.padEnd(22)} ${c.email.padEnd(30)} → ${d.allowed ? 'ALLOW' : 'BLOCK'} [${d.kind.padEnd(8)}] ${d.reason}${basis}`,
  );
}

// 佐证 Codex P1：其它验证器忽略 ctx —— 故门必须在服务层、先于选择/调用任何 adapter。
const { SandboxDiscoveryProvider } = await import('../src/discovery/providers/sandbox.provider');
const s = await new SandboxDiscoveryProvider().verifyEmail('max.mustermann@acme.de', { suppressed: true } as never);
console.log(
  `\nsandbox.verifyEmail（人名+禁联，忽略 ctx）→ ${s.status}  ← adapter 自身不设防；` +
    `故 verifyContactPoint 在**路由前**跑门，门拦截即 BLOCKED、根本不路由到此。`,
);
