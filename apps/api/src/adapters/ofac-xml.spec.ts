import { describe, expect, it } from 'vitest';
import { parseOfacXml } from './ofac-xml';

/**
 * OFAC SDN/Consolidated XML 解析（Phase 1 仅公司/实体）。
 * 🔴 核心红线断言：**结构性剔除 Individual/Vessel/Aircraft**——person PII 绝不物化成记录。
 * 结构据 2026-07-14 一手拉取的 SDN.XML（sdnEntry/sdnType/akaList category=strong|weak）。
 */

const FIXTURE = `<?xml version="1.0" standalone="yes"?>
<sdnList xmlns="https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/XML">
  <publshInformation>
    <Publish_Date>07/13/2026</Publish_Date>
    <Record_Count>4</Record_Count>
  </publshInformation>
  <sdnEntry>
    <uid>36</uid>
    <lastName>AEROCARIBBEAN AIRLINES</lastName>
    <sdnType>Entity</sdnType>
    <programList><program>CUBA</program></programList>
    <akaList>
      <aka><uid>12</uid><type>a.k.a.</type><category>strong</category><lastName>AERO-CARIBBEAN</lastName></aka>
      <aka><uid>13</uid><type>a.k.a.</type><category>weak</category><lastName>ACN</lastName></aka>
    </akaList>
    <addressList>
      <address><uid>25</uid><city>Havana</city><country>Cuba</country></address>
    </addressList>
  </sdnEntry>
  <sdnEntry>
    <uid>7157</uid>
    <firstName>Ali</firstName>
    <lastName>SANCTIONED PERSON</lastName>
    <sdnType>Individual</sdnType>
    <programList><program>SDGT</program></programList>
  </sdnEntry>
  <sdnEntry>
    <uid>9000</uid>
    <lastName>GLOBAL TRADING LLC</lastName>
    <sdnType>Entity</sdnType>
    <programList><program>IRAN</program><program>SDGT</program></programList>
  </sdnEntry>
  <sdnEntry>
    <uid>5500</uid>
    <lastName>THE VESSEL</lastName>
    <sdnType>Vessel</sdnType>
    <programList><program>NPWMD</program></programList>
  </sdnEntry>
</sdnList>`;

describe('parseOfacXml（Phase 1 仅公司/实体）', () => {
  const parsed = parseOfacXml(FIXTURE);

  it('🔴 只保留 Entity——Individual/Vessel/Aircraft 结构性剔除（person PII 不物化）', () => {
    expect(parsed.entities).toHaveLength(2);
    const names = parsed.entities.map((e) => e.primaryName);
    expect(names).toEqual(['AEROCARIBBEAN AIRLINES', 'GLOBAL TRADING LLC']);
    // 具名个人绝不出现在任何字段
    const blob = JSON.stringify(parsed).toLowerCase();
    expect(blob).not.toContain('sanctioned person');
    expect(blob).not.toContain('the vessel');
  });

  it('解析发布日（MM/DD/YYYY → ISO）与记录数', () => {
    expect(parsed.publishDate).toBe('2026-07-13');
    expect(parsed.recordCount).toBe(4);
  });

  it('实体：externalId / primaryName / country / programs', () => {
    const aero = parsed.entities.find((e) => e.externalId === '36')!;
    expect(aero.primaryName).toBe('AEROCARIBBEAN AIRLINES');
    expect(aero.country).toBe('Cuba');
    expect(aero.programs).toEqual(['CUBA']);
  });

  it('别名带 strong/weak 质量标（弱别名保留但标记，供匹配侧不 originate）', () => {
    const aero = parsed.entities.find((e) => e.externalId === '36')!;
    expect(aero.aliases).toEqual([
      { name: 'AERO-CARIBBEAN', quality: 'strong' },
      { name: 'ACN', quality: 'weak' },
    ]);
  });

  it('多 program 归数组；无别名/无地址 → 空/null', () => {
    const gt = parsed.entities.find((e) => e.externalId === '9000')!;
    expect(gt.programs).toEqual(['IRAN', 'SDGT']);
    expect(gt.aliases).toEqual([]);
    expect(gt.country).toBeNull();
  });

  it('空/畸形输入 → 空列表（fail-safe，不抛）', () => {
    expect(parseOfacXml('').entities).toEqual([]);
    expect(parseOfacXml('<sdnList></sdnList>').entities).toEqual([]);
  });
});

/*
 * OFAC Consolidated (non-SDN) export as published on the Sanctions List Service: the same
 * <sdnList> schema and namespace as SDN.XML, individuals carrying birth data. Every name below is
 * invented; the structure mirrors the 2026-09-14 publication.
 */
const CONSOLIDATED_FIXTURE = `<?xml version="1.0" standalone="yes"?>
<sdnList xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns="https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/XML">
  <publshInformation>
    <Publish_Date>09/14/2026</Publish_Date>
    <Record_Count>5</Record_Count>
  </publshInformation>
  <sdnEntry>
    <uid>91001</uid>
    <firstName>Imaginary</firstName>
    <lastName>PERSONA ALPHA</lastName>
    <sdnType>Individual</sdnType>
    <programList><program>NS-PLC</program></programList>
    <akaList><aka><uid>1</uid><type>a.k.a.</type><category>strong</category><lastName>PERSONA ALEPH</lastName><firstName>Imaginary</firstName></aka></akaList>
    <dateOfBirthList><dateOfBirthItem><uid>2</uid><dateOfBirth>1950</dateOfBirth><mainEntry>true</mainEntry></dateOfBirthItem></dateOfBirthList>
    <placeOfBirthList><placeOfBirthItem><uid>3</uid><placeOfBirth>Inventedtown</placeOfBirth><mainEntry>true</mainEntry></placeOfBirthItem></placeOfBirthList>
  </sdnEntry>
  <sdnEntry>
    <uid>91002</uid>
    <lastName>FICTIVE HARBOUR LOGISTICS</lastName>
    <sdnType>Entity</sdnType>
    <programList><program>MENA-EO13894</program></programList>
    <akaList><aka><uid>4</uid><type>a.k.a.</type><category>weak</category><lastName>FHL</lastName></aka></akaList>
    <addressList><address><uid>5</uid><city>Nowhere</city><country>Turkey</country></address></addressList>
  </sdnEntry>
  <sdnEntry>
    <uid>91003</uid>
    <firstName>Madeup</firstName>
    <lastName>PERSONA BETA</lastName>
    <sdnType>Individual</sdnType>
    <programList><program>SSI</program></programList>
  </sdnEntry>
  <sdnEntry>
    <uid>91004</uid>
    <lastName>NONEXISTENT ENERGY TRADING</lastName>
    <sdnType>Entity</sdnType>
    <programList><program>SSI</program><program>UKRAINE-EO13662</program></programList>
  </sdnEntry>
  <sdnEntry>
    <uid>91005</uid>
    <lastName>UNNAMED TYPE ROW</lastName>
    <programList><program>SSI</program></programList>
  </sdnEntry>
</sdnList>`;

describe('parseOfacXml — OFAC Consolidated export and subject-type counts', () => {
  const parsed = parseOfacXml(CONSOLIDATED_FIXTURE);

  it('reads the Consolidated list with the SDN parser and keeps entities only', () => {
    expect(parsed.publishDate).toBe('2026-09-14');
    expect(parsed.recordCount).toBe(5);
    expect(parsed.entities.map((entity) => entity.externalId)).toEqual(['91002', '91004']);
    expect(parsed.entities[0]).toMatchObject({
      primaryName: 'FICTIVE HARBOUR LOGISTICS',
      country: 'Turkey',
      aliases: [{ name: 'FHL', quality: 'weak' }],
    });
    const blob = JSON.stringify(parsed).toLowerCase();
    for (const personal of ['persona alpha', 'persona aleph', 'persona beta', 'imaginary', 'madeup', 'inventedtown', '1950']) {
      expect(blob).not.toContain(personal);
    }
  });

  it('counts every published entry by sdnType, a missing type included, without naming anyone', () => {
    expect(parsed.subjectTypes).toEqual({ Individual: 2, Entity: 2, unspecified: 1 });
  });

  it('counts nothing for empty or foreign input', () => {
    expect(parseOfacXml('').subjectTypes).toEqual({});
    expect(parseOfacXml('<export generationDate="2026-01-01"/>').subjectTypes).toEqual({});
  });

  it('keeps a hostile sdnType value as a plain count key', () => {
    const hostile = parseOfacXml(
      '<sdnList><sdnEntry><uid>1</uid><lastName>X</lastName><sdnType>__proto__</sdnType></sdnEntry></sdnList>',
    );
    expect(Object.getPrototypeOf(hostile.subjectTypes)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(hostile.subjectTypes, '__proto__')).toBe(true);
    expect(hostile.entities).toEqual([]);
  });
});

