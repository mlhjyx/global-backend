import { createHash } from 'node:crypto';
import { searchEuEcolabelProducts, type EuEcolabelProduct } from '../adapters/eu-ecolabel';
import {
  assertToolExternalActionAuthorized,
  type Tool,
  type ToolContext,
} from './tool-contract';

export interface EuEcolabelProductsSearchInput {
  organizationName: string;
  country: string;
  offset: number;
  limit: number;
}

export interface EuEcolabelProductsSearchOutput {
  products: EuEcolabelProduct[];
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

const idempotencyKey = (input: EuEcolabelProductsSearchInput): string =>
  `ec-env-data.ecolabel-products.search:${createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 24)}`;

export const euEcolabelProductsSearchTool: Tool<EuEcolabelProductsSearchInput, EuEcolabelProductsSearchOutput> = {
  id: 'ec-env-data.ecolabel-products.search',
  version: '1.0.0',
  category: 'structured_source',
  sourceClass: 'public_intelligence',
  cost: { unit: 'call', estimatedCents: 0, external: true },
  rateLimit: { rps: 0.5, concurrency: 1 },
  compliance: {
    sourcePolicy: 'required',
    policyDomain: 'apps.data.env.service.ec.europa.eu',
    providerKey: 'eu_ecolabel',
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
  healthCheck: async () => ({ healthy: true, detail: 'ec-env-data-ecolabel-products-v2-organization-only' }),
  execute: async (input, ctx) => {
    const page = await searchEuEcolabelProducts(input, beforeExternalRequest(ctx));
    return {
      data: { products: page.records, nextCursor: page.nextCursor },
      costCents: 0,
      provenance: page.provenance,
    };
  },
};
