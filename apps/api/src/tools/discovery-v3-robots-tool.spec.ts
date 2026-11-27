import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolvePublicHttpUrl } from '../adapters/url-guard';
import { currentDiscoveryV3OperationScope, withDiscoveryV3OperationScope } from '../discovery/discovery-v3-operation-scope';
import {
  DiscoveryV3OperationStore, type DiscoveryV3ClaimedOperation, type DiscoveryV3WireReceipt,
} from '../discovery/discovery-v3-operations';
import type { DiscoveryV3Dispatch } from '../runtime/discovery-v3-dispatch-contract';
import { crawl4aiFetchTool } from './builtin-tools';
import type { DiscoveryV3ArtifactExecutionPort, PrepareDiscoveryV3ArtifactInput, ReplayDiscoveryV3ArtifactInput } from './discovery-v3-artifact-execution-port';
import { executeDiscoveryV3Tool } from './discovery-v3-tool';
import { projectGenericOperationResult } from './generic-operation-projection';
import { ToolBroker } from './tool-broker';
import type { ToolResult } from './tool-contract';
import { ToolRegistry } from './tool-registry';

vi.mock('../adapters/url-guard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../adapters/url-guard')>()),
  resolvePublicHttpUrl: vi.fn(),
}));

const command: DiscoveryV3Dispatch = {
  executionContractVersion: 3,
  workspaceId: '42c863b9-7c7e-4d28-8678-60ef9a20219b',
  runId: '693de0dc-5474-4d19-9270-83694bfeea09',
  planId: '26bdf359-1954-4838-9d88-7bdf6c46f899',
  icpId: '5254f63d-4423-4e90-8153-2809f2fe0d86',
  attemptId: '5d27c20b-e46d-450a-bf45-9f5bd42296a3',
  requestSha256: '0'.repeat(64), taskQueue: 'batch-discovery', dispatchExpiresAt: '2026-11-27T12:00:00.000Z',
};
const subject = { subjectType: 'company', subjectId: 'cf886db4-cfa3-49a3-9ec0-dfe505d20572' } as const;
const servers: Server[] = [];
const article = `<html><head><title>Fixture</title></head><body><article><h1>Catalog</h1><p>${'Fixture business catalog information. '.repeat(18)}</p></article></body></html>`;

beforeEach(() => {
  vi.stubEnv('HTTP_FIRST_MIN_CHARS', '200');
  vi.mocked(resolvePublicHttpUrl).mockImplementation(async (raw) => ({
    url: new URL(raw), ip: '127.0.0.1', family: 4, addresses: [{ address: '127.0.0.1', family: 4 }],
  }));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.mocked(resolvePublicHttpUrl).mockReset();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  })));
});

async function fixture(options?: { robots?: string; status?: number; location?: string; onRobots?: () => void; tool?: typeof crawl4aiFetchTool }) {
  const events: string[] = [];
  const server = createServer((request, response) => {
    events.push(`wire:${request.url}`);
    if (request.url === '/robots.txt') {
      options?.onRobots?.();
      response.writeHead(options?.status ?? 200, {
        'Content-Type': 'text/plain',
        ...(options?.location ? { Location: options.location } : {}),
      });
      response.end(options?.robots ?? 'User-agent: *\nDisallow: /members\n');
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(article);
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture bind failed');
  const request = { url: `http://fixture-origin.test:${address.port}/catalog` };
  const context = { workspaceId: command.workspaceId, runId: command.runId, artifactSubject: subject, purpose: 'discovery' };
  const receipts = new Map<string, DiscoveryV3WireReceipt>();
  const store = new DiscoveryV3OperationStore({ withWorkspace: async () => { throw new Error('fixture DB access'); } });
  vi.spyOn(store, 'claim').mockImplementation(async (_command, operation) => {
    const operationId = operation.step;
    events.push(`claim:${operation.method}`);
    const row = receipts.get(operationId);
    if (row?.result) return { status: 'REPLAY', operationId, result: row.result, resultSha256: row.result.digest };
    if (row) return { status: row.outcome === 'FAILED' ? 'FAILED' : 'UNKNOWN', operationId };
    return { status: 'CLAIMED', operationId, proof: 'fixture', deadline: new Date(Date.now() + operation.maxDurationMs) } satisfies DiscoveryV3ClaimedOperation;
  });
  vi.spyOn(store, 'authorizeSend').mockImplementation(async (_command, operation) => {
    events.push(`authorize:${operation.method}`);
    return operation.maxDurationMs;
  });
  vi.spyOn(store, 'finish').mockImplementation(async (_command, operation, claim, receipt) => {
    events.push(`receipt:${operation.method}`);
    receipts.set(claim.operationId, receipt);
  });
  const port: DiscoveryV3ArtifactExecutionPort = {
    admit: async () => ({ status: 'BOUND', subjectRef: subject }),
    async prepare<I, O>(input: PrepareDiscoveryV3ArtifactInput<I, O>) {
      return {
        projection: projectGenericOperationResult({ kind: 'tool', schema: 'crawl4ai-fetch/v1', data: input.result }),
        async commit() {}, async cleanup() {},
        async readResult() { return input.result; },
      };
    },
    async replay<I, O>(input: ReplayDiscoveryV3ArtifactInput<I, O>) { return input.projection.data as ToolResult<O>; },
  };
  const auth = { source: vi.fn(async () => { events.push('source'); }), subject: vi.fn(async () => { events.push('subject'); }) };
  function run() {
    return withDiscoveryV3OperationScope({ command, step: 'query/0/fixture', store, signal: new AbortController().signal },
      () => executeDiscoveryV3Tool({
        scope: currentDiscoveryV3OperationScope(context)!, context, request, tool: options?.tool ?? crawl4aiFetchTool, timeoutMs: 15_000,
        artifact: { port, subjectRef: subject, schema: 'crawl4ai-fetch/v1' },
        authorizeSource: auth.source, authorizeSubject: auth.subject,
        project: () => { throw new Error('fixture should use artifact storage'); }, restore: () => null,
      }));
  }
  return { run, auth, events, receipts, wires: () => events.filter((event) => event.startsWith('wire:')) };
}

describe('durable native crawl robots preflight', () => {
  it('claims and rechecks policy for each actual wire and reuses both results on replay', async () => {
    const page = await fixture();
    expect((await page.run()).data.text).toContain('Fixture business catalog');
    expect(page.wires()).toEqual(['wire:/robots.txt', 'wire:/catalog']);
    expect(resolvePublicHttpUrl).toHaveBeenCalledTimes(2);
    for (const method of ['robots', 'invoke']) {
      const beforeAuthorization = page.events.indexOf(`authorize:${method}`);
      expect(page.events.slice(beforeAuthorization - 2, beforeAuthorization + 2)).toEqual([
        'source', 'subject', `authorize:${method}`, method === 'robots' ? 'wire:/robots.txt' : 'wire:/catalog',
      ]);
    }
    expect(page.receipts.get('query/0/fixture/tool/1/robots')?.result).toMatchObject({
      kind: 'tool', schema: 'discovery-v3-robots/v1', data: { allowed: true },
    });
    expect((await page.run()).data.text).toContain('Fixture business catalog');
    expect(page.wires()).toEqual(['wire:/robots.txt', 'wire:/catalog']);
    // The page preflight still validates DNS; replaying the robots decision has no new DNS lookup.
    expect(resolvePublicHttpUrl).toHaveBeenCalledTimes(3);
  });

  it('replays a closed denial proof without reading either URL again', async () => {
    const page = await fixture({ robots: 'User-agent: *\nDisallow: /cat*\n' });
    expect(await page.run()).toMatchObject({ degraded: true, data: { text: '' } });
    expect(page.receipts.get('query/0/fixture/tool/1/robots')?.result?.data).toEqual({ allowed: false });
    expect(await page.run()).toMatchObject({ degraded: true });
    expect(page.wires()).toEqual(['wire:/robots.txt']);
  });

  it('records an unknown robots response and blocks the target on every retry', async () => {
    const page = await fixture({ status: 503 });
    await expect(page.run()).rejects.toThrow('DISCOVERY_V3_ROBOTS_RESPONSE_UNRESOLVED');
    expect(page.receipts.get('query/0/fixture/tool/1/robots')?.outcome).toBe('UNKNOWN');
    await expect(page.run()).rejects.toThrow('DISCOVERY_V3_OPERATION_UNRESOLVED');
    expect(page.wires()).toEqual(['wire:/robots.txt']);
  });

  it('never follows robots redirects or reaches the page after a redirect', async () => {
    const page = await fixture({ status: 302, location: '/second-robots.txt' });
    await expect(page.run()).rejects.toMatchObject({ code: 'too_many_redirects' });
    expect(page.receipts.get('query/0/fixture/tool/1/robots')?.outcome).toBe('UNKNOWN');
    expect(page.wires()).toEqual(['wire:/robots.txt']);
  });

  it('does not send the page after the subject is revoked following robots', async () => {
    let revoked = false;
    const page = await fixture({ onRobots: () => { revoked = true; } });
    page.auth.subject.mockImplementation(async () => {
      if (revoked) throw new Error('fixture subject revoked');
    });
    await expect(page.run()).rejects.toThrow('fixture subject revoked');
    expect(page.wires()).toEqual(['wire:/robots.txt']);
    expect(page.events).not.toContain('claim:invoke');
  });

  it('refuses a robots decision for any target other than the tool request', async () => {
    const prepare = vi.fn(async () => async () => true);
    const page = await fixture({ tool: {
      ...crawl4aiFetchTool,
      async executeDiscoveryV3(input, context) {
        await context.checkDiscoveryV3Robots!(`${input.url}/other`, prepare);
        throw new Error('unexpected approval');
      },
    } });
    await expect(page.run()).rejects.toThrow('DISCOVERY_V3_OPERATION_BINDING_MISMATCH');
    expect(prepare).not.toHaveBeenCalled();
    expect(page.wires()).toEqual([]);
  });

  it('rejects a caller supplying its own robots fence', async () => {
    const registry = new ToolRegistry();
    registry.register(crawl4aiFetchTool);
    const broker = new ToolBroker({ registry });
    await expect(broker.invoke(crawl4aiFetchTool.id, { url: 'https://fixture.invalid/catalog' }, {
      workspaceId: command.workspaceId, runId: command.runId,
      checkDiscoveryV3Robots: async () => true,
    })).rejects.toThrow('DISCOVERY_V3_CALLER_FENCE_DENIED');
  });
});
