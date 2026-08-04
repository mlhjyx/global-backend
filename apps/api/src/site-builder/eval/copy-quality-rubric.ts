export const COPY_QUALITY_REVIEW_SCHEMA_VERSION =
  "site-builder-copy-quality-review/2026-08-04-v1" as const;
export const COPY_QUALITY_RUBRIC_VERSION =
  "site-builder-copy-quality-rubric/2026-08-04-v1" as const;

export const COPY_QUALITY_SCORED_DIMENSIONS = Object.freeze([
  "language_quality",
  "brand_voice",
  "cta_quality",
  "cross_locale_quality",
  "stability",
] as const);

export const COPY_QUALITY_REVIEWED_DIMENSIONS = Object.freeze([
  "language_quality",
  "brand_voice",
  "cta_quality",
  "cross_locale_quality",
] as const);

export type CopyQualityScoredDimension =
  (typeof COPY_QUALITY_SCORED_DIMENSIONS)[number];
export type CopyQualityReviewedDimension =
  (typeof COPY_QUALITY_REVIEWED_DIMENSIONS)[number];

export const COPY_QUALITY_FINDING_PENALTIES = Object.freeze({
  language_quality: Object.freeze({
    wrong_language_or_script: 4,
    grammar_breakdown: 3,
    awkward_or_ambiguous: 2,
    generic_or_repetitive: 1,
  }),
  brand_voice: Object.freeze({
    contradicts_voice: 4,
    hype_or_unsubstantiated_superlative: 3,
    ignores_declared_style: 2,
    audience_mismatch: 2,
  }),
  cta_quality: Object.freeze({
    contact_intent_unclear: 3,
    locale_inappropriate: 2,
    register_mismatch: 2,
    action_label_weak: 1,
  }),
  cross_locale_quality: Object.freeze({
    untranslated_creative_copy: 4,
    mixed_locale: 3,
    terminology_inconsistent: 2,
    cultural_register_mismatch: 1,
  }),
} as const);

export const COPY_QUALITY_GATE = Object.freeze({
  scaleMinimum: 0,
  scaleMaximum: 4,
  observationMinimum: 2,
  dimensionMeanMinimum: 3,
  allHardGatesRequired: true,
  promotionDecision: "SEPARATE_PR_REQUIRED",
  routeAdoptionAuthorized: false,
} as const);
