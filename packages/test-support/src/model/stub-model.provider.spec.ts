import { describe, expect, it } from 'vitest';
import {
  createSchemaFixtureStubModelProvider,
  StubModelProvider,
} from './stub-model.provider';

const context = { workspaceId: 'test-workspace' };

describe('StubModelProvider test fixture', () => {
  it('fails closed unless the test explicitly supplies structured output', async () => {
    const provider = new StubModelProvider();

    await expect(
      provider.generateStructured(
        {
          task: 'taxonomy.normalize',
          prompt: 'test only',
          schema: {
            type: 'object',
            required: ['code'],
            properties: { code: { type: 'string' } },
          },
        },
        context,
      ),
    ).rejects.toThrow('TEST_STUB_STRUCTURED_RESULT_REQUIRED');
  });

  it('returns only the fixture output explicitly injected by the test', async () => {
    const provider = new StubModelProvider({
      generateStructured: (input) => ({ code: `fixture:${input.task}` }),
    });

    await expect(
      provider.generateStructured<{ code: string }>(
        {
          task: 'taxonomy.normalize',
          prompt: 'test only',
          schema: {
            type: 'object',
            required: ['code'],
            properties: { code: { type: 'string' } },
          },
        },
        context,
      ),
    ).resolves.toEqual({
      data: { code: 'fixture:taxonomy.normalize' },
      provider: 'stub',
      model: 'stub-v0',
      usage: { costUsd: 0 },
    });
  });

  it('offers an explicit schema-shaped fixture for verification entrypoints', async () => {
    const provider = createSchemaFixtureStubModelProvider();

    await expect(
      provider.generateStructured(
        {
          task: 'company_understanding.extract_claims',
          prompt: 'test only',
          schema: {
            type: 'object',
            required: ['name', 'claims', 'score', 'verified'],
            properties: {
              name: { type: 'string' },
              claims: { type: 'array', items: { type: 'string' } },
              score: { type: 'number' },
              verified: { type: 'boolean' },
            },
          },
        },
        context,
      ),
    ).resolves.toMatchObject({
      data: { name: 'fixture', claims: [], score: 0, verified: false },
    });
  });
});
