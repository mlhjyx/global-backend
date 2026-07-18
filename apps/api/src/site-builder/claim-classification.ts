const CERTIFICATION_WORD_PATTERN =
  /certif|certificate|accredit|认证|证书|资质/iu;
const CERTIFICATION_CODE_PATTERN =
  /(?:^|[^a-z0-9])(?:iso|iec|en|din|iatf|as|api|astm|gb|ul)\s*[-:/]?\s*\d[\d.-]*(?=$|[^a-z0-9])/iu;
const CERTIFICATION_MARK_PATTERN =
  /(?:^|[^a-z0-9])(?:ce|fda|ul|rohs|gmp|tüv)(?=$|[^a-z0-9])/iu;
const REACH_MARK_PATTERN =
  /(?:^|[^a-z0-9])reach(?=$|[^a-z0-9])/iu;
const CERTIFICATION_FIELD_CONTEXT_PATTERN =
  /certif|certificate|accredit|compliance|standard|quality|safety|environmental|认证|证书|资质|合规|标准|质量|安全|环保/iu;
const REACH_QUALIFIER_PATTERN =
  /reach.{0,32}(?:compliant|compliance|regulation|standard)|(?:compliant|compliance|regulation|standard).{0,32}reach/iu;

/** Shared classifier for semantic, persistence and publication gates. */
export function isCertificationClaim(input: {
  key?: string;
  value?: string;
  type?: string;
}): boolean {
  const normalized =
    `${input.type ?? ""} ${input.key ?? ""} ${input.value ?? ""}`
      .normalize("NFKC")
      .toLocaleLowerCase("en-US");
  const fieldContext = `${input.type ?? ""} ${input.key ?? ""}`
    .normalize("NFKC")
    .toLocaleLowerCase("en-US");
  return (
    CERTIFICATION_WORD_PATTERN.test(normalized) ||
    CERTIFICATION_CODE_PATTERN.test(normalized) ||
    CERTIFICATION_MARK_PATTERN.test(normalized) ||
    (REACH_MARK_PATTERN.test(normalized) &&
      (CERTIFICATION_FIELD_CONTEXT_PATTERN.test(fieldContext) ||
        REACH_QUALIFIER_PATTERN.test(normalized)))
  );
}
