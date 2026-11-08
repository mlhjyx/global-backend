import { describe, expect, it, vi } from 'vitest';

import { upsertCompanyContactChannels } from './company-contact-channel';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const COMPANY = '22222222-2222-4222-8222-222222222222';

function fakeTx() {
  const upsert = vi.fn(async () => ({}));
  return { tx: { companyContactChannel: { upsert } } as never, upsert };
}

/**
 * A4：公司级联系方式写入器——数据分级纪律（email=amber 且不得 personal；phone/form_url=green）、
 * 自动化只写 UNVERIFIED、幂等 upsert 只推进 last_seen。
 */
describe('upsertCompanyContactChannels（A4）', () => {
  it('role 邮箱 → amber/UNVERIFIED，phone 与 form_url → green', async () => {
    const { tx, upsert } = fakeTx();
    const seenAt = new Date('2026-11-08T06:00:00Z');

    await upsertCompanyContactChannels(tx, {
      workspaceId: WORKSPACE,
      companyId: COMPANY,
      seenAt,
      channels: [
        { channel: 'email', value: 'Info@Mueller-Pumpen.DE', emailType: 'role', sourceType: 'impressum', sourceUrl: 'https://mueller-pumpen.de/impressum', robotsStatus: 'allowed', tosStatus: 'unknown', legalBasis: 'legitimate_interest' },
        { channel: 'phone', value: '+49 89 1234567', sourceType: 'impressum' },
        { channel: 'form_url', value: 'https://mueller-pumpen.de/kontakt', sourceType: 'contact_page' },
      ],
    });

    expect(upsert).toHaveBeenCalledTimes(3);
    expect(upsert).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: { workspaceId_companyId_channel_value: { workspaceId: WORKSPACE, companyId: COMPANY, channel: 'email', value: 'info@mueller-pumpen.de' } },
        create: expect.objectContaining({
          emailType: 'role',
          dataClass: 'amber',
          status: 'UNVERIFIED',
          firstSeenAt: seenAt,
          lastSeenAt: seenAt,
        }),
      }),
    );
    expect(upsert).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ create: expect.objectContaining({ dataClass: 'green' }) }),
    );
    expect(upsert).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ create: expect.objectContaining({ dataClass: 'green' }) }),
    );
  });

  it('具名人邮箱被拒绝（公司层只收职能邮箱）', async () => {
    const { tx } = fakeTx();
    await expect(
      upsertCompanyContactChannels(tx, {
        workspaceId: WORKSPACE,
        companyId: COMPANY,
        channels: [{ channel: 'email', value: 'max@a.de', emailType: 'personal', sourceType: 'impressum' }],
      }),
    ).rejects.toThrow('COMPANY_CHANNEL_PERSONAL_EMAIL_REFUSED');
  });

  it('email 缺 emailType、phone 带 emailType、非法电话/表单形状都拒绝', async () => {
    const { tx } = fakeTx();
    const base = { workspaceId: WORKSPACE, companyId: COMPANY };
    await expect(
      upsertCompanyContactChannels(tx, { ...base, channels: [{ channel: 'email', value: 'info@a.de', sourceType: 'impressum' }] }),
    ).rejects.toThrow('COMPANY_CHANNEL_EMAIL_TYPE_REQUIRED');
    await expect(
      upsertCompanyContactChannels(tx, { ...base, channels: [{ channel: 'phone', value: '+49 89 123', emailType: 'role', sourceType: 'impressum' }] }),
    ).rejects.toThrow('COMPANY_CHANNEL_EMAIL_TYPE_UNEXPECTED');
    await expect(
      upsertCompanyContactChannels(tx, { ...base, channels: [{ channel: 'phone', value: 'not-a-phone!', sourceType: 'impressum' }] }),
    ).rejects.toThrow('COMPANY_CHANNEL_PHONE_INVALID');
    await expect(
      upsertCompanyContactChannels(tx, { ...base, channels: [{ channel: 'form_url', value: 'http://a.de/kontakt', sourceType: 'contact_page' }] }),
    ).rejects.toThrow('COMPANY_CHANNEL_FORM_URL_INVALID');
    await expect(
      upsertCompanyContactChannels(tx, { ...base, channels: [{ channel: 'form_url', value: 'https://a.de/kontakt?lang=de', sourceType: 'contact_page' }] }),
    ).rejects.toThrow('COMPANY_CHANNEL_FORM_URL_INVALID');
    await expect(
      upsertCompanyContactChannels(tx, { ...base, channels: [{ channel: 'form_url', value: 'https://a.de/kontakt#form', sourceType: 'contact_page' }] }),
    ).rejects.toThrow('COMPANY_CHANNEL_FORM_URL_INVALID');
  });

  it('sourceUrl 与 DB CHECK 同源校验：http/带空白/超长都拒绝（边界按 DB 的 8–2048）', async () => {
    const { tx } = fakeTx();
    const base = { workspaceId: WORKSPACE, companyId: COMPANY, channels: [] as never[] };
    for (const sourceUrl of [
      'http://a.de/impressum',
      'https://a.de/imp ress',
      `https://a.de/${'x'.repeat(2050)}`,
      `https://a.de/${'x'.repeat(2040)}`, // 总长 2049，恰好越过 DB 上界（旧正则的 2051 洞）
    ]) {
      await expect(
        upsertCompanyContactChannels(tx, {
          ...base,
          channels: [{ channel: 'email', value: 'info@a.de', emailType: 'role', sourceType: 'impressum', sourceUrl }],
        }),
      ).rejects.toThrow('COMPANY_CHANNEL_SOURCE_URL_INVALID');
    }
  });

  it('首尾空白的 sourceUrl 归一后写入（校验与写入同一个值，不给 DB CHECK 留 23514）', async () => {
    const { tx, upsert } = fakeTx();
    await upsertCompanyContactChannels(tx, {
      workspaceId: WORKSPACE,
      companyId: COMPANY,
      channels: [{
        channel: 'email', value: 'info@a.de', emailType: 'role', sourceType: 'impressum',
        sourceUrl: '  https://a.de/impressum  ',
      }],
    });
    const call = upsert.mock.calls[0]![0] as { create: Record<string, unknown>; update: Record<string, unknown> };
    expect(call.create).toMatchObject({ sourceUrl: 'https://a.de/impressum' });
    expect(call.update).toMatchObject({ sourceUrl: 'https://a.de/impressum' });
  });

  it('value 超长（>512）在任何 channel 都拒绝', async () => {
    const { tx } = fakeTx();
    await expect(
      upsertCompanyContactChannels(tx, {
        workspaceId: WORKSPACE,
        companyId: COMPANY,
        channels: [{ channel: 'phone', value: `+49${'0'.repeat(520)}`, sourceType: 'impressum' }],
      }),
    ).rejects.toThrow('COMPANY_CHANNEL_VALUE_TOO_LONG');
  });

  it('重复观测只推进 last_seen 与来源留痕，不改状态', async () => {
    const { tx, upsert } = fakeTx();
    await upsertCompanyContactChannels(tx, {
      workspaceId: WORKSPACE,
      companyId: COMPANY,
      channels: [{ channel: 'email', value: 'kontakt@a.de', emailType: 'role', sourceType: 'impressum', sourceUrl: 'https://a.de/impressum' }],
    });
    const call = upsert.mock.calls[0]![0] as { update: Record<string, unknown> };
    expect(call.update).toMatchObject({ sourceUrl: 'https://a.de/impressum' });
    expect(call.update).not.toHaveProperty('status');
    expect(call.update).not.toHaveProperty('firstSeenAt');
  });
});
