import { createHash } from 'node:crypto';
import {
  searchKonepsContractBuyers,
  type KonepsContractBuyer,
} from '../adapters/koneps-contracts';
import {
  assertToolExternalActionAuthorized,
  type Tool,
  type ToolContext,
} from './tool-contract';

export interface KonepsContractSearchInput {
  organizationName: string;
  productName: string;
  fromDate: string;
  toDate: string;
  page: number;
  limit: number;
}

export interface KonepsContractSearchOutput {
  buyers: KonepsContractBuyer[];
  nextCursor?: string;
  total?: number;
}

function beforeExternalRequest(ctx: ToolContext): (() => Promise<void>) | undefined {
  if (!ctx.authorizeExternalAction && !ctx.reauthorizeSourcePolicy && !ctx.reauthorizeProviderStatus) return undefined;
  return async () => {
    await ctx.reauthorizeProviderStatus?.();
    await ctx.reauthorizeSourcePolicy?.();
    await assertToolExternalActionAuthorized(ctx);
  };
}

const idempotencyKey = (input: KonepsContractSearchInput): string =>
  `koneps.contract-buyers.search:${createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 24)}`;

export const konepsContractBuyerSearchTool: Tool<KonepsContractSearchInput, KonepsContractSearchOutput> = {
  id: 'koneps.contract-buyers.search',
  version: '1.0.0',
  category: 'structured_source',
  sourceClass: 'public_intelligence',
  cost: { unit: 'call', estimatedCents: 0, external: true },
  rateLimit: { rps: 0.2, concurrency: 1 },
  compliance: {
    sourcePolicy: 'required',
    policyDomain: 'apis.data.go.kr',
    providerKey: 'koneps',
    requiresExplicitPurpose: true,
    respectsRobots: false,
    personalData: true,
    allowedPurpose: ['discovery'],
    reversible: true,
    authRequired: true,
    risk: 'low',
  },
  capabilities: { produces: ['company'], accepts: ['keywords'] },
  idempotencyKey,
  healthCheck: async () => ({
    healthy: Boolean(process.env.KONEPS_SERVICE_KEY?.trim()),
    detail: process.env.KONEPS_SERVICE_KEY?.trim() ? 'service-key-configured-not-live-verified' : 'service-key-missing',
  }),
  execute: async (input, ctx) => {
    const serviceKey = process.env.KONEPS_SERVICE_KEY?.trim();
    if (!serviceKey) throw new Error('KONEPS_SERVICE_KEY_REQUIRED');
    const page = await searchKonepsContractBuyers(input, serviceKey, beforeExternalRequest(ctx));
    return {
      data: {
        buyers: page.records,
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        ...(page.total === undefined ? {} : { total: page.total }),
      },
      costCents: 0,
      provenance: page.provenance,
    };
  },
};
