import 'reflect-metadata';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { CreateRuleDto, UpdateRuleDto } from './qualification.dto';

// Match the actual application's body pipe; plainToInstance/validate alone
// cannot reproduce removal of a Swagger-only property by whitelist.
function body(metatype: typeof CreateRuleDto | typeof UpdateRuleDto, value: unknown) {
  return new ValidationPipe({ transform: true, whitelist: true }).transform(value, {
    type: 'body', metatype,
  });
}
const operands = [
  { label: 'string', field: 'industry', operator: 'eq', value: 'industrial pumps' },
  { label: 'number', field: 'employee_count', operator: 'gte', value: 120 },
  { label: 'zero', field: 'employee_count', operator: 'gte', value: 0 },
  { label: 'true', field: 'own_manufacturing', operator: 'eq', value: true },
  { label: 'false', field: 'own_manufacturing', operator: 'eq', value: false },
  { label: 'reviewed name list', field: 'name', operator: 'in', value: ['Technical', 'Ando Technik', 'Industrial Pump Group'] },
  { label: 'reviewed domain list', field: 'domain', operator: 'in', value: ['technical.de', 'ando-technik.com', 'industrialpumpgroup.de'] },
];
const valid = { kind: 'MUST_HAVE', field: 'name', operator: 'in' };

describe('CreateRuleDto.value through the application ValidationPipe', () => {
  it.each(operands)('retains the required $label operand', async ({ value, field, operator }) => {
    const result = await body(CreateRuleDto, { ...valid, field, operator, value });
    expect(result).toBeInstanceOf(CreateRuleDto);
    expect(result.value).toEqual(value);
  });
  it.each([
    { label: 'missing', input: valid },
    { label: 'undefined', input: { ...valid, value: undefined } },
    { label: 'null', input: { ...valid, value: null } },
  ])('rejects a $label operand instead of allowing a null write', async ({ input }) => {
    const result = body(CreateRuleDto, input);
    await expect(result).rejects.toBeInstanceOf(BadRequestException);
    await expect(result).rejects.toMatchObject({ status: 400 });
  });
  it('keeps value while still stripping unrelated body keys', async () => {
    const result = await body(CreateRuleDto, { ...valid, value: operands[5]!.value, unrelated: 'strip me' });
    expect(result.value).toEqual(operands[5]!.value);
    expect(result).not.toHaveProperty('unrelated');
  });
});

describe('UpdateRuleDto.value keeps its existing optional semantics', () => {
  it.each([...operands, { label: 'undefined', value: undefined }, { label: 'null', value: null }])(
    'preserves an optional $label operand', async ({ value }) => {
      const result = await body(UpdateRuleDto, { value });
      expect(result).toBeInstanceOf(UpdateRuleDto);
      expect(result.value).toEqual(value);
    },
  );
  it('still allows a patch without a value', async () => {
    const result = await body(UpdateRuleDto, {});
    expect(result.value).toBeUndefined();
  });
});
