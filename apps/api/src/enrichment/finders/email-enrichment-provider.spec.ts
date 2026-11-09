import { describe, expect, it } from 'vitest';
import {
  enrichmentInputVersion,
  enrichmentRequestHash,
  namesMatch,
  normalizeEnrichedEmail,
  personNameParts,
  unconfiguredFindEmailOutcome,
  type FindEmailInput,
} from './email-enrichment-provider';

/**
 * P1-07：富集适配器共享纯函数——幂等键、返回值边界校验、人名归一。
 * 这些函数是「重跑不重扣」与「供应商串号防护」的承重点，逐条钉契约。
 */
const input: FindEmailInput = {
  workspaceId: 'ws-1',
  contactId: 'contact-1',
  fullName: 'Jürgen Müller',
  domain: 'acme.example',
  companyName: 'Acme GmbH',
  accountKey: 'account-1',
};

describe('enrichmentRequestHash：幂等键', () => {
  it('同输入（含 workspaceId/runId/accountKey 差异）→ 同键；输入或 provider/联系人变化 → 换键', () => {
    const base = enrichmentRequestHash('contact-1', 'hunter', input);
    expect(base).toMatch(/^[0-9a-f]{64}$/u);
    expect(enrichmentRequestHash('contact-1', 'hunter', { ...input })).toBe(base);
    // 幂等键只看 contactId|provider|inputVersion：租户/账户/run 不参与（同一联系人跨 run 不重扣）。
    expect(
      enrichmentRequestHash('contact-1', 'hunter', {
        ...input,
        workspaceId: 'ws-2',
        accountKey: 'account-2',
        runId: 'run-9',
      }),
    ).toBe(base);
    expect(enrichmentRequestHash('contact-2', 'hunter', input)).not.toBe(base);
    expect(enrichmentRequestHash('contact-1', 'prospeo', input)).not.toBe(base);
    expect(
      enrichmentRequestHash('contact-1', 'hunter', { ...input, fullName: 'Jürgen Müller-Schmidt' }),
    ).not.toBe(base);
    expect(enrichmentRequestHash('contact-1', 'hunter', { ...input, domain: 'other.example' })).not.toBe(base);
  });

  it('inputVersion 对空白与大小写做归一口径（域大小写不敏感）', () => {
    expect(enrichmentInputVersion({ ...input, domain: 'ACME.Example' })).toBe(
      enrichmentInputVersion(input),
    );
    expect(enrichmentInputVersion({ ...input, fullName: ' Jürgen Müller ' })).toBe(
      enrichmentInputVersion(input),
    );
  });
});

describe('normalizeEnrichedEmail：返回值边界', () => {
  it('合法且域名一致 → 小写规范形', () => {
    expect(normalizeEnrichedEmail('  J.Mueller@Acme.Example ', 'acme.example')).toBe(
      'j.mueller@acme.example',
    );
  });

  it('非法形状、域名不一致（含子域与兄弟域）、非字符串 → null', () => {
    expect(normalizeEnrichedEmail('not-an-email', 'acme.example')).toBeNull();
    expect(normalizeEnrichedEmail('a@b@acme.example', 'acme.example')).toBeNull();
    expect(normalizeEnrichedEmail('x@other.example', 'acme.example')).toBeNull();
    expect(normalizeEnrichedEmail('x@mail.acme.example', 'acme.example')).toBeNull();
    expect(normalizeEnrichedEmail('x@acme.example.evil.example', 'acme.example')).toBeNull();
    expect(normalizeEnrichedEmail(null, 'acme.example')).toBeNull();
    expect(normalizeEnrichedEmail(42, 'acme.example')).toBeNull();
  });

  it('目标域的 www. 前缀被剥掉后比较', () => {
    expect(normalizeEnrichedEmail('x@acme.example', 'www.acme.example')).toBe('x@acme.example');
  });
});

describe('personNameParts / namesMatch：人名归一', () => {
  it('变音符/大小写/标点无关匹配；单名不可匹配', () => {
    expect(personNameParts('Jürgen Müller')).toEqual({ first: 'jurgen', last: 'muller' });
    expect(personNameParts('JÜRGEN  MÜLLER-SCHMIDT')).toEqual({
      first: 'jurgen',
      last: 'mullerschmidt',
    });
    expect(personNameParts('Cher')).toBeNull();
    expect(namesMatch('Jürgen', 'jurgen')).toBe(true);
    expect(namesMatch('Müller', 'MULLER')).toBe(true);
    expect(namesMatch(undefined, 'jurgen')).toBe(false);
  });
});

describe('unconfiguredFindEmailOutcome', () => {
  it('缺凭据 → 不可重试的 provider_unconfigured、成本 0', () => {
    expect(unconfiguredFindEmailOutcome()).toEqual({
      status: 'error',
      errorCode: 'provider_unconfigured',
      retryable: false,
      costMicrousd: 0,
      latencyMs: 0,
      detail: expect.stringContaining('API key'),
    });
  });
});
