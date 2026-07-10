import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreateRuleDto, UpdateRuleDto } from './qualification.dto';

/**
 * J：规则权重值域护栏。负权重会静默参与 nice-to-have 归一化分母（got/total 可超 1 →
 * fit>1 污染排序）；排除语义应由 MUST_NOT_HAVE/EXCLUSION 规则表达，不靠负权重。
 */

const BASE = { kind: 'NICE_TO_HAVE', field: 'industry', operator: 'eq', value: 'automotive' };

describe('CreateRuleDto.weight — @Min(0)（J）', () => {
  it('负权重 → 校验失败（min 约束）', () => {
    const dto = plainToInstance(CreateRuleDto, { ...BASE, weight: -1 });
    const errors = validateSync(dto);
    // 旧 DTO 只有 @IsNumber → 负值静默通过 → RED
    expect(errors.some((e) => e.property === 'weight' && e.constraints?.min)).toBe(true);
  });

  it('0 与正权重合法；缺省（optional）合法', () => {
    expect(validateSync(plainToInstance(CreateRuleDto, { ...BASE, weight: 0 }))).toEqual([]);
    expect(validateSync(plainToInstance(CreateRuleDto, { ...BASE, weight: 2.5 }))).toEqual([]);
    expect(validateSync(plainToInstance(CreateRuleDto, { ...BASE }))).toEqual([]);
  });
});

describe('UpdateRuleDto.weight — @Min(0)（J）', () => {
  it('负权重 → 校验失败；正权重合法', () => {
    const bad = validateSync(plainToInstance(UpdateRuleDto, { weight: -0.1 }));
    expect(bad.some((e) => e.property === 'weight' && e.constraints?.min)).toBe(true);
    expect(validateSync(plainToInstance(UpdateRuleDto, { weight: 1 }))).toEqual([]);
  });
});
