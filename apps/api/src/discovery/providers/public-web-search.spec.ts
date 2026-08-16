import { describe, expect, it, vi } from 'vitest';
import { ToolPolicyDenied } from '../../tools/tool-broker';
import type { ExecutionBroker, ToolContext } from '../../tools/tool-contract';
import { attachToolFailureCost } from '../../tools/tool-contract';
import {
  invokePublicWebSearch,
  resolvePublicWebSearchBackends,
} from './public-web-search';

const ctx: ToolContext = {
  workspaceId: 'w',
  taskContractId: 'discovery.extract_company',
  purpose: 'discovery',
};

describe('public_web governed search fallback', () => {
  it('defaults to the self-hosted backend only', () => {
    expect(resolvePublicWebSearchBackends(undefined)).toEqual(['searxng.search']);
    expect(resolvePublicWebSearchBackends('')).toEqual(['searxng.search']);
  });

  it('keeps SearXNG first and only admits known explicitly configured backends', () => {
    expect(resolvePublicWebSearchBackends('brave.search,unknown,serper.search,brave.search'))
      .toEqual(['searxng.search', 'brave.search', 'serper.search']);
  });

  it('falls back on ordinary backend failure and returns the first non-empty result set', async () => {
    const invoke = vi.fn(async (toolId: string) => {
      if (toolId === 'searxng.search') throw new Error('self-hosted unavailable');
      if (toolId === 'serper.search') return { data: { results: [] }, costCents: 1 };
      return {
        data: { results: [{ title: 'Acme', url: 'https://acme.example/', content: '', engine: 'brave' }] },
        costCents: 1,
      };
    });

    const result = await invokePublicWebSearch(
      { invoke } as unknown as ExecutionBroker,
      { q: 'industrial pumps', language: 'en' },
      ctx,
      ['searxng.search', 'serper.search', 'brave.search'],
    );

    expect(invoke.mock.calls.map(([toolId]) => toolId)).toEqual([
      'searxng.search', 'serper.search', 'brave.search',
    ]);
    expect(result).toEqual({
      results: [{ title: 'Acme', url: 'https://acme.example/' }],
      costCents: 2,
      usage: [
        { phase: 'search', backend: 'searxng.search', callCount: 1, completedCount: 0, costCents: 0 },
        { phase: 'search', backend: 'serper.search', callCount: 1, completedCount: 1, costCents: 1 },
        { phase: 'search', backend: 'brave.search', callCount: 1, completedCount: 1, costCents: 1 },
      ],
    });
  });

  it('retains the cost of successful empty fallbacks when every backend is empty', async () => {
    const invoke = vi.fn(async (toolId: string) => ({
      data: { results: [] },
      costCents: toolId === 'searxng.search' ? 0 : 1,
    }));

    const result = await invokePublicWebSearch(
      { invoke } as unknown as ExecutionBroker,
      { q: 'industrial pumps', language: 'en' },
      ctx,
      ['searxng.search', 'serper.search', 'brave.search'],
    );

    expect(result).toEqual({
      results: [],
      costCents: 2,
      usage: [
        { phase: 'search', backend: 'searxng.search', callCount: 1, completedCount: 1, costCents: 0 },
        { phase: 'search', backend: 'serper.search', callCount: 1, completedCount: 1, costCents: 1 },
        { phase: 'search', backend: 'brave.search', callCount: 1, completedCount: 1, costCents: 1 },
      ],
    });
    expect(invoke.mock.calls.map(([toolId]) => toolId)).toEqual([
      'searxng.search', 'serper.search', 'brave.search',
    ]);
  });

  it('retains estimated unknown cost when a paid backend fails after its wire starts', async () => {
    const invoke = vi.fn(async (toolId: string) => {
      if (toolId === 'searxng.search') return { data: { results: [] }, costCents: 0 };
      if (toolId === 'serper.search') {
        throw attachToolFailureCost(new Error('invalid payload after wire'), {
          costCents: 1,
          basis: 'estimated_unknown',
        });
      }
      return {
        data: { results: [{ title: 'Acme', url: 'https://acme.example/', content: '', engine: 'brave' }] },
        costCents: 1,
      };
    });

    const result = await invokePublicWebSearch(
      { invoke } as unknown as ExecutionBroker,
      { q: 'industrial pumps' },
      ctx,
      ['searxng.search', 'serper.search', 'brave.search'],
    );

    expect(result.costCents).toBe(2);
    expect(result.usage).toEqual([
      { phase: 'search', backend: 'searxng.search', callCount: 1, completedCount: 1, costCents: 0 },
      { phase: 'search', backend: 'serper.search', callCount: 1, completedCount: 0, costCents: 1 },
      { phase: 'search', backend: 'brave.search', callCount: 1, completedCount: 1, costCents: 1 },
    ]);
  });

  it('does not bypass a Provider/SourcePolicy/suppression denial through another backend', async () => {
    const denial = new ToolPolicyDenied('searxng.search', 'suppression_action_gate');
    const invoke = vi.fn(async () => { throw denial; });

    await expect(invokePublicWebSearch(
      { invoke } as unknown as ExecutionBroker,
      { q: 'industrial pumps' },
      ctx,
      ['searxng.search', 'serper.search', 'brave.search'],
    )).rejects.toBe(denial);
    expect(invoke).toHaveBeenCalledOnce();
  });
});
