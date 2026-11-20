import { normalizeCountryValue } from "./company-normalization";
import type { ManufacturerNetworkEvidence } from "@global/contracts";
export type { ManufacturerNetworkEvidence } from "@global/contracts";
import {
  isContactFreeText,
  isStableSafeHttpsUrl,
} from "./raw-source-provider-normalizer";

import {
  manufacturerNameKey,
  validManufacturerIdentityReferences,
  closed,
  uuid,
  instant,
  type ManufacturerNetworkSource,
} from "./manufacturer-network-sources";

/** Company evidence never retains person-labelled contact/management lines. */
const PERSON_CONTEXT =
  /gesch(?:ä|ae)ftsf(?:ü|ue)hr|inhaber|ansprechpartner|vorstand|kontaktperson|managing director|contact person|contact:|kontakt:/iu;
function companySpan(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 400 &&
    value === value.normalize("NFKC") &&
    isContactFreeText(value) &&
    !PERSON_CONTEXT.test(value)
  );
}

export function readManufacturerNetworkEvidence(
  v: unknown,
): ManufacturerNetworkEvidence | undefined {
  if (
    !closed(v, [
      "schemaVersion",
      "workspaceId",
      "companyId",
      "publisherId",
      "targetDomain",
      "targetName",
      "country",
      "sourceUrl",
      "fetchedAt",
      "expiresAt",
      "relationship",
      "spans",
      "artifactId",
      "operationId",
      "resultDigest",
      "contentHash",
      "sourcePolicyId",
      "licenseLabel",
      "allowedActions",
      "sourceReviewRef",
      "independenceReviewRef",
      ...(v && typeof v === "object" && Object.hasOwn(v, "identityEvidenceRefs")
        ? ["identityEvidenceRefs"]
        : []),
    ])
  )
    return undefined;
  if (
    (Object.hasOwn(v, "identityEvidenceRefs") &&
      !validManufacturerIdentityReferences(v.identityEvidenceRefs)) ||
    v.schemaVersion !== "manufacturer-network-evidence/v1" ||
    v.country !== "DE" ||
    v.relationship !== "authorized_distributor" ||
    ![
      v.workspaceId,
      v.companyId,
      v.artifactId,
      v.operationId,
      v.sourcePolicyId,
    ].every(uuid) ||
    !instant(v.fetchedAt) ||
    !instant(v.expiresAt) ||
    Date.parse(v.expiresAt) <= Date.parse(v.fetchedAt) ||
    typeof v.sourceUrl !== "string" ||
    v.sourceUrl.length > 1024 ||
    !isStableSafeHttpsUrl(v.sourceUrl) ||
    typeof v.targetDomain !== "string" ||
    !/^(?:[a-z0-9-]+\.)+[a-z]{2,63}$/u.test(v.targetDomain) ||
    typeof v.resultDigest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(v.resultDigest) ||
    typeof v.contentHash !== "string" ||
    !/^[a-f0-9]{24}$/u.test(v.contentHash) ||
    JSON.stringify(v.allowedActions) !== '["display","match"]' ||
    ![
      v.publisherId,
      v.targetName,
      v.licenseLabel,
      v.sourceReviewRef,
      v.independenceReviewRef,
    ].every(
      (x) =>
        typeof x === "string" &&
        x.length > 0 &&
        x.length <= 160 &&
        isContactFreeText(x),
    ) ||
    !Array.isArray(v.spans) ||
    v.spans.length < 1 ||
    v.spans.length > 4 ||
    !v.spans.every(companySpan)
  )
    return undefined;
  return {
    ...v,
    spans: [...v.spans],
  } as unknown as ManufacturerNetworkEvidence;
}
export function currentManufacturerEvidence(
  value: unknown,
  subject: {
    id: string;
    domain: string | null;
    country: string | null;
    name: string;
  },
  now = new Date(),
): ManufacturerNetworkEvidence | undefined {
  const parsed = readManufacturerNetworkEvidence(value);
  if (
    !parsed ||
    parsed.companyId !== subject.id ||
    parsed.targetDomain !== subject.domain?.replace(/^www\./u, "") ||
    subject.country !== "DE" ||
    manufacturerNameKey(parsed.targetName) !==
      manufacturerNameKey(subject.name) ||
    Date.parse(parsed.fetchedAt) > now.getTime() ||
    Date.parse(parsed.expiresAt) <= now.getTime() ||
    now.getTime() - Date.parse(parsed.fetchedAt) > 30 * 86400000
  )
    return undefined;
  return parsed;
}
/** Known detail templates only. Search titles/snippets and full directory indexes are not facts. */
export function parseManufacturerDetail(input: {
  text: string;
  source: ManufacturerNetworkSource;
  company: { name: string; domain: string; country: string };
  legalNames?: readonly string[];
}): { spans: string[]; matchedName: string } | undefined {
  if (input.company.country !== "DE" || input.text.length > 60000)
    return undefined;
  const lines = input.text
    .split(/\r?\n/u)
    .map((l) => l.trim())
    .filter(Boolean);
  // Exact named detail heading and explicit canonical website are required; same-name-only is not identity.
  const heading = lines
    .filter((l) => /^#{1,3}\s/u.test(l))
    .map((l) => l.replace(/^#{1,3}\s+/u, ""));
  if (input.source.templateId === "aesseal-distributor/v1")
    heading.push(lines[0] ?? "");
  const targetNames = [input.company.name, ...(input.legalNames ?? [])].map(
    manufacturerNameKey,
  );
  const publisherName = manufacturerNameKey(input.source.legalName);
  if (
    heading.some(
      (h) =>
        /\b(?:gmbh|ag|kg|ltd|limited|inc|llc)\b/iu.test(h) &&
        ![...targetNames, publisherName].includes(manufacturerNameKey(h)),
    )
  )
    return undefined;
  const matchedName = heading.find((h) =>
    targetNames.includes(manufacturerNameKey(h)),
  );
  if (!matchedName) return undefined;
  const website = [
    ...input.text.matchAll(/https:\/\/[a-z0-9.-]+(?:\/[^\s)\]<>]*)?/giu),
  ].map((m) => new URL(m[0]!).hostname.replace(/^www\./u, ""));
  // AESSEAL may expose only a staff email. Derive its domain in memory; never retain any address/person line.
  if (input.source.templateId === "aesseal-distributor/v1")
    website.push(
      ...[...input.text.matchAll(/@[a-z0-9.-]+\.[a-z]{2,63}/giu)].map((m) =>
        m[0]!.slice(1).toLowerCase(),
      ),
    );
  if (!website.includes(input.company.domain.replace(/^www\./u, "")))
    return undefined;
  const profileIndex = lines.findIndex(
    (l) =>
      manufacturerNameKey(l.replace(/^#{1,3}\s+/u, "")) ===
      manufacturerNameKey(matchedName),
  );
  const profileLines = lines.slice(profileIndex + 1, profileIndex + 9);
  let profileCountry: string | null = null;
  for (const line of profileLines) {
    if (/^#{1,6}\s|^Location types:?$/u.test(line)) break;
    const labeled = /^(?:Country|Land)\b\s*:?\s*/iu.test(line);
    const country = normalizeCountryValue(
      line.replace(/^(?:Country|Land)\b\s*:?\s*/iu, ""),
    );
    if (labeled && !country) return undefined;
    if (country) {
      profileCountry = country;
      break;
    }
  }
  if (profileCountry !== "DE") return undefined;
  if (
    lines.some((l) =>
      /^(?:Status\s*:\s*)?(?:Expired|Revoked|Terminated)\b/iu.test(l),
    )
  )
    return undefined;
  const relation =
    input.source.templateId === "inoxpa-distributor/v1"
      ? /\b(?:authori[sz]ed\s+(?:INOXPA\s+)?distributor|offizieller\s+INOXPA[ -]Vertriebspartner)\b/iu
      : /\b(?:authori[sz]ed\s+AESSEAL\s+distributor|AESSEAL\s+authori[sz]ed\s+distributor)\b/iu;
  const spans = lines
    .filter(
      (l) =>
        relation.test(l) &&
        !/\b(?:not|no longer|former|revoked|terminated|unauthori[sz]ed|kein|keine|ehemaliger)\b/iu.test(
          l,
        ) &&
        l.length >= 30 &&
        l.length <= 400 &&
        l === l.normalize("NFKC") &&
        companySpan(l) &&
        manufacturerNameKey(l).includes(manufacturerNameKey(matchedName)),
    )
    .slice(0, 4);
  if (spans.length) return { spans, matchedName };
  if (input.source.templateId === "aesseal-distributor/v1") {
    const section = lines.findIndex((l) =>
      /^(?:#{1,4}\s*)?Location types:?$/u.test(l),
    );
    const values =
      section < 0
        ? []
        : lines
            .slice(section + 1, section + 4)
            .map((l) => l.replace(/^(?:[*-]|#{1,4})\s+/u, ""));
    // Closed known component; do not derive target relationships from global navigation/footer.
    if (
      values.includes("Distributor") &&
      values.every((l) => ["Service Centre", "Distributor"].includes(l))
    )
      return { spans: ["Distributor"], matchedName };
  }
  return undefined;
}
