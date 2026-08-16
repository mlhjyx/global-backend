import { describe, expect, it } from 'vitest';
import {
  buildVerifiedCandidateSearchQueries,
  resolveAiCandidateExpansionEnabled,
} from './public-web-ai-candidates';

describe('public_web AI candidate expansion', () => {
  it('is disabled unless explicitly opted in', () => {
    expect(resolveAiCandidateExpansionEnabled(undefined)).toBe(false);
    expect(resolveAiCandidateExpansionEnabled('false')).toBe(false);
    expect(resolveAiCandidateExpansionEnabled('true')).toBe(true);
  });

  it('turns bounded model hypotheses into exact verification searches, never records', () => {
    const queries = buildVerifiedCandidateSearchQueries({
      candidates: [
        { name: '  Acme Pumps GmbH  ', country: 'Germany', domain: 'untrusted.example' },
        { name: 'Acme Pumps GmbH', country: 'Germany' },
        { name: 'Beta\nValves', country: 'France' },
        { name: '', country: 'US' },
        { name: 'x'.repeat(300), country: 'US' },
        { name: 'Gamma', country: 'Italy' },
        { name: 'Delta', country: 'Spain' },
        { name: 'Epsilon', country: 'Poland' },
        { name: 'Zeta', country: 'Sweden' },
      ],
    });

    expect(queries).toEqual([
      '"Acme Pumps GmbH" official company Germany',
      '"Beta Valves" official company France',
      '"Gamma" official company Italy',
      '"Delta" official company Spain',
      '"Epsilon" official company Poland',
    ]);
    expect(JSON.stringify(queries)).not.toContain('untrusted.example');
  });
});
