import { createHash } from 'node:crypto';
import { searchMexicoDenue, type MexicoDenueOrganization } from '../adapters/mexico-denue';
import {
  assertToolExternalActionAuthorized,
  type Tool,
  type ToolContext,
} from './tool-contract';

export interface MexicoDenueSearchInput {
  query: string;
  stateCode: string;
  start: number;
  limit: number;
}

export interface MexicoDenueSearchOutput {
  organizations: MexicoDenueOrganization[];
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

const idempotencyKey = (input: MexicoDenueSearchInput): string =>
  `mexico-denue.search:${createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 24)}`;

export const mexicoDenueSearchTool: Tool<MexicoDenueSearchInput, MexicoDenueSearchOutput> = {
  id: 'mexico-denue.search',
  version: '1.0.0',
  category: 'structured_source',
  sourceClass: 'company_registry',
  cost: { unit: 'call', estimatedCents: 0, external: true },
  rateLimit: { rps: 0.5, concurrency: 1 },
  compliance: {
    sourcePolicy: 'required',
    policyDomain: 'www.inegi.org.mx',
    providerKey: 'mexico_denue',
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
  healthCheck: async () => ({ healthy: true, detail: 'denue-nombre-organization-only' }),
  execute: async (input, ctx) => {
    const page = await searchMexicoDenue(input, beforeExternalRequest(ctx));
    return {
      data: { organizations: page.records, nextCursor: page.nextCursor },
      costCents: 0,
      provenance: page.provenance,
    };
  },
};
