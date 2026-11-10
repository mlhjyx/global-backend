import { describe, expect, it } from 'vitest';
import {
  LEGAL_ENTITY_SCHEMES,
  normalizeCountry,
  normalizeLegalValue,
  SCHEME_STRENGTH,
} from './entity-keys';

describe('法人实体标识规范式（W2）', () => {
  it('LEI：大写、去空白、必须是 20 位字母数字', () => {
    expect(normalizeLegalValue('lei', '529900T8BM49AURSDO55')).toBe('529900T8BM49AURSDO55');
    expect(normalizeLegalValue('lei', ' 529900t8bm49aursdo55 ')).toBe('529900T8BM49AURSDO55');
    expect(normalizeLegalValue('lei', '529900 T8BM 49AU RSDO 55')).toBe('529900T8BM49AURSDO55');
    expect(normalizeLegalValue('lei', '529900T8BM49AURSDO5')).toBeNull(); // 19 位
    expect(normalizeLegalValue('lei', '')).toBeNull();
    expect(normalizeLegalValue('lei', 42)).toBeNull();
  });

  it('VAT：国别前缀 + 2..12 位；空格/点/连字符归一', () => {
    expect(normalizeLegalValue('vat', 'de 291 499 156')).toBe('DE291499156');
    expect(normalizeLegalValue('vat', 'DE.291.499.156')).toBe('DE291499156');
    expect(normalizeLegalValue('vat', 'FR 40 303 265 045')).toBe('FR40303265045');
    expect(normalizeLegalValue('vat', '291499156')).toBeNull(); // 缺国别前缀
    expect(normalizeLegalValue('vat', 'D291499156')).toBeNull(); // 1 位国别
  });

  it('HRB：紧凑大写；只接受 HRA/HRB/PR 前缀或纯数字（不臆造前缀）', () => {
    expect(normalizeLegalValue('hrb', 'HRB 12345')).toBe('HRB12345');
    expect(normalizeLegalValue('hrb', 'hrb-12345')).toBe('HRB12345');
    expect(normalizeLegalValue('hrb', 'HRA 4711')).toBe('HRA4711');
    expect(normalizeLegalValue('hrb', '12345')).toBe('12345');
    expect(normalizeLegalValue('hrb', 'HRX 12345')).toBeNull();
    expect(normalizeLegalValue('hrb', '')).toBeNull();
  });

  it('SIREN：9 位数字；14 位 SIRET 取前 9 位（INSEE 口径）', () => {
    expect(normalizeLegalValue('siren', '732 829 320')).toBe('732829320');
    expect(normalizeLegalValue('siren', '73282932000074')).toBe('732829320');
    expect(normalizeLegalValue('siren', '73282932')).toBeNull(); // 8 位
    expect(normalizeLegalValue('siren', 'SIREN732829320')).toBeNull();
  });

  it('CH：8 位大写字母数字且至少含一位数字', () => {
    expect(normalizeLegalValue('ch', 'SC123456')).toBe('SC123456');
    expect(normalizeLegalValue('ch', '12345678')).toBe('12345678');
    expect(normalizeLegalValue('ch', 'sc 123 456')).toBe('SC123456');
    expect(normalizeLegalValue('ch', 'ABCDEFGH')).toBeNull();
    expect(normalizeLegalValue('ch', '1234567')).toBeNull();
  });

  it('KVK / CVR / bolagsverket：8 位 / 8 位 / 10 位数字', () => {
    expect(normalizeLegalValue('kvk', '1234 5678')).toBe('12345678');
    expect(normalizeLegalValue('kvk', '1234567')).toBeNull();
    expect(normalizeLegalValue('cvr', 'DK-12345678')).toBe('12345678');
    expect(normalizeLegalValue('bolagsverket', '556036-0793')).toBe('5560360793');
    expect(normalizeLegalValue('bolagsverket', '556036079')).toBeNull();
  });

  it('other：紧凑大写字母数字 1..64 位', () => {
    expect(normalizeLegalValue('other', ' us-ein 12-3456789 ')).toBe('USEIN123456789');
    expect(normalizeLegalValue('other', '---')).toBeNull();
  });

  it('country：只接受两字母 ISO 码（大写化）', () => {
    expect(normalizeCountry('de')).toBe('DE');
    expect(normalizeCountry(' DE ')).toBe('DE');
    expect(normalizeCountry('DEU')).toBeNull();
    expect(normalizeCountry(1)).toBeNull();
  });

  it('scheme 词表与强度表闭合：hard 只有编号空间唯一的体系，VAT/HRB/other 为 caveat', () => {
    expect(LEGAL_ENTITY_SCHEMES).toEqual([
      'lei',
      'vat',
      'hrb',
      'siren',
      'ch',
      'kvk',
      'cvr',
      'bolagsverket',
      'other',
    ]);
    expect(SCHEME_STRENGTH).toEqual({
      lei: 'hard',
      siren: 'hard',
      ch: 'hard',
      kvk: 'hard',
      cvr: 'hard',
      bolagsverket: 'hard',
      vat: 'caveat',
      hrb: 'caveat',
      other: 'caveat',
    });
  });
});
