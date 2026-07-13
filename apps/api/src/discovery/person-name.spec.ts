import { describe, expect, it } from 'vitest';
import { normalizePersonName, parsePersonName, personNameKeyVariants } from './person-name';

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

describe('person-name · personNameKeyVariants（Art.17 禁联/对账多变体键，方向偏 over-suppress）', () => {
  /** 两名字的变体集是否有交集（= 禁联/对账会视为同一自然人）。 */
  const sharesKey = (a: string, b: string): boolean => {
    const bs = new Set(personNameKeyVariants(b));
    return personNameKeyVariants(a).some((k) => bs.has(k));
  };

  it('变音名产出「德语音译(ä→ae)」+「纯去音标(ä→a)」两归一形（去重、稳定排序）', () => {
    expect(personNameKeyVariants('Petra Wiedergänger')).toEqual(['petra wiedergaenger', 'petra wiederganger']);
  });

  it('德语音译变体 = normalizePersonName（单值形恒在集合内，保持与 declined 键一致）', () => {
    expect(personNameKeyVariants('Petra Wiedergänger')).toContain(normalizePersonName('Petra Wiedergänger'));
  });

  it('🔴 变音丢弃 / 分解 Unicode / "Surname, Given" 语序 三变体都与原名共享键（本 PR 核心盲区闭合）', () => {
    const canonical = 'Petra Wiedergänger'; // 预合成 ä
    const decomposed = 'Petra Wiedergänger'; // a + U+0308 组合变音（分解形）
    expect(decomposed).not.toBe(canonical); // 前提：确为分解形，逐码不同
    expect(sharesKey(canonical, 'Petra Wiederganger')).toBe(true); // 变音丢弃（ä→a）
    expect(sharesKey(canonical, decomposed)).toBe(true); // 分解形（NFC 先归）
    expect(sharesKey(canonical, 'Wiedergänger, Petra')).toBe(true); // "Surname, Given" 逗号语序
    // 且三者互相之间也都共享（同一自然人）
    expect(sharesKey('Petra Wiederganger', 'Wiedergänger, Petra')).toBe(true);
  });

  it('🔴 变音锚定的德语 ASCII 拼写：Müller 与 Mueller、Muller 都共享键（跨源拼写收敛）', () => {
    expect(sharesKey('Hans Müller', 'Hans Mueller')).toBe(true); // ü→ue
    expect(sharesKey('Hans Müller', 'Hans Muller')).toBe(true); // ü→u（去音标）
  });

  it('称谓剥离：Dr./Prof. 变体与无称谓同名共享键', () => {
    expect(sharesKey('Dr. Anna Weber', 'Anna Weber')).toBe(true);
    expect(sharesKey('Prof. Dr. Anna Weber', 'weber, anna')).toBe(true);
  });

  it('🔴 不同自然人绝不共享键（不误禁无关的人）', () => {
    expect(sharesKey('Anna Weber', 'Bob Jones')).toBe(false);
    expect(sharesKey('Petra Wiedergänger', 'Petra Neumann')).toBe(false);
  });

  it('🔴 CJK 不塌成一形（保 Unicode 字母，不同人不误并）', () => {
    expect(personNameKeyVariants('张伟')).toEqual(['张伟']);
    expect(sharesKey('张伟', '李伟')).toBe(false);
  });

  it('确定性：同输入 → 同数组（幂等基石）', () => {
    expect(personNameKeyVariants('Petra Wiedergänger')).toEqual(personNameKeyVariants('Petra Wiedergänger'));
  });

  it('空 / 纯称谓 → 空数组（调用方回退明文键）', () => {
    expect(personNameKeyVariants('')).toEqual([]);
    expect(personNameKeyVariants('   ')).toEqual([]);
    expect(personNameKeyVariants('Dr.')).toEqual([]);
  });
});
