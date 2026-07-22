import { describe, expect, it } from 'vitest';
import {
  M1_E_A_COMPONENT_QUALIFICATIONS,
  SITE_SPEC_COMPONENT_TYPES,
  SITE_SPEC_RELEASE_COMPONENT_TYPES,
  SITE_SPEC_TRANSITIONAL_RELEASE_COMPONENT_TYPES,
  assertReleaseQualificationRegistryIntegrity,
  getComponentReleaseReadiness,
  validateComponentQualification,
  type ComponentQualificationEvidence,
} from '@global/contracts';

const completeEvidence: ComponentQualificationEvidence = {
  schema: { evidenceId: 'schema/HeroBanner/v1' },
  variants: {
    evidenceId: 'variants/HeroBanner/v1',
    values: ['default', 'technical-grid'],
  },
  contentBudget: { evidenceId: 'content-budget/HeroBanner/v1' },
  accessibility: { evidenceId: 'a11y/HeroBanner/v1' },
  reducedMotion: { evidenceId: 'reduced-motion/HeroBanner/v1' },
  fixtures: {
    evidenceId: 'fixtures/HeroBanner/v1',
    fixtureIds: ['hero-default', 'hero-technical-grid'],
  },
  visualRegression: {
    evidenceId: 'visual/HeroBanner/v1',
    breakpoints: [375, 768, 1440],
  },
};

describe('M1-e-A component qualification gate', () => {
  it('classifies the original ten release components as transitional debt', () => {
    expect(SITE_SPEC_TRANSITIONAL_RELEASE_COMPONENT_TYPES).toHaveLength(10);
    expect(new Set(SITE_SPEC_TRANSITIONAL_RELEASE_COMPONENT_TYPES)).toEqual(
      new Set(SITE_SPEC_RELEASE_COMPONENT_TYPES),
    );
    expect(getComponentReleaseReadiness('HeroBanner')).toEqual({
      status: 'transitional_release',
    });
  });

  it('keeps every newly distilled component gallery-only until qualification', () => {
    expect(SITE_SPEC_COMPONENT_TYPES).toHaveLength(55);
    expect(getComponentReleaseReadiness('StatementBlock')).toEqual({
      status: 'gallery_only',
    });
    expect(Object.keys(M1_E_A_COMPONENT_QUALIFICATIONS)).toHaveLength(0);
  });

  it('accepts evidence only when all seven contract parts are present', () => {
    expect(validateComponentQualification('HeroBanner', completeEvidence)).toEqual(
      completeEvidence,
    );
  });

  it.each([
    'schema',
    'variants',
    'contentBudget',
    'accessibility',
    'reducedMotion',
    'fixtures',
    'visualRegression',
  ] as const)('rejects qualification missing %s evidence', (part) => {
    const incomplete = { ...completeEvidence } as Record<string, unknown>;
    delete incomplete[part];
    expect(() =>
      validateComponentQualification(
        'HeroBanner',
        incomplete as ComponentQualificationEvidence,
      ),
    ).toThrow(`COMPONENT_QUALIFICATION_INVALID: HeroBanner`);
  });

  it('requires the exact 375/768/1440 visual regression matrix', () => {
    expect(() =>
      validateComponentQualification('HeroBanner', {
        ...completeEvidence,
        visualRegression: {
          ...completeEvidence.visualRegression,
          breakpoints: [390, 768, 1440] as unknown as [375, 768, 1440],
        },
      }),
    ).toThrow('COMPONENT_QUALIFICATION_INVALID: HeroBanner');
  });

  it('rejects manually extending the release list without qualification', () => {
    expect(() =>
      assertReleaseQualificationRegistryIntegrity({
        releaseTypes: [...SITE_SPEC_RELEASE_COMPONENT_TYPES, 'StatementBlock'],
        transitionalTypes: SITE_SPEC_TRANSITIONAL_RELEASE_COMPONENT_TYPES,
        qualifications: M1_E_A_COMPONENT_QUALIFICATIONS,
      }),
    ).toThrow('COMPONENT_RELEASE_REGISTRY_INVALID: StatementBlock');
  });
});
