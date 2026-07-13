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

describe('person-name · 身份归一不塌真实姓名里的学位同形 token（#54 P2）', () => {
  it('姓氏 Ma/Ba 等学位同形词保留 → 不同人不塌成同一归一名', () => {
    // 'ma'/'ba' 在 HONORIFICS 里（M.A./B.A.），但也是真实姓氏（Chinese/西语）——身份路径不得剥
    expect(normalizePersonName('Anna Ma')).not.toBe(normalizePersonName('Anna Ba'));
    expect(normalizePersonName('Anna Ma')).not.toBe(normalizePersonName('Anna'));
    expect(normalizePersonName('Anna Ma')).toBe('anna ma');
  });

  it('明确称谓/学位仍剥离（Dr./Prof./多段 Dipl.-Ing. 串）', () => {
    expect(normalizePersonName('Dr. Anna Weber')).toBe('anna weber');
    expect(normalizePersonName('Dr. Anna Weber')).toBe(normalizePersonName('Anna Weber'));
    expect(normalizePersonName('Dipl.-Ing. Klaus Weber')).toBe('klaus weber');
  });

  it('空格分写的学术称谓串剥离（Dr. med./Dr. rer. nat./Dipl. Ing.）→ 匹配无称谓名（#77 P2）', () => {
    expect(normalizePersonName('Dr. med. Anna Weber')).toBe('anna weber');
    expect(normalizePersonName('Dr. med. Anna Weber')).toBe(normalizePersonName('Anna Weber'));
    expect(normalizePersonName('Dr. rer. nat. Anna Weber')).toBe('anna weber');
    expect(normalizePersonName('Dipl. Ing. Klaus Weber')).toBe('klaus weber');
  });

  it('学术后缀同形词仅在紧跟称谓时剥；前置/末位姓氏不剥（Ma Yun / Dr. Ma / Erik Ing）', () => {
    expect(normalizePersonName('Ma Yun')).toBe('ma yun'); // 前置姓氏 Ma 不剥
    expect(normalizePersonName('Dr. Ma')).toBe('ma'); // Dr. 后的 Ma（非后缀集）保留为姓
    expect(normalizePersonName('Erik Ing')).toBe('erik ing'); // 末位 Ing 非紧跟称谓 → 保留
  });
});

describe('person-name · 身份归一保留非拉丁 token（#54 P2）', () => {
  it('CJK 姓保留 → 张 Wei ≠ 李 Wei（不塌成 wei）', () => {
    expect(normalizePersonName('张 Wei')).not.toBe(normalizePersonName('李 Wei'));
    expect(normalizePersonName('张 Wei')).toBe('张 wei');
  });

  it('西里尔 token 保留、拉丁重音仍德语音译（Müller→mueller）', () => {
    expect(normalizePersonName('Müller')).toBe('mueller');
    expect(normalizePersonName('Владимир Putin')).toBe('владимир putin');
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
