import { describe, expect, it, vi } from 'vitest';

vi.mock('../../adapters/robots', () => ({
  isAllowedByRobots: vi.fn(async () => true),
}));

import { DirectoryDiscoveryProvider } from './directory.provider';
import { PublicWebDiscoveryProvider } from './public-web.provider';
import { DecisionMakerContactAdapter } from './decision-maker.provider';
import { GooglePatentsInventorProvider } from './bigquery-patents.provider';
import type { ExecutionBroker, ToolResult } from '../../tools/tool-contract';
import type { GooglePatentsInput, GooglePatentsOutput } from '../../tools/source-tools';

const CTX = { workspaceId: 'ws-1', runId: 'run-1' };

function controlError(): Error & { code: string; cause: { type: string } } {
  return Object.assign(new Error('settlement ack lost'), {
    code: 'BUDGET_OPERATION_REPLAY_UNAVAILABLE',
    cause: { type: 'PAID_OPERATION_UNKNOWN' },
  });
}

function brokerForCompanyDiscovery(): ExecutionBroker {
  return {
    checkSourcePolicy: async () => ({ allowed: true }),
    invoke: vi.fn(async (toolId: string): Promise<ToolResult<unknown>> => {
      if (toolId === 'searxng.search') {
        return {
          data: {
            results: [
              {
                url: 'https://directory.example/members',
                title: 'Members directory',
              },
            ],
          },
          costCents: 0,
        };
      }
      throw controlError();
    }) as unknown as ExecutionBroker['invoke'],
  };
}

describe('discovery providers rethrow execution-control errors', () => {
  it('PublicWebDiscoveryProvider rethrows the artifact subject-binding HOLD from contact crawl catches', async () => {
    const hold = Object.assign(new Error('artifact held before wire'), {
      code: 'GENERIC_OPERATION_ARTIFACT_SUBJECT_BINDING_HOLD',
    });
    const broker: ExecutionBroker = {
      checkSourcePolicy: async () => ({ allowed: true }),
      invoke: vi.fn(async () => { throw hold; }) as unknown as ExecutionBroker['invoke'],
    };
    const provider = new PublicWebDiscoveryProvider({
      gateway: {} as never,
      broker,
    });

    await expect(
      provider.discoverContacts({ name: 'Acme GmbH', domain: 'acme.example' }, CTX),
    ).rejects.toBe(hold);
  });

  it('PublicWebDiscoveryProvider rethrows control errors from crawl catches', async () => {
    const provider = new PublicWebDiscoveryProvider({
      gateway: {} as never,
      broker: brokerForCompanyDiscovery(),
    });

    await expect(
      provider.discoverCompanies({ keywords: ['pump'] }, CTX),
    ).rejects.toMatchObject({ code: 'BUDGET_OPERATION_REPLAY_UNAVAILABLE' });
  });

  it('DirectoryDiscoveryProvider rethrows control errors from listing crawl catches', async () => {
    const provider = new DirectoryDiscoveryProvider({
      gateway: {} as never,
      broker: brokerForCompanyDiscovery(),
    });

    await expect(
      provider.discoverCompanies({ keywords: ['pump'] }, CTX),
    ).rejects.toMatchObject({ code: 'BUDGET_OPERATION_REPLAY_UNAVAILABLE' });
  });

  it('DecisionMakerContactAdapter rethrows control errors from page crawl catches', async () => {
    const broker: ExecutionBroker = {
      checkSourcePolicy: async () => ({ allowed: true }),
      invoke: vi.fn(async (): Promise<ToolResult<unknown>> => {
        throw controlError();
      }) as unknown as ExecutionBroker['invoke'],
    };
    const provider = new DecisionMakerContactAdapter({
      gateway: {} as never,
      broker,
    });

    await expect(
      provider.discoverContacts({ name: 'Acme GmbH', domain: 'acme.example' }, CTX),
    ).rejects.toMatchObject({ code: 'BUDGET_OPERATION_REPLAY_UNAVAILABLE' });
  });

  it('GooglePatentsInventorProvider rethrows control errors from broker invocation', async () => {
    const broker: ExecutionBroker & { invokeMock: ReturnType<typeof vi.fn> } = {
      checkSourcePolicy: async () => ({ allowed: true }),
      invokeMock: vi.fn(async (_toolId: string, _input: GooglePatentsInput): Promise<ToolResult<GooglePatentsOutput>> => {
        throw controlError();
      }),
      invoke: undefined as unknown as ExecutionBroker['invoke'],
    };
    broker.invoke = broker.invokeMock as unknown as ExecutionBroker['invoke'];

    await expect(
      new GooglePatentsInventorProvider({
        broker,
        now: () => Date.UTC(2026, 0, 1),
        mode: 'direct',
      }).discoverContacts({ name: 'Siemens', country: 'DE' }, CTX),
    ).rejects.toMatchObject({ code: 'BUDGET_OPERATION_REPLAY_UNAVAILABLE' });
  });
});
