import { describe, expect, it } from 'vitest';
import type { ExecutionBroker } from '../../tools/tool-contract';
import {
  resolveConfiguredVerificationProviders,
  withSmtpProbeFallback,
} from './provider-pool';
import type { EmailVerificationProvider } from './email-verification-provider';

describe('resolveConfiguredVerificationProviders', () => {
  it('无凭据 → 空池（瀑布不会出现 provider_unconfigured 空转）', () => {
    expect(resolveConfiguredVerificationProviders({})).toEqual([]);
  });

  it('只有 MillionVerifier key → 单元素池（主验）', () => {
    const providers = resolveConfiguredVerificationProviders({ MILLIONVERIFIER_API_KEY: 'mv' });
    expect(providers.map((p) => p.key)).toEqual(['millionverifier']);
  });

  it('两家 key 都在 → 固定顺序 [millionverifier, emailable]（主验在前）', () => {
    const providers = resolveConfiguredVerificationProviders({
      MILLIONVERIFIER_API_KEY: 'mv',
      EMAILABLE_API_KEY: 'em',
    });
    expect(providers.map((p) => p.key)).toEqual(['millionverifier', 'emailable']);
  });

  it('ZeroBounce 作为仲裁席排在最后；Truelist 不入池（解析分支未接线）', () => {
    const providers = resolveConfiguredVerificationProviders({
      MILLIONVERIFIER_API_KEY: 'mv',
      EMAILABLE_API_KEY: 'em',
      ZEROBOUNCE_API_KEY: 'zb',
      TRUELIST_API_KEY: 'tl',
    });
    expect(providers.map((p) => p.key)).toEqual(['millionverifier', 'emailable', 'zerobounce']);
  });

  it('Emailable 单独配置也可用（主验降级但仍能出单票 UNKNOWN）', () => {
    const providers = resolveConfiguredVerificationProviders({ EMAILABLE_API_KEY: 'em' });
    expect(providers.map((p) => p.key)).toEqual(['emailable']);
  });
});

describe('withSmtpProbeFallback：第二票兜底', () => {
  const broker: ExecutionBroker = {
    checkSourcePolicy: async () => ({ allowed: true }),
    invoke: async () => {
      throw new Error('测试不应真实调用');
    },
  };

  function fakeDb(status: string | null = 'ENABLED') {
    const lookups: string[] = [];
    return {
      lookups,
      prisma: {
        dataProvider: {
          async findUnique(args: { where: { key: string } }) {
            lookups.push(args.where.key);
            return status === null ? null : { status };
          },
        },
      },
    };
  }

  function pool(...keys: string[]): EmailVerificationProvider[] {
    return keys.map((key) => ({
      key,
      domain: `${key}.example`,
      isConfigured: () => true,
      verify: async () => {
        throw new Error('测试不应真实调用');
      },
    }));
  }

  it('外部验证器 1 家 + 开关开 + kill switch ENABLED → 追加 smtp_self 到末席', async () => {
    const db = fakeDb('ENABLED');
    const outcome = await withSmtpProbeFallback(pool('zerobounce'), {
      prisma: db.prisma as never,
      broker,
      env: { EMAIL_VERIFY_SMTP_PROBE_ENABLED: 'true' },
    });
    expect(outcome.providers.map((p) => p.key)).toEqual(['zerobounce', 'smtp_self']);
    expect(outcome.note).toBeNull();
    expect(db.lookups).toEqual(['smtp_self']);
  });

  it('外部验证器 0 家 → 兜底票单独成池（单票仍只能 UNKNOWN）', async () => {
    const db = fakeDb('ENABLED');
    const outcome = await withSmtpProbeFallback([], {
      prisma: db.prisma as never,
      broker,
      env: { EMAIL_VERIFY_SMTP_PROBE_ENABLED: 'true' },
    });
    expect(outcome.providers.map((p) => p.key)).toEqual(['smtp_self']);
  });

  it('外部验证器已 ≥2 家 → 不追加（SMTP 不占仲裁席）', async () => {
    const db = fakeDb('ENABLED');
    const outcome = await withSmtpProbeFallback(pool('millionverifier', 'emailable'), {
      prisma: db.prisma as never,
      broker,
      env: { EMAIL_VERIFY_SMTP_PROBE_ENABLED: 'true' },
    });
    expect(outcome.providers.map((p) => p.key)).toEqual(['millionverifier', 'emailable']);
    expect(outcome.note).toBeNull();
    expect(db.lookups).toEqual([]);
  });

  it('缺省（未设置 env）→ 不追加（2026-11-10 实测 25 端口不可用，默认关）', async () => {
    const db = fakeDb('ENABLED');
    const outcome = await withSmtpProbeFallback(pool('zerobounce'), { prisma: db.prisma as never, broker, env: {} });
    expect(outcome.providers.map((p) => p.key)).toEqual(['zerobounce']);
    expect(outcome.note).toBe('smtp_probe_disabled_by_env');
    expect(db.lookups).toEqual([]);
  });

  it('env 开关显式关闭 → 不追加并给出原因', async () => {
    const db = fakeDb('ENABLED');
    const outcome = await withSmtpProbeFallback(pool('zerobounce'), {
      prisma: db.prisma as never,
      broker,
      env: { EMAIL_VERIFY_SMTP_PROBE_ENABLED: 'false' },
    });
    expect(outcome.providers.map((p) => p.key)).toEqual(['zerobounce']);
    expect(outcome.note).toBe('smtp_probe_disabled_by_env');
    expect(db.lookups).toEqual([]);
  });

  it('data_provider.smtp_self 未启用/缺失 → 不追加（运维 kill switch）', async () => {
    for (const status of ['DISABLED', null]) {
      const db = fakeDb(status);
      const outcome = await withSmtpProbeFallback(pool('zerobounce'), {
        prisma: db.prisma as never,
        broker,
        env: { EMAIL_VERIFY_SMTP_PROBE_ENABLED: 'true' },
      });
      expect(outcome.providers.map((p) => p.key)).toEqual(['zerobounce']);
      expect(outcome.note).toBe('smtp_probe_kill_switch_off');
    }
  });

  it('未装配 broker → 不追加（绝不裸出网）', async () => {
    const db = fakeDb('ENABLED');
    const outcome = await withSmtpProbeFallback(pool('zerobounce'), {
      prisma: db.prisma as never,
      env: { EMAIL_VERIFY_SMTP_PROBE_ENABLED: 'true' },
    });
    expect(outcome.providers.map((p) => p.key)).toEqual(['zerobounce']);
    expect(outcome.note).toBe('smtp_probe_broker_unavailable');
  });
});
