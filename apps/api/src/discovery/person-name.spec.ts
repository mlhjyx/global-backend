import { describe, expect, it } from 'vitest';
import { normalizePersonName, parsePersonName } from './person-name';

describe('person-name · 称谓剥离', () => {
  it('去 Dr./Prof./Herr/Frau', () => {
    expect(parsePersonName('Dr. Johann Schmidt')).toEqual({
      given: 'johann',
      family: 'schmidt',
      normalizedFull: 'johann schmidt',
    });
    expect(normalizePersonName('Prof. Anna Weber')).toBe('anna weber');
    expect(normalizePersonName('Herr Max Müller')).toBe('max mueller'); // Müller
    expect(normalizePersonName('Frau Eva Braun')).toBe('eva braun');
  });

  it('去称谓后与无称谓归一相等（桥接 "Dr. X" ≡ "X"）', () => {
    expect(normalizePersonName('Dr. Johann Schmidt')).toBe(normalizePersonName('Johann Schmidt'));
  });
});

describe('person-name · 贵族/介词前缀归姓', () => {
  it('von/der 归入姓，family 取末段核心、normalizedFull 压平全段', () => {
    expect(parsePersonName('Anna von der Berg')).toEqual({
      given: 'anna',
      family: 'berg',
      normalizedFull: 'anna vonderberg',
    });
  });

  it('van 前缀', () => {
    expect(parsePersonName('Jan van Dijk')).toEqual({
      given: 'jan',
      family: 'dijk',
      normalizedFull: 'jan vandijk',
    });
  });

  it('贵族前缀名 ≠ 无前缀同姓名（宁欠并，不误并）', () => {
    expect(normalizePersonName('Anna von der Berg')).not.toBe(normalizePersonName('Anna Berg'));
  });
});

describe('person-name · "Surname, Given" 语序归位', () => {
  it('逗号语序翻转后与正序归一相等', () => {
    expect(parsePersonName('Schmidt, Johann')).toEqual({
      given: 'johann',
      family: 'schmidt',
      normalizedFull: 'johann schmidt',
    });
    expect(normalizePersonName('Schmidt, Johann')).toBe(normalizePersonName('Johann Schmidt'));
  });

  it('逗号左右缺一侧不翻转', () => {
    expect(normalizePersonName(', Johann')).toBe('johann');
  });
});

describe('person-name · NFC 归一 + 德语去音标', () => {
  it('分解形（NFD）先 NFC 再音译 → 与预合成形一致', () => {
    const decomposed = 'Jörg'; // J o + U+0308 combining diaeresis r g（分解形）
    const precomposed = 'Jörg'; // Jörg（预合成 ö = U+00F6）
    expect(decomposed).not.toBe(precomposed); // 前提：确为分解形，逐码不同
    expect(decomposed.normalize('NFC')).toBe(precomposed);
    expect(normalizePersonName(decomposed)).toBe('joerg');
    expect(normalizePersonName(decomposed)).toBe(normalizePersonName(precomposed));
  });

  it('德语标准音译 ä→ae ö→oe ü→ue ß→ss', () => {
    expect(normalizePersonName('Jörg Müller')).toBe('joerg mueller'); // Jörg Müller
    expect(normalizePersonName('Weiß')).toBe('weiss'); // Weiß
  });
});

describe('person-name · 空 / 单 token 边界', () => {
  it('空 / 纯空白 / 纯称谓 → 全空', () => {
    expect(parsePersonName('')).toEqual({ given: '', family: '', normalizedFull: '' });
    expect(parsePersonName('   ')).toEqual({ given: '', family: '', normalizedFull: '' });
    expect(normalizePersonName('Dr.')).toBe('');
  });

  it('单 token = 只有名', () => {
    expect(parsePersonName('Cher')).toEqual({ given: 'cher', family: '', normalizedFull: 'cher' });
  });
});
