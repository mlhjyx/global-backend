import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it, vi } from 'vitest';
import { DiscoverContactsDto, DiscoveryController } from './discovery.controller';
import type { DiscoveryService } from './discovery.service';
import type { RequestContext } from '../auth/request-context';

/**
 * 端点单测（选项 B · P0.4，组件 A）：GuessEmailsDto → guessEmailsForCompany 入参透传。
 * service 零改动（mock 之），只验证 controller 组装 lawfulBasis {basis,ref,note} 且透传
 * allowPersonalWithoutBasis/maxContacts/maxProbe；无 body 时 lawfulBasis=undefined（诚实不探）。
 */

const CTX: RequestContext = { userId: 'u1', workspaceId: 'ws1', roles: ['admin'] };

describe('DiscoveryController.guessEmails — DTO → service 入参透传', () => {
  it('requires and forwards an auditable lawful basis for contact discovery', async () => {
    const discoverContacts = vi.fn().mockResolvedValue({ ok: true });
    const controller = new DiscoveryController({ discoverContacts } as unknown as DiscoveryService);

    await controller.discoverContacts(CTX, 'company-1', {
      lawfulBasis: 'legitimate_interest',
      lawfulBasisRef: 'LIA-42',
      lawfulBasisNote: 'decision-maker research',
    }, 'grant');

    expect(discoverContacts).toHaveBeenCalledWith(
      CTX,
      'company-1',
      {
        lawfulBasis: {
          basis: 'legitimate_interest',
          ref: 'LIA-42',
          note: 'decision-maker research',
        },
      },
      'grant',
    );
  });

  it('组装 lawfulBasis {basis,ref,note} + 透传 allowPersonalWithoutBasis/maxContacts/maxProbe', async () => {
    const guessEmailsForCompany = vi.fn().mockResolvedValue({ ok: true });
    const controller = new DiscoveryController({ guessEmailsForCompany } as unknown as DiscoveryService);
    await controller.guessEmails(CTX, 'company-1', {
      lawfulBasis: 'legitimate_interest',
      lawfulBasisRef: 'LIA-42',
      lawfulBasisNote: 'note',
      allowPersonalWithoutBasis: true,
      maxContacts: 5,
      maxProbe: 3,
    });
    expect(guessEmailsForCompany).toHaveBeenCalledWith(
      CTX,
      'company-1',
      {
        lawfulBasis: { basis: 'legitimate_interest', ref: 'LIA-42', note: 'note' },
        allowPersonalWithoutBasis: true,
        maxContacts: 5,
        maxProbe: 3,
      },
      undefined,
      {
        lawfulBasis: 'legitimate_interest',
        lawfulBasisRef: 'LIA-42',
        lawfulBasisNote: 'note',
        allowPersonalWithoutBasis: true,
        maxContacts: 5,
        maxProbe: 3,
      },
    );
  });

  it('无 body → lawfulBasis undefined（无基础即门 blocked，诚实不探）；其余透传 undefined', async () => {
    const guessEmailsForCompany = vi.fn().mockResolvedValue({});
    const controller = new DiscoveryController({ guessEmailsForCompany } as unknown as DiscoveryService);
    await controller.guessEmails(CTX, 'company-1', undefined);
    expect(guessEmailsForCompany).toHaveBeenCalledWith(
      CTX,
      'company-1',
      {
        lawfulBasis: undefined,
        allowPersonalWithoutBasis: undefined,
        maxContacts: undefined,
        maxProbe: undefined,
      },
      undefined,
      undefined,
    );
  });

  it('computes Verify authority scope from the public DTO before reshaping it', async () => {
    const verifyContactPoint = vi.fn().mockResolvedValue({ ok: true });
    const controller = new DiscoveryController({ verifyContactPoint } as unknown as DiscoveryService);

    await controller.verify(CTX, 'point-1', {
      lawfulBasis: 'legitimate_interest',
      lawfulBasisRef: 'LIA-42',
      lawfulBasisNote: 'note',
      allowPersonalWithoutBasis: true,
    });

    expect(verifyContactPoint).toHaveBeenCalledWith(
      CTX,
      'point-1',
      {
        lawfulBasis: { basis: 'legitimate_interest', ref: 'LIA-42', note: 'note' },
        allowPersonalWithoutBasis: true,
      },
      undefined,
      {
        lawfulBasis: 'legitimate_interest',
        lawfulBasisRef: 'LIA-42',
        lawfulBasisNote: 'note',
        allowPersonalWithoutBasis: true,
      },
    );
  });
});

describe('DiscoverContactsDto 合规校验（M4 契约）', () => {
  // 缺 lawfulBasis 不能在这里变成 400：必须以 CONTACT_DISCOVERY_LAWFUL_BASIS_REQUIRED（403）
  // 由服务层在消耗预算前拒绝，与 OpenAPI 与 @ApiExecutionBudgetGrant 的声明一致。
  it('empty body passes validation so the service can answer 403', async () => {
    const errors = await validate(plainToInstance(DiscoverContactsDto, {}));
    expect(errors).toEqual([]);
  });

  it('still rejects an unknown lawfulBasis value', async () => {
    const errors = await validate(
      plainToInstance(DiscoverContactsDto, { lawfulBasis: 'made_up' }),
    );
    expect(errors.map((error) => error.property)).toContain('lawfulBasis');
  });
});
