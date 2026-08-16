import { createHash } from 'node:crypto';
import { searchFmcsaQcmobile, type FmcsaQcmobileCarrier } from '../adapters/fmcsa-qcmobile';
import {
  assertToolExternalActionAuthorized,
  type Tool,
  type ToolContext,
} from './tool-contract';

export interface FmcsaQcmobileSearchInput {
  query: string;
  start: number;
  limit: number;
}

export interface FmcsaQcmobileSearchOutput {
  carriers: FmcsaQcmobileCarrier[];
  nextCursor?: string;
}

function beforeExternalRequest(ctx: ToolContext): (() => Promise<void>) | undefined {
  if (!ctx.authorizeExternalAction && !ctx.reauthorizeSourcePolicy && !ctx.reauthorizeProviderStatus) return undefined;
  return async () => {
    await ctx.reauthorizeProviderStatus?.();
    await ctx.reauthorizeSourcePolicy?.();
    await assertToolExternalActionAuthorized(ctx);
  };
}

const idempotencyKey = (input: FmcsaQcmobileSearchInput): string =>
  `fmcsa-qcmobile.search:${createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 24)}`;

export const fmcsaQcmobileSearchTool: Tool<FmcsaQcmobileSearchInput, FmcsaQcmobileSearchOutput> = {
  id: 'fmcsa-qcmobile.search',
  version: '1.0.0',
  category: 'structured_source',
  sourceClass: 'company_registry',
  cost: { unit: 'call', estimatedCents: 0, external: true },
  rateLimit: { rps: 0.5, concurrency: 1 },
  compliance: {
    sourcePolicy: 'required',
    policyDomain: 'mobile.fmcsa.dot.gov',
    providerKey: 'fmcsa_qcmobile',
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
  healthCheck: async () => ({ healthy: true, detail: 'fmcsa-qcmobile-organization-only' }),
  execute: async (input, ctx) => {
    const page = await searchFmcsaQcmobile(input, beforeExternalRequest(ctx));
    return {
      data: { carriers: page.records, nextCursor: page.nextCursor },
      costCents: 0,
      provenance: page.provenance,
    };
  },
};
