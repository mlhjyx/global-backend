import { describe, expect, it } from 'vitest';
import { tedSearchTool } from './source-tools';

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
});
