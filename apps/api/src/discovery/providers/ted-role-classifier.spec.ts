import { describe, expect, it } from 'vitest';
import {
  classifyTedAwardWinner,
  classifyTedEntity,
} from './ted-role-classifier';

describe('ted-role-classifier (EU TED award-winner role reversal)', () => {
  it('classifies public municipalities and utilities as contracting_authority', () => {
    const res = classifyTedEntity({
      name: 'Stadtwerke München GmbH',
      relationRole: 'buyer',
      cpvCodes: ['45251000'],
    });
    expect(res).toMatchObject({
      entityRole: 'contracting_authority',
      buyerRole: null,
      isHighIntentBuyer: false,
      excludeAsPeer: false,
      signalType: null,
    });
  });

  it('classifies EPC and construction contractors winning projects as high-intent award_winner buyers (TENDER_AWARDED)', () => {
    const res = classifyTedAwardWinner({
      winnerName: 'Solarbau EPC GmbH',
      cpvCodes: ['45261215'],
      noticeType: 'can-standard',
    });
    expect(res).toMatchObject({
      entityRole: 'award_winner',
      buyerRole: 'epc_contractor',
      isHighIntentBuyer: true,
      excludeAsPeer: false,
      signalType: 'TENDER_AWARDED',
      tedSelfRole: 'buyer',
    });
  });

  it('classifies engineering and system integrators winning installation contracts as system_integrator buyers', () => {
    const res = classifyTedAwardWinner({
      winnerName: 'Rhein-Energie Anlagenbau & Systemintegration GmbH',
      cpvCodes: ['45315100'],
      noticeType: 'can-standard',
    });
    expect(res).toMatchObject({
      entityRole: 'award_winner',
      buyerRole: 'system_integrator',
      isHighIntentBuyer: true,
      excludeAsPeer: false,
      signalType: 'TENDER_AWARDED',
      tedSelfRole: 'buyer',
    });
  });

  it('keeps core-component peer manufacturers excluded as peer_manufacturer (tedSelfRole=winner)', () => {
    const pumpPeer = classifyTedAwardWinner({
      winnerName: 'Pompes Martin SAS',
      cpvCodes: ['42120000'],
      noticeType: 'can-standard',
    });
    expect(pumpPeer).toMatchObject({
      entityRole: 'peer_manufacturer',
      buyerRole: null,
      isHighIntentBuyer: false,
      excludeAsPeer: true,
      signalType: null,
      tedSelfRole: 'winner',
    });

    const explicitPeer = classifyTedAwardWinner({
      winnerName: 'Solarbau Cell Manufacturing GmbH',
      cpvCodes: ['45261215'],
      sellerPeerKeywords: ['cell manufacturing'],
    });
    expect(explicitPeer).toMatchObject({
      entityRole: 'peer_manufacturer',
      excludeAsPeer: true,
      tedSelfRole: 'winner',
    });
  });
});
