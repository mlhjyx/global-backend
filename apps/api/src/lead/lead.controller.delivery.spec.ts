import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { describe, expect, it, vi } from 'vitest';
import { REQUIRED_SCOPES_METADATA } from '../auth/require-scopes.decorator';
import { LeadController } from './lead.controller';

/**
 * 交付闭环的三条新路由（设计 §2/§4/§6）：
 *  - GET  /leads/:id/package   只读交付读模型，只要 acquisition:read（不含个人数据 scope）；
 *  - POST /leads/:id/outcomes  客户/运营回写，acquisition:review；
 *  - reject 的 reasonCode 原样转给服务层校验。
 */
const ctx = { workspaceId: 'ws-1', userId: 'user-1', roles: [], scopes: [] } as never;

describe('LeadController — delivery loop routes', () => {
  it('serves the read model with acquisition:read only', () => {
    const handler = LeadController.prototype.leadPackage;
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.GET);
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('leads/:leadId/package');
    expect(Reflect.getMetadata(REQUIRED_SCOPES_METADATA, handler)).toEqual(['acquisition:read']);
  });

  it('serves the outcome write-back with acquisition:review', async () => {
    const handler = LeadController.prototype.recordOutcome;
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('leads/:leadId/outcomes');
    expect(Reflect.getMetadata(REQUIRED_SCOPES_METADATA, handler)).toEqual(['acquisition:review']);

    const recordOutcome = vi.fn(async () => ({ id: 'outcome-1' }));
    const controller = new LeadController({ recordOutcome } as never);
    const body = await controller.recordOutcome(ctx, 'lead-1', { relevance: 4, source: 'customer' } as never);
    expect(recordOutcome).toHaveBeenCalledWith(ctx, 'lead-1', { relevance: 4, source: 'customer' });
    expect(body).toEqual({ data: { id: 'outcome-1' } });
  });

  it('serves the package through the read model', async () => {
    const leadPackage = vi.fn(async () => ({ lead_id: 'lead-1' }));
    const controller = new LeadController({ leadPackage } as never);
    expect(await controller.leadPackage(ctx, 'lead-1')).toEqual({ data: { lead_id: 'lead-1' } });
    expect(leadPackage).toHaveBeenCalledWith(ctx, 'lead-1');
  });

  it('forwards reasonCode on reject', async () => {
    const decide = vi.fn(async () => ({ id: 'lead-1' }));
    const controller = new LeadController({ decide } as never);
    await controller.reject(ctx, 'lead-1', { reason: 'kein Import', reasonCode: 'NOT_TARGET_ROLE' } as never);
    expect(decide).toHaveBeenCalledWith(ctx, 'lead-1', 'reject', 'kein Import', 'NOT_TARGET_ROLE');
  });
});
