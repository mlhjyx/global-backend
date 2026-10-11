import { describe, expect, it } from 'vitest';
import { parseEuFsf } from './eu-fsf-xml';

/**
 * EU FSF 解析（Phase 1 仅公司/实体）。🔴 核心红线：**只留 subjectType code="enterprise"，drop person**。
 * 结构据 2026-07-14 一手拉取（export/sanctionEntity/subjectType/nameAlias@wholeName@strong/address@country）。
 */

const FIXTURE = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<export xmlns="http://eu.europa.ec/fpi/fsd/export" generationDate="2026-06-05T15:51:25.849+02:00" globalFileId="182848">
  <sanctionEntity euReferenceNumber="EU.3502.46" logicalId="201">
    <regulation regulationType="amendment" publicationDate="2025-01-31" programme="TERR" logicalId="207667"/>
    <subjectType code="enterprise" classificationCode="E"/>
    <nameAlias firstName="" lastName="" wholeName="ACME TRADING LLC" strong="true" logicalId="1"/>
    <nameAlias firstName="" lastName="" wholeName="ACME TRD" strong="false" logicalId="2"/>
    <address country="RU"/>
  </sanctionEntity>
  <sanctionEntity euReferenceNumber="EU.1.1" logicalId="13">
    <regulation programme="IRQ"/>
    <subjectType code="person" classificationCode="P"/>
    <nameAlias firstName="Saddam" lastName="Hussein" wholeName="Saddam Hussein" strong="true"/>
  </sanctionEntity>
</export>`;

describe('parseEuFsf（Phase 1 仅公司/实体）', () => {
  const parsed = parseEuFsf(FIXTURE);

  it('🔴 只保留 enterprise——person 结构性剔除（person PII 不物化）', () => {
    expect(parsed.entities).toHaveLength(1);
    expect(parsed.entities[0].primaryName).toBe('ACME TRADING LLC');
    const blob = JSON.stringify(parsed).toLowerCase();
    expect(blob).not.toContain('saddam');
    expect(blob).not.toContain('hussein');
  });

  it('实体字段：externalId(logicalId) / country / programs / 强弱别名', () => {
    const e = parsed.entities[0];
    expect(e.externalId).toBe('201');
    expect(e.country).toBe('RU');
    expect(e.programs).toEqual(['TERR']);
    expect(e.aliases).toEqual([{ name: 'ACME TRD', quality: 'weak' }]);
  });

  it('generationDate → publishDate ISO 日期', () => {
    expect(parsed.publishDate).toBe('2026-06-05');
    expect(parsed.recordCount).toBe(1);
  });

  it('空/畸形 → 空列表（fail-safe）', () => {
    expect(parseEuFsf('').entities).toEqual([]);
    expect(parseEuFsf('<export></export>').entities).toEqual([]);
  });
});

// EU FSF full-list shape (2026-09-22 generation); every name below is invented.
const SUBJECT_FIXTURE = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<export xmlns="http://eu.europa.ec/fpi/fsd/export" generationDate="2026-09-22T20:01:34.799+02:00" globalFileId="900001">
  <sanctionEntity designationDetails="" unitedNationId="" euReferenceNumber="EU.9001.01" logicalId="900101">
    <regulation regulationType="regulation" publicationDate="2024-02-23" programme="RUS" logicalId="1"/>
    <subjectType code="person" classificationCode="P"/>
    <nameAlias firstName="Fictio" lastName="Personova" wholeName="Fictio Personova" strong="true" logicalId="2"/>
    <birthdate birthdate="1970-01-01" logicalId="3"/>
  </sanctionEntity>
  <sanctionEntity euReferenceNumber="EU.9001.02" logicalId="900102">
    <regulation programme="RUS" logicalId="4"/>
    <subjectType code="enterprise" classificationCode="E"/>
    <nameAlias wholeName="IMAGINARY MACHINE WORKS JSC" strong="true" logicalId="5"/>
    <address countryDescription="RUSSIAN FEDERATION" country="RU" logicalId="6"/>
  </sanctionEntity>
  <sanctionEntity euReferenceNumber="EU.9001.03" logicalId="900103">
    <regulation programme="BLR" logicalId="7"/>
    <subjectType code="person" classificationCode="P"/>
    <nameAlias wholeName="Inventa Madeupovich" strong="true" logicalId="8"/>
  </sanctionEntity>
  <sanctionEntity euReferenceNumber="EU.9001.04" logicalId="900104">
    <regulation programme="BLR" logicalId="9"/>
    <subjectType code="enterprise" classificationCode="E"/>
    <nameAlias wholeName="PHANTOM POTASH EXPORT LLC" strong="true" logicalId="10"/>
    <nameAlias wholeName="PPE LLC" strong="false" logicalId="11"/>
  </sanctionEntity>
</export>`;

describe('parseEuFsf — subject-type counts', () => {
  const parsed = parseEuFsf(SUBJECT_FIXTURE);

  it('keeps enterprises only and counts every published entry by subjectType code', () => {
    expect(parsed.publishDate).toBe('2026-09-22');
    expect(parsed.entities.map((entity) => entity.externalId)).toEqual(['900102', '900104']);
    expect(parsed.subjectTypes).toEqual({ person: 2, enterprise: 2 });
    const blob = JSON.stringify(parsed).toLowerCase();
    for (const personal of ['fictio', 'personova', 'inventa', 'madeupovich', '1970-01-01']) {
      expect(blob).not.toContain(personal);
    }
  });

  it('counts nothing for empty or foreign input', () => {
    expect(parseEuFsf('').subjectTypes).toEqual({});
    expect(parseEuFsf('<sdnList><sdnEntry><uid>1</uid></sdnEntry></sdnList>').subjectTypes).toEqual({});
  });
});

