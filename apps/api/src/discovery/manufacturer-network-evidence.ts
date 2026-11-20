import { readManufacturerProfileText } from "../adapters/manufacturer-profile-text";
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
  profileTextRevision?: "manufacturer-profile/v1";
  source: ManufacturerNetworkSource;
  company: { name: string; domain: string; country: string };
  legalNames?: readonly string[];
}): { spans: string[]; matchedName: string } | undefined {
  if (input.company.country !== "DE" || input.text.length > 60000)
    return undefined;
  const projection = input.profileTextRevision
    ? readManufacturerProfileText(input.text)
    : undefined;
  if (input.profileTextRevision && !projection) return undefined;
  const lines = (projection?.markdown ?? input.text)
    .split(/\r?\n/u)
    .map((l) => l.trim())
    .filter(Boolean);
  // One verified target profile only. A following unknown heading is an ambiguous
  // layout, even when that heading has no legal suffix (e.g. "Other Pumps").
  const headings = lines.flatMap((line, index) =>
    /^#{1,6}\s/u.test(line)
      ? [{ name: line.replace(/^#{1,6}\s+/u, ""), index }]
      : [],
  );
  if (
    input.source.templateId === "aesseal-distributor/v1" &&
    !/^#{1,6}\s/u.test(lines[0] ?? "")
  )
    headings.push({ name: lines[0] ?? "", index: 0 });
  const targetNames = [input.company.name, ...(input.legalNames ?? [])].map(
    manufacturerNameKey,
  );
  const matches = headings.filter((h) =>
    targetNames.includes(manufacturerNameKey(h.name)),
  );
  if (matches.length !== 1) return undefined;
  const { name: matchedName, index: profileIndex } = matches[0]!;
  const publisherName = manufacturerNameKey(input.source.legalName);
  if (
    headings.some(
      (h) =>
        h.index !== profileIndex &&
        !(
          h.index < profileIndex &&
          manufacturerNameKey(h.name) === publisherName
        ) &&
        !(h.index > profileIndex && /^Location types:?$/u.test(h.name)),
    )
  )
    return undefined;
  const profile = lines.slice(profileIndex + 1);
  const profileText = profile.join("\n");
  const website = [
    ...profileText.matchAll(/https:\/\/[a-z0-9.-]+(?:\/[^\s)\]<>]*)?/giu),
  ].map((m) => new URL(m[0]!).hostname.replace(/^www\./u, ""));
  website.push(...(projection?.emailDomains ?? []));
  // Derive an email domain in memory only, from this profile, never from another card.
  if (input.source.templateId === "aesseal-distributor/v1")
    website.push(
      ...[...profileText.matchAll(/@[a-z0-9.-]+\.[a-z]{2,63}/giu)].map((m) =>
        m[0]!.slice(1).toLowerCase(),
      ),
    );
  if (!website.includes(input.company.domain.replace(/^www\./u, "")))
    return undefined;
  const profileLines = profile.slice(0, 8);
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
  // A current negative is a decision, not merely a span to discard. It takes
  // precedence over a stale positive Location types label in this target profile.
  const negative =
    /\b(?:not|no\s+longer|former|revoked|expired|terminated|unauthori[sz]ed|kein|keine|nicht|ehemaliger|beendet|widerrufen|abgelaufen)\b/iu;
  const wrappedNegative =
    /\b(?:not|no\s+longer|former|revoked|expired|terminated|unauthori[sz]ed|kein|keine|nicht|ehemaliger|beendet|widerrufen|abgelaufen)\b[^.!?;:]{0,160}\b(?:distributor|vertriebspartner)\b/iu;
  if (wrappedNegative.test(profileText.replace(/\s+/gu, " "))) return undefined;
  if (
    profile.some(
      (line) =>
        /^(?:(?:Relationship|Distributor)\s+status|Status)\s*:\s*(?:Expired|Revoked|Terminated)\b/iu.test(
          line,
        ) ||
        /^(?:Expired|Revoked|Terminated)\b/iu.test(line) ||
        (/\b(?:distributor|vertriebspartner)\b/iu.test(line) &&
          negative.test(line)),
    )
  )
    return undefined;
  // A relationship statement naming a different complete subject also makes a
  // component fallback ambiguous, even when that foreign name contains ours.
  if (
    profile.some((line) => {
      const statement = line.match(/^(.+?)\s+(?:is|ist)\s+(.+)$/iu);
      return (
        !!statement &&
        /\b(?:distributor|vertriebspartner)\b/iu.test(statement[2]!) &&
        manufacturerNameKey(statement[1]!) !== manufacturerNameKey(matchedName)
      );
    })
  )
    return undefined;
  const relation =
    input.source.templateId === "inoxpa-distributor/v1"
      ? /\b(?:authori[sz]ed\s+(?:INOXPA\s+)?distributor|offizieller\s+INOXPA[ -]Vertriebspartner)\b/iu
      : /\b(?:authori[sz]ed\s+AESSEAL\s+distributor|AESSEAL\s+authori[sz]ed\s+distributor)\b/iu;
  const spans = profile
    .filter((line) => {
      // The complete grammatical subject must equal the accepted complete name.
      // Longer names containing the target key do not establish its relationship.
      const statement = line.match(/^(.+?)\s+(?:is|ist)\s+(.+)$/iu);
      return (
        !!statement &&
        manufacturerNameKey(statement[1]!) ===
          manufacturerNameKey(matchedName) &&
        relation.test(statement[2]!) &&
        !negative.test(statement[2]!) &&
        line.length >= 30 &&
        companySpan(line)
      );
    })
    .slice(0, 4);
  if (spans.length) return { spans, matchedName };
  if (input.source.templateId === "aesseal-distributor/v1") {
    const sections = profile.flatMap((line, index) =>
      /^(?:#{1,6}\s*)?Location types:?$/u.test(line) ? [index] : [],
    );
    if (sections.length !== 1) return undefined;
    const section = sections[0]!;
    const values =
      section < 0
        ? []
        : profile
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
