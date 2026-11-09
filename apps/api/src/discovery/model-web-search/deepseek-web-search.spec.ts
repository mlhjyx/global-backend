import { describe, expect, it, vi } from 'vitest';
import type { ToolBroker } from '../../tools/tool-broker';
import { brokerBackedDeepSeekWebSearch } from './deepseek-web-search';

type Invoke = Pick<ToolBroker, 'invoke'>['invoke'];

function brokerWith(invoke: Invoke): Pick<ToolBroker, 'invoke'> {
  return { invoke };
}

describe('DeepSeek model web search executor', () => {
  it('invokes deepseek.search through the broker and maps durable hits', async () => {
    const invoke = vi.fn(async () => ({
      data: {
        results: [
          { url: 'https://pumpen-schmid.example/', title: 'Pumpen Schmid GmbH' },
          { url: 'https://ohne-titel.example/' },
          { url: '' },
          { title: 'kein url' },
        ],
      },
      costCents: 1,
    }));
    const search = brokerBackedDeepSeekWebSearch(
      brokerWith(invoke as unknown as Invoke),
    );

    const hits = await search('Industriepumpen Händler', {
      workspaceId: 'ws-1',
      correlationId: 'corr-1',
    });

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith(
      'deepseek.search',
      { query: 'Industriepumpen Händler' },
      { workspaceId: 'ws-1', correlationId: 'corr-1' },
    );
    expect(hits).toEqual([
      { url: 'https://pumpen-schmid.example/', title: 'Pumpen Schmid GmbH' },
      { url: 'https://ohne-titel.example/' },
    ]);
  });

  it('omits correlationId when absent and tolerates an empty payload', async () => {
    const invoke = vi.fn(async () => ({ data: undefined, costCents: 0 }));
    const search = brokerBackedDeepSeekWebSearch(
      brokerWith(invoke as unknown as Invoke),
    );

    await expect(search('Pumpen', { workspaceId: 'ws-2' })).resolves.toEqual([]);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith(
      'deepseek.search',
      { query: 'Pumpen' },
      { workspaceId: 'ws-2' },
    );
  });

  it('propagates broker policy denials unchanged', async () => {
    const invoke = vi.fn(async () => {
      throw new Error('ToolPolicyDenied: deepseek.search budget exceeded');
    });
    const search = brokerBackedDeepSeekWebSearch(
      brokerWith(invoke as unknown as Invoke),
    );

    await expect(search('Pumpen', { workspaceId: 'ws-3' })).rejects.toThrow(
      'ToolPolicyDenied',
    );
  });
});
