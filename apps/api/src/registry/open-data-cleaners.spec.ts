import { describe, expect, it } from 'vitest';
import {
  cleanAuAbnRecord,
  cleanBrCnpjRecord,
  cleanUkCompaniesHouseRow,
  classifyAuCorporateNames,
  isValidAuAbn,
  isValidBrCnpj,
  isValidUkCrn,
  normalizeUkCrn,
} from './open-data-cleaners';

describe('registration number validators', () => {
  it('normalizes and validates UK Companies House CRNs', () => {
    expect(normalizeUkCrn('123456')).toBe('00123456');
    expect(normalizeUkCrn('sc 123456')).toBe('SC123456');
    expect(isValidUkCrn('01234567')).toBe(true);
    expect(isValidUkCrn('SC123456')).toBe(true);
    expect(isValidUkCrn('OC301234')).toBe(true);
    expect(isValidUkCrn('INVALID-CRN')).toBe(false);
    expect(isValidUkCrn('')).toBe(false);
  });

  it('validates Australian 11-digit ABNs with ATO mod-89 checksum', () => {
    expect(isValidAuAbn('51824753556')).toBe(true);
    expect(isValidAuAbn('51 824 753 556')).toBe(true);
    expect(isValidAuAbn('51824753557')).toBe(false);
    expect(isValidAuAbn('1234567890')).toBe(false);
  });

  it('validates Brazilian 14-digit CNPJs with dual mod-11 check digits', () => {
    expect(isValidBrCnpj('11222333000181')).toBe(true);
    expect(isValidBrCnpj('11.222.333/0001-81')).toBe(true);
    expect(isValidBrCnpj('11222333000182')).toBe(false);
    expect(isValidBrCnpj('00000000000000')).toBe(false);
  });
});

describe('cleanUkCompaniesHouseRow', () => {
  it('keeps active companies with target solar/electrical SIC across SicText_1..4 without street PII', () => {
    const kept = cleanUkCompaniesHouseRow({
      companyNumber: '987654',
      companyName: '  Thames Solar Installations Ltd  ',
      companyStatus: 'Active',
      companyCategory: 'Private Limited Company',
      postTown: 'Reading',
      county: 'Berkshire',
      postCode: 'rg1 1aa',
      sicTexts: ['70100 - Activities of head offices', '43210 - Electrical installation'],
    });
    expect(kept).toEqual({
      keep: true,
      row: {
        CompanyNumber: '00987654',
        CompanyName: 'Thames Solar Installations Ltd',
        CompanyStatus: 'Active',
        CompanyCategory: 'Private Limited Company',
        PostTown: 'Reading',
        County: 'Berkshire',
        PostCode: 'RG1 1AA',
        MatchedSic: '43210',
        NaceCode: '43.21',
      },
    });
  });

  it('filters out strike-off pending, dissolved, invalid CRN, and unmatched SIC rows', () => {
    const base = {
      companyNumber: '01234567',
      companyName: 'Solar Test Ltd',
      companyStatus: 'Active',
      companyCategory: 'Private Limited Company',
      sicTexts: ['35110 - Production of electricity'],
    };
    expect(cleanUkCompaniesHouseRow({ ...base, companyStatus: 'Active - Proposal to Strike off' })).toEqual({
      keep: false,
      reason: 'strike_off_pending',
    });
    expect(cleanUkCompaniesHouseRow({ ...base, companyStatus: 'Dissolved' })).toEqual({
      keep: false,
      reason: 'inactive_status',
    });
    expect(cleanUkCompaniesHouseRow({ ...base, sicTexts: ['99999 - Dormant Company'] })).toEqual({
      keep: false,
      reason: 'industry_unmatched',
    });
    expect(cleanUkCompaniesHouseRow({ ...base, companyNumber: 'BAD' })).toEqual({
      keep: false,
      reason: 'invalid_reg_number',
    });
  });
});

describe('cleanAuAbnRecord & classifyAuCorporateNames', () => {
  it('strictly skips individuals/sole traders, family trusts, cancelled ABNs, and auto-electrical/tanning noise', () => {
    const base = {
      abn: '51824753556',
      status: 'ACT',
      entityTypeInd: 'PRV',
      isIndividual: false,
      legalName: 'SUNCOAST SOLAR DISTRIBUTIONS PTY LTD',
      tradingNames: [],
      state: 'NSW',
      postcode: '2000',
      asicNumber: '012345678',
      gstStatus: 'ACT',
    };
    expect(cleanAuAbnRecord({ ...base, isIndividual: true, entityTypeInd: 'IND' })).toEqual({
      keep: false,
      reason: 'skipped_individual',
    });
    expect(cleanAuAbnRecord({ ...base, entityTypeInd: 'FPT' })).toEqual({
      keep: false,
      reason: 'skipped_non_corporate_type',
    });
    expect(cleanAuAbnRecord({ ...base, entityTypeInd: 'OIE' })).toEqual({
      keep: false,
      reason: 'skipped_non_corporate_type',
    });
    expect(cleanAuAbnRecord({ ...base, status: 'CAN' })).toEqual({
      keep: false,
      reason: 'inactive_status',
    });
    expect(
      cleanAuAbnRecord({
        ...base,
        legalName: 'ACTIVE CAR & TRUCK ELECTRICS PTY LTD',
        tradingNames: ['AUTO ELECTRICAL WHOLESALERS'],
      }),
    ).toEqual({ keep: false, reason: 'industry_unmatched' });
    expect(
      cleanAuAbnRecord({
        ...base,
        legalName: 'SOLAR TANNING & BEAUTY SALON PTY LTD',
      }),
    ).toEqual({ keep: false, reason: 'industry_unmatched' });
  });

  it('classifies solar wholesale, installation, generation, and trading-name matches deterministically', () => {
    expect(classifyAuCorporateNames('R F INDUSTRIES PTY LTD', ['RFI Solar'])).toEqual({
      nace: '27.90',
      matchRule: 'solar_pv_general',
      matchedName: 'RFI Solar',
    });
    expect(
      cleanAuAbnRecord({
        abn: '51824753556',
        status: 'ACT',
        entityTypeInd: 'PRV',
        isIndividual: false,
        legalName: 'SOUTHERN CROSS HOLDINGS PTY LTD',
        tradingNames: ['SOUTHERN CROSS SOLAR WHOLESALE'],
        state: 'nsw',
        postcode: '2000',
        asicNumber: '012345678',
        gstStatus: 'ACT',
      }),
    ).toEqual({
      keep: true,
      row: {
        Abn: '51824753556',
        LegalName: 'SOUTHERN CROSS HOLDINGS PTY LTD',
        Status: 'ACT',
        EntityType: 'PRV',
        State: 'NSW',
        Postcode: '2000',
        NaceCode: '46.69',
        Acn: '012345678',
        GstStatus: 'ACT',
        MatchRule: 'solar_elec_wholesale',
        MatchedTradingName: 'SOUTHERN CROSS SOLAR WHOLESALE',
      },
    });
  });
});

describe('cleanBrCnpjRecord', () => {
  const base = {
    cnpjBasico: '11222333',
    cnpjOrdem: '0001',
    cnpjDv: '81',
    matrizFilial: '1',
    situacaoCadastral: '02',
    cnaePrincipal: '4673700',
    razaoSocial: 'SOLAR DISTRIBUIDORA DE MATERIAL ELETRICO LTDA',
    nomeFantasia: 'SOLAR DIST',
    naturezaJuridica: '2062',
    porte: '03',
    isMei: false,
    municipio: 'SAO PAULO',
    uf: 'sp',
    cep: '01310-100',
  };

  it('keeps active corporate HQ matching solar/electrical CNAE without contact/street PII', () => {
    expect(cleanBrCnpjRecord(base)).toEqual({
      keep: true,
      row: {
        Cnpj: '11222333000181',
        RazaoSocial: 'SOLAR DISTRIBUIDORA DE MATERIAL ELETRICO LTDA',
        SituacaoCadastral: '02',
        NaturezaJuridica: '2062',
        CnaePrincipal: '4673700',
        Municipio: 'SAO PAULO',
        Uf: 'SP',
        Cep: '01310100',
        Porte: '03',
        NomeFantasia: 'SOLAR DIST',
      },
    });
  });

  it('strictly skips MEI, Empresário Individual (2135), branches, inactive records, and non-solar CNAE', () => {
    expect(cleanBrCnpjRecord({ ...base, isMei: true })).toEqual({ keep: false, reason: 'skipped_mei' });
    expect(cleanBrCnpjRecord({ ...base, naturezaJuridica: '2135' })).toEqual({
      keep: false,
      reason: 'skipped_individual_entrepreneur',
    });
    expect(cleanBrCnpjRecord({ ...base, naturezaJuridica: '3999' })).toEqual({
      keep: false,
      reason: 'skipped_non_corporate_natureza',
    });
    expect(cleanBrCnpjRecord({ ...base, matrizFilial: '2' })).toEqual({
      keep: false,
      reason: 'skipped_branch',
    });
    expect(cleanBrCnpjRecord({ ...base, situacaoCadastral: '08' })).toEqual({
      keep: false,
      reason: 'inactive_status',
    });
    expect(cleanBrCnpjRecord({ ...base, cnaePrincipal: '5611201' })).toEqual({
      keep: false,
      reason: 'industry_unmatched',
    });
  });
});
