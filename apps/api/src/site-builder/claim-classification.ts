const CERTIFICATION_WORD_PATTERN =
  /certif|certificate|accredit|认证|证书|资质/iu;
const CERTIFICATION_CODE_PATTERN =
  /(?:^|[^a-z0-9])(?:iso|iec|en|din|iatf|as|api|astm|gb|ul)\s*[-:/]?\s*\d[\d.-]*(?=$|[^a-z0-9])/iu;
const CERTIFICATION_MARK_PATTERN =
  /(?:^|[^a-z0-9])(?:ce|fda|ul|rohs|reach|gmp|tüv)(?=$|[^a-z0-9])/iu;

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
  return (
    CERTIFICATION_WORD_PATTERN.test(normalized) ||
    CERTIFICATION_CODE_PATTERN.test(normalized) ||
    CERTIFICATION_MARK_PATTERN.test(normalized)
  );
}
