import { describe, expect, it, vi } from 'vitest';
import { DiscoveryController } from './discovery.controller';
import type { DiscoveryService } from './discovery.service';
import type { RequestContext } from '../auth/request-context';

/**
 * 端点单测（选项 B · P0.4，组件 A）：GuessEmailsDto → guessEmailsForCompany 入参透传。
 * service 零改动（mock 之），只验证 controller 组装 lawfulBasis {basis,ref,note} 且透传
 * allowPersonalWithoutBasis/maxContacts/maxProbe；无 body 时 lawfulBasis=undefined（诚实不探）。
 */

const CTX: RequestContext = { userId: 'u1', workspaceId: 'ws1', roles: ['admin'] };

describe('DiscoveryController.guessEmails — DTO → service 入参透传', () => {
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
    expect(guessEmailsForCompany).toHaveBeenCalledWith(CTX, 'company-1', {
      lawfulBasis: { basis: 'legitimate_interest', ref: 'LIA-42', note: 'note' },
      allowPersonalWithoutBasis: true,
      maxContacts: 5,
      maxProbe: 3,
    });
  });

  it('无 body → lawfulBasis undefined（无基础即门 blocked，诚实不探）；其余透传 undefined', async () => {
    const guessEmailsForCompany = vi.fn().mockResolvedValue({});
    const controller = new DiscoveryController({ guessEmailsForCompany } as unknown as DiscoveryService);
    await controller.guessEmails(CTX, 'company-1', undefined);
    expect(guessEmailsForCompany).toHaveBeenCalledWith(CTX, 'company-1', {
      lawfulBasis: undefined,
      allowPersonalWithoutBasis: undefined,
      maxContacts: undefined,
      maxProbe: undefined,
    });
  });
});
