import { describe, expect, it, vi } from 'vitest';

const run = vi.hoisted(() => ({ executeStructuredTaskWithRuntime: vi.fn() }));
vi.mock('../../model-runtime/structured-task-runtime-bridge', () => run);

import {
  cleanPersonName,
  extractPeopleFromPage,
  looksLikeOrganizationName,
} from './contact-extraction';

describe('contact extraction person-name hygiene (M5 guards)', () => {
  it('drops organisation-shaped names and strips parenthetical annotations', async () => {
    run.executeStructuredTaskWithRuntime.mockResolvedValue({
      data: {
        people: [
          { full_name: 'BTS Engineering Consultants (Projects, Training)' },
          { full_name: 'Muster AG' },
          { full_name: 'Pumpen Schmid Holding' },
          { full_name: 'Max Mustermann (Geschäftsführer)' },
          { full_name: 'Jose Co' },
        ],
      },
    });

    const people = await extractPeopleFromPage(
      {} as never,
      undefined,
      { url: 'https://example.org/impressum', text: 't', label: 'Impressum' } as never,
      {} as never,
    );

    expect(people.map((person) => person.full_name)).toEqual(['Max Mustermann', 'Jose Co']);
  });

  it('recognises the expanded organisation token set without hurting surnames', () => {
    expect(looksLikeOrganizationName('Müller Group')).toBe(true);
    expect(looksLikeOrganizationName('Schmid Holding')).toBe(true);
    expect(looksLikeOrganizationName('Pumpen Schmid International')).toBe(true);
    expect(looksLikeOrganizationName('Muster AG')).toBe(true);
    expect(looksLikeOrganizationName('Ingenieurbüro Co. KG')).toBe(true);
    expect(looksLikeOrganizationName('Jose Co')).toBe(false);
    expect(looksLikeOrganizationName('Max Mustermann')).toBe(false);
  });

  it('strips parentheticals but keeps a person, and drops org-shaped remainders', () => {
    expect(cleanPersonName('Max Mustermann (MBA)')).toBe('Max Mustermann');
    expect(cleanPersonName('Max Mustermann (Geschäftsführer)')).toBe('Max Mustermann');
    expect(cleanPersonName('Pumpen Schmid GmbH (Impressum)')).toBeNull();
    expect(cleanPersonName('Max')).toBeNull();
  });

  it('strips leading German academic titles so stored names and dedupe keys converge (M5 round 3)', () => {
    expect(cleanPersonName('Dipl.-Wirt.-Ing. Marek Havlicek')).toBe('Marek Havlicek');
    expect(cleanPersonName('Dr. Max Mustermann')).toBe('Max Mustermann');
    expect(cleanPersonName('Ing. Klaus Weber')).toBe('Klaus Weber');
    // 真实姓名 token 不误伤（位置感知：非首位不剥，单 token 学位同形词不剥）。
    expect(cleanPersonName('Anna Wirt')).toBe('Anna Wirt');
    expect(cleanPersonName('Erik Ing')).toBe('Erik Ing');
  });
});
