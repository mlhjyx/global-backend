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
