import { describe, expect, it } from 'vitest';
import { openFdaSearchTool, samgovSearchTool, tedSearchTool } from './source-tools';
import { projectGenericOperationResult } from './generic-operation-projection';

describe('governed source Tool durable replay', () => {
  it('projects only bounded TED green organization facts', () => {
    const replay = tedSearchTool.durableReplayResult?.({
      data: {
        awards: [{
          publicationNumber: 'notice-1', publicationDate: '2026-08-20+02:00',
          cpvCodes: ['42122430'], buyerNames: ['Buyer GmbH'], buyerCountries: ['DEU'],
          winners: [{ name: 'Pump AG', country: 'DEU', identifier: 'DE123', internetAddress: 'https://pump.example/' }],
        }],
      },
      costCents: 0,
    });
    expect(replay).toEqual(expect.objectContaining({
      data: expect.objectContaining({ awards: expect.any(Array) }),
      costCents: 0,
    }));
    expect(JSON.stringify(replay)).not.toMatch(/email|phone|contact|authorization|token/i);
  });

  it('projects bounded openFDA establishment and clearance facts', () => {
    const replay = openFdaSearchTool.durableReplayResult?.({
      data: {
        establishments: [{
          registrationNumber: 'REG-1', feiNumber: 'FEI-1', name: 'Pump Inc',
          country: 'US', city: 'Boston', stateCode: 'MA', statusCode: '1',
          establishmentTypes: ['Manufacturer'], initialImporter: false,
          productCodes: ['LLZ'], deviceNames: ['Pump'], ownerOperatorNumbers: ['OO-1'],
        }],
        clearances: [{
          kNumber: 'K123', applicant: 'Pump Inc', country: 'US', productCode: 'LLZ',
          decisionDateIso: '2026-08-20T00:00:00.000Z', decisionCode: 'SESE', deviceName: 'Pump',
        }],
      },
      costCents: 0,
    });
    expect(replay?.data.establishments).toHaveLength(1);
    expect(replay?.data.clearances).toHaveLength(1);
    expect(JSON.stringify(replay)).not.toMatch(/email|phone|contact|authorization|token/i);
  });

  it('projects bounded SAM organization and notice facts', () => {
    const replay = samgovSearchTool.durableReplayResult?.({
      data: { notices: [{
        noticeId: 'N-1', title: 'Industrial pump sources sought', department: 'DOD',
        subTier: 'Army', office: 'ACC', postedDateIso: '2026-08-20T00:00:00.000Z',
        naicsCode: '333911', responseDeadlineIso: null, popCountry: 'USA',
        link: 'https://sam.gov/opp/N-1',
      }] },
      costCents: 0,
    });
    expect(replay?.data.notices).toHaveLength(1);
    expect(JSON.stringify(replay)).not.toMatch(/email|phone|contact|authorization|token/i);
  });

  it('keeps maximum governed source projections inside the shared field envelope', () => {
    const fda = openFdaSearchTool.durableReplayResult!({
      data: {
        establishments: Array.from({ length: 250 }, (_, index) => ({
          name: `Firm ${index}`, establishmentTypes: ['Manufacturer'], initialImporter: false,
          productCodes: ['LLZ'], deviceNames: ['Pump'], ownerOperatorNumbers: [`OO-${index}`],
        })),
        clearances: Array.from({ length: 250 }, (_, index) => ({ applicant: `Firm ${index}` })),
      },
      costCents: 0,
    });
    const sam = samgovSearchTool.durableReplayResult!({
      data: { notices: Array.from({ length: 250 }, (_, index) => ({
        noticeId: `N-${index}`, title: 'Pump', department: 'DOD', subTier: 'Army', office: 'ACC',
        postedDateIso: null, naicsCode: '333911', responseDeadlineIso: null,
      })) },
      costCents: 0,
    });
    expect(() => projectGenericOperationResult({
      kind: 'tool', schema: 'tool-result/v1',
      data: { toolId: openFdaSearchTool.id, toolVersion: openFdaSearchTool.version, result: fda },
    })).not.toThrow();
    expect(() => projectGenericOperationResult({
      kind: 'tool', schema: 'tool-result/v1',
      data: { toolId: samgovSearchTool.id, toolVersion: samgovSearchTool.version, result: sam },
    })).not.toThrow();
  });
});
