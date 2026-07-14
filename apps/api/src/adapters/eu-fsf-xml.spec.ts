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
