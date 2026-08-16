import { createHash } from 'node:crypto';
import {
  searchSbirSttrCompanies,
  type SbirSttrCompany,
} from '../adapters/sbir-sttr-companies';
import {
  assertToolExternalActionAuthorized,
  type Tool,
  type ToolContext,
} from './tool-contract';

export interface SbirSttrCompanySearchInput {
  query: string;
  start: number;
  limit: number;
}

export interface SbirSttrCompanySearchOutput {
  companies: SbirSttrCompany[];
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

const idempotencyKey = (input: SbirSttrCompanySearchInput): string =>
  `sbir-sttr-companies.search:${createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 24)}`;

export const sbirSttrCompanySearchTool: Tool<SbirSttrCompanySearchInput, SbirSttrCompanySearchOutput> = {
  id: 'sbir-sttr-companies.search',
  version: '1.0.0',
  category: 'structured_source',
  sourceClass: 'public_intelligence',
  cost: { unit: 'call', estimatedCents: 0, external: true },
  rateLimit: { rps: 0.5, concurrency: 1 },
  compliance: {
    sourcePolicy: 'required',
    policyDomain: 'api.www.sbir.gov',
    providerKey: 'sbir_sttr_companies',
    requiresExplicitPurpose: true,
    respectsRobots: false,
    personalData: true,
    allowedPurpose: ['discovery'],
    reversible: true,
    authRequired: false,
    risk: 'low',
  },
  capabilities: { produces: ['company'], accepts: ['keywords'] },
  idempotencyKey,
  healthCheck: async () => ({ healthy: true, detail: 'local-contract-only-upstream-maintenance-unverified' }),
  execute: async (input, ctx) => {
    const page = await searchSbirSttrCompanies(input, beforeExternalRequest(ctx));
    return {
      data: { companies: page.records, nextCursor: page.nextCursor },
      costCents: 0,
      provenance: page.provenance,
    };
  },
};
