import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from './tool-registry';

const adapterMocks = vi.hoisted(() => ({
  searchAwardNotices: vi.fn(),
  searchContractNotices: vi.fn(),
  searchRegistrations: vi.fn(),
  search510kClearances: vi.fn(),
}));

vi.mock('../adapters/ted-api', () => ({
  searchAwardNotices: adapterMocks.searchAwardNotices,
  searchContractNotices: adapterMocks.searchContractNotices,
}));

vi.mock('../adapters/openfda-api', () => ({
  searchRegistrations: adapterMocks.searchRegistrations,
  search510kClearances: adapterMocks.search510kClearances,
}));

import { openFdaSearchTool, registerSourceTools, tedSearchTool } from './source-tools';

const authorizeExternalAction = vi.fn().mockResolvedValue(true);
const context = { workspaceId: 'workspace-test', purpose: ['discovery'], authorizeExternalAction };

beforeEach(() => {
  vi.clearAllMocks();
  authorizeExternalAction.mockResolvedValue(true);
  adapterMocks.searchAwardNotices.mockResolvedValue([]);
  adapterMocks.searchContractNotices.mockResolvedValue([]);
  adapterMocks.searchRegistrations.mockResolvedValue([]);
  adapterMocks.search510kClearances.mockResolvedValue([]);
});

describe('ted.search 工具边界', () => {
  it('award 分支原样委托参数并只返回 awards 槽位', async () => {
    const params = { cpvCodes: ['42120000'], buyerCountries: ['DEU'], limit: 2 };
    const awards = [{ publicationNumber: '100-2026', cpvCodes: [], buyerNames: [], buyerCountries: [], winners: [] }];
    adapterMocks.searchAwardNotices.mockResolvedValue(awards);

    await expect(tedSearchTool.execute({ kind: 'award', params }, context)).resolves.toEqual({
      data: { awards },
      costCents: 0,
    });
    expect(adapterMocks.searchAwardNotices).toHaveBeenCalledWith(params, expect.any(Function));
    expect(adapterMocks.searchContractNotices).not.toHaveBeenCalled();
  });

  it('contract 分支原样委托参数并只返回 notices 槽位', async () => {
    const params = { cpvCodes: ['42120000'], scope: 'ACTIVE' as const };
    const notices = [{ publicationNumber: '200-2026', cpvCodes: [], buyerNames: [], buyerCountries: [], deadlines: [] }];
    adapterMocks.searchContractNotices.mockResolvedValue(notices);

    await expect(tedSearchTool.execute({ kind: 'contract', params }, context)).resolves.toEqual({
      data: { notices },
      costCents: 0,
    });
    expect(adapterMocks.searchContractNotices).toHaveBeenCalledWith(params, expect.any(Function));
    expect(adapterMocks.searchAwardNotices).not.toHaveBeenCalled();
  });

  it('运行时未知 kind fail-closed，绝不误路由到 contract', async () => {
    const malformed = { kind: 'unknown', params: { cpvCodes: ['42120000'] } } as never;

    await expect(tedSearchTool.execute(malformed, context)).rejects.toThrow(/ted\.search.*kind/);
    expect(adapterMocks.searchAwardNotices).not.toHaveBeenCalled();
    expect(adapterMocks.searchContractNotices).not.toHaveBeenCalled();
  });

  it('adapter 错误原样向上冒泡，不伪造成功 ToolResult', async () => {
    adapterMocks.searchAwardNotices.mockRejectedValue(new Error('upstream failed'));

    await expect(
      tedSearchTool.execute({ kind: 'award', params: { cpvCodes: ['42120000'] } }, context),
    ).rejects.toThrow('upstream failed');
  });
});

describe('openfda.search 工具边界', () => {
  it('registration 分支原样委托参数并只返回 establishments 槽位', async () => {
    const params = { productCodes: ['LLZ'], importerOnly: true };
    const establishments = [
      {
        name: 'Acme Devices',
        establishmentTypes: [],
        initialImporter: true,
        productCodes: ['LLZ'],
        deviceNames: [],
        ownerOperatorNumbers: [],
      },
    ];
    adapterMocks.searchRegistrations.mockResolvedValue(establishments);

    await expect(openFdaSearchTool.execute({ kind: 'registration', params }, context)).resolves.toEqual({
      data: { establishments },
      costCents: 0,
    });
    expect(adapterMocks.searchRegistrations).toHaveBeenCalledWith(params, expect.any(Function));
    expect(adapterMocks.search510kClearances).not.toHaveBeenCalled();
  });

  it('510k 分支原样委托参数并只返回 clearances 槽位', async () => {
    const params = { productCodes: ['OHT'], clearedOnly: false };
    const clearances = [{ applicant: 'Acme Medical', productCode: 'OHT' }];
    adapterMocks.search510kClearances.mockResolvedValue(clearances);

    await expect(openFdaSearchTool.execute({ kind: '510k', params }, context)).resolves.toEqual({
      data: { clearances },
      costCents: 0,
    });
    expect(adapterMocks.search510kClearances).toHaveBeenCalledWith(params, expect.any(Function));
    expect(adapterMocks.searchRegistrations).not.toHaveBeenCalled();
  });

  it('运行时未知 kind fail-closed，绝不误路由到 510k', async () => {
    const malformed = { kind: 'unknown', params: { productCodes: ['OHT'] } } as never;

    await expect(openFdaSearchTool.execute(malformed, context)).rejects.toThrow(/openfda\.search.*kind/);
    expect(adapterMocks.searchRegistrations).not.toHaveBeenCalled();
    expect(adapterMocks.search510kClearances).not.toHaveBeenCalled();
  });
});

describe('公共 adapter 工具元数据与注册', () => {
  it('幂等键稳定且按分支隔离', () => {
    const award = { kind: 'award' as const, params: { cpvCodes: ['42120000'] } };
    const contract = { kind: 'contract' as const, params: { cpvCodes: ['42120000'] } };

    expect(tedSearchTool.idempotencyKey(award)).toBe(tedSearchTool.idempotencyKey({ ...award }));
    expect(tedSearchTool.idempotencyKey(award)).not.toBe(tedSearchTool.idempotencyKey(contract));
    expect(openFdaSearchTool.compliance).toMatchObject({
      sourcePolicy: 'required',
      policyDomain: 'api.fda.gov',
      personalData: true,
    });
    expect(tedSearchTool.compliance.allowedPurpose).toContain('intent');
  });

  it('registerSourceTools 返回同一 registry 并注册两个公共 adapter 工具', () => {
    const registry = new ToolRegistry();

    expect(registerSourceTools(registry)).toBe(registry);
    expect(registry.get('ted.search')).toBe(tedSearchTool);
    expect(registry.get('openfda.search')).toBe(openFdaSearchTool);
    expect(registry.all().map((tool) => tool.id)).toEqual(expect.arrayContaining(['ted.search', 'openfda.search']));
  });
});
