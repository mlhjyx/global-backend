import { describe, expect, it } from 'vitest';
import { isoWeekOf, parseIsoWeek } from './iso-week';

describe('ISO week (UTC, Monday start)', () => {
  it('names the week that contains an instant', () => {
    expect(isoWeekOf(new Date('2026-10-14T09:30:00.000Z'))).toBe('2026-W42');
    // Monday 00:00 starts the week; Sunday 23:59 still belongs to the previous one.
    expect(isoWeekOf(new Date('2026-10-12T00:00:00.000Z'))).toBe('2026-W42');
    expect(isoWeekOf(new Date('2026-10-11T23:59:59.999Z'))).toBe('2026-W41');
  });

  it('assigns the days around new year to the ISO year of their Thursday', () => {
    expect(isoWeekOf(new Date('2021-01-03T12:00:00.000Z'))).toBe('2020-W53');
    expect(isoWeekOf(new Date('2025-12-29T00:00:00.000Z'))).toBe('2026-W01');
    expect(isoWeekOf(new Date('2026-12-31T00:00:00.000Z'))).toBe('2026-W53');
    expect(isoWeekOf(new Date('2027-01-04T00:00:00.000Z'))).toBe('2027-W01');
  });

  it('turns a week label into its half-open UTC range', () => {
    expect(parseIsoWeek('2026-W42')).toEqual({
      week: '2026-W42',
      start: new Date('2026-10-12T00:00:00.000Z'),
      end: new Date('2026-10-19T00:00:00.000Z'),
    });
    expect(parseIsoWeek('2026-W01')?.start).toEqual(new Date('2025-12-29T00:00:00.000Z'));
    expect(parseIsoWeek('2026-W53')?.end).toEqual(new Date('2027-01-04T00:00:00.000Z'));
  });

  it('round-trips every week of a 53-week and a 52-week year', () => {
    for (const [year, weeks] of [[2026, 53], [2025, 52]] as const) {
      for (let week = 1; week <= weeks; week += 1) {
        const label = `${year}-W${String(week).padStart(2, '0')}`;
        const range = parseIsoWeek(label);
        expect(range, label).not.toBeNull();
        expect(isoWeekOf(range!.start)).toBe(label);
        expect(isoWeekOf(new Date(range!.end.getTime() - 1))).toBe(label);
      }
    }
  });

  it('rejects labels that are not exactly one existing ISO week', () => {
    for (const value of [
      '',
      '2026-42',
      '2026W42',
      '2026-w42',
      '2026-W4',
      '2026-W042',
      '2026-W00',
      '2025-W53',
      '2026-W54',
      ' 2026-W42',
      '2026-W42 ',
      '0999-W10',
      '2026-W42\n',
    ]) {
      expect(parseIsoWeek(value), JSON.stringify(value)).toBeNull();
    }
  });
});
