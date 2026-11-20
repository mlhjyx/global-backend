import {
  isContactFreeText,
  isStableSafeHttpsUrl,
} from "./raw-source-provider-normalizer";
export interface ManufacturerNetworkSource {
  publisherId: string;
  legalName: string;
  domain: string;
  knownCorporateDomains: string[];
  detailPathPrefixes: string[];
  templateId: "inoxpa-distributor/v1" | "aesseal-distributor/v1";
  allowedPurposes: ["enrichment"];
  allowedActions: ["display", "match"];
  licenseLabel: string;
  reviewRef: string;
  reviewedAt: string;
  expiresAt: string;
}
export interface ManufacturerIndependenceAttestation {
  workspaceId: string;
  companyId: string;
  targetDomain: string;
  publisherId: string;
  independenceBasisRefs: string[];
  actor: "operator" | "agent";
  reviewRef: string;
  reviewedAt: string;
  expiresAt: string;
}
export interface ManufacturerNetworkSources {
  schemaVersion: "manufacturer-network-sources/v1";
  sources: ManufacturerNetworkSource[];
  independenceAttestations: ManufacturerIndependenceAttestation[];
}
export function closed(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    Object.keys(value).every((k) => keys.includes(k)) &&
    Object.values(Object.getOwnPropertyDescriptors(value)).every(
      (d) => "value" in d,
    )
  );
}
export const uuid = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(v);
export const instant = (v: unknown): v is string =>
  typeof v === "string" &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/u.test(v) &&
  Number.isFinite(Date.parse(v));
const domain = (v: unknown): v is string =>
  typeof v === "string" &&
  v.length <= 253 &&
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(v);
const text = (v: unknown): v is string =>
  typeof v === "string" &&
  v.length >= 1 &&
  v.length <= 160 &&
  isContactFreeText(v);
const ref = (v: unknown): v is string =>
  typeof v === "string" &&
  v.length <= 160 &&
  /^[a-zA-Z][a-zA-Z0-9:._/-]*$/u.test(v);
function review(v: Record<string, unknown>): boolean {
  return ref(v.reviewRef) && instant(v.reviewedAt) && instant(v.expiresAt);
}
function strings(
  v: unknown,
  min: number,
  max: number,
  p: (x: unknown) => boolean,
): boolean {
  return Array.isArray(v) && v.length >= min && v.length <= max && v.every(p);
}
function validSource(v: unknown): boolean {
  return (
    closed(v, [
      "publisherId",
      "legalName",
      "domain",
      "knownCorporateDomains",
      "detailPathPrefixes",
      "templateId",
      "allowedPurposes",
      "allowedActions",
      "licenseLabel",
      "reviewRef",
      "reviewedAt",
      "expiresAt",
    ]) &&
    ref(v.publisherId) &&
    text(v.legalName) &&
    domain(v.domain) &&
    strings(v.knownCorporateDomains, 1, 30, domain) &&
    strings(
      v.detailPathPrefixes,
      1,
      12,
      (x) =>
        typeof x === "string" &&
        x.length <= 512 &&
        /^\/[a-zA-Z0-9/_-]+\/?$/u.test(x),
    ) &&
    ["inoxpa-distributor/v1", "aesseal-distributor/v1"].includes(
      String(v.templateId),
    ) &&
    JSON.stringify(v.allowedPurposes) === '["enrichment"]' &&
    JSON.stringify(v.allowedActions) === '["display","match"]' &&
    text(v.licenseLabel) &&
    review(v)
  );
}
function validAttestation(v: unknown): boolean {
  return (
    closed(v, [
      "workspaceId",
      "companyId",
      "targetDomain",
      "publisherId",
      "independenceBasisRefs",
      "actor",
      "reviewRef",
      "reviewedAt",
      "expiresAt",
    ]) &&
    uuid(v.workspaceId) &&
    uuid(v.companyId) &&
    domain(v.targetDomain) &&
    ref(v.publisherId) &&
    strings(v.independenceBasisRefs, 1, 8, ref) &&
    ["operator", "agent"].includes(String(v.actor)) &&
    review(v)
  );
}
export interface ManufacturerSourcePolicy {
  id: string;
  domain: string;
  sourceType: string;
  reviewStatus: string;
  termsStatus: string;
  allowedPurpose: unknown;
  allowedPaths: unknown;
  disallowedPaths: unknown;
  retentionDays: number;
}
export function readManufacturerNetworkSources(
  value: unknown,
): ManufacturerNetworkSources | undefined {
  if (
    !closed(value, ["schemaVersion", "sources", "independenceAttestations"]) ||
    value.schemaVersion !== "manufacturer-network-sources/v1" ||
    !Array.isArray(value.sources) ||
    value.sources.length > 12 ||
    !value.sources.every(validSource) ||
    !Array.isArray(value.independenceAttestations) ||
    value.independenceAttestations.length > 500 ||
    !value.independenceAttestations.every(validAttestation)
  )
    return undefined;
  const parsed = value as unknown as ManufacturerNetworkSources;
  if (
    new Set(parsed.sources.map((s) => s.publisherId)).size !==
      parsed.sources.length ||
    parsed.sources.some((s) => !s.knownCorporateDomains.includes(s.domain))
  )
    return undefined;
  return parsed;
}
export function currentManufacturerReview(
  value: { reviewedAt: string; expiresAt: string },
  now: Date,
): boolean {
  const at = now.getTime();
  return (
    Date.parse(value.reviewedAt) <= at &&
    Date.parse(value.expiresAt) > at &&
    Date.parse(value.reviewedAt) < Date.parse(value.expiresAt)
  );
}
function prefixMatch(pathname: string, prefix: string): boolean {
  return (
    pathname === prefix ||
    pathname.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`)
  );
}
function paths(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((p) => typeof p === "string" && p.startsWith("/"))
  );
}
/** Exact reviewed publisher and detail path, with no company-site generic fallback. */
export function manufacturerSourceForUrl(
  raw: string,
  sources: readonly ManufacturerNetworkSource[],
  policies: readonly ManufacturerSourcePolicy[],
  now: Date,
):
  | { source: ManufacturerNetworkSource; policy: ManufacturerSourcePolicy }
  | undefined {
  if (!isStableSafeHttpsUrl(raw) || raw.length > 1024) return undefined;
  const url = new URL(raw);
  if (
    url.href !== raw ||
    url.search ||
    url.hash ||
    url.pathname === "/" ||
    url.pathname.includes("%") ||
    url.port
  )
    return undefined;
  const rawHost = url.hostname;
  const host = rawHost.replace(/^www\./u, "");
  const source = sources.find(
    (s) =>
      s.domain === host &&
      currentManufacturerReview(s, now) &&
      s.detailPathPrefixes.some((p) => prefixMatch(url.pathname, p)),
  );
  if (!source) return undefined;
  // A suspended narrower policy cannot be bypassed via an approved parent policy.
  const policy = [...policies]
    .filter((p) => rawHost === p.domain || rawHost.endsWith(`.${p.domain}`))
    .sort((a, b) => b.domain.length - a.domain.length)[0];
  if (
    !policy ||
    (policy.domain !== host && policy.domain !== rawHost) ||
    policy.sourceType !== "official_website" ||
    policy.reviewStatus !== "APPROVED" ||
    !["REVIEWED_OK", "REVIEWED_RESTRICTED"].includes(policy.termsStatus) ||
    !Array.isArray(policy.allowedPurpose) ||
    !policy.allowedPurpose.includes("enrichment") ||
    !paths(policy.allowedPaths) ||
    !policy.allowedPaths.some((p) => prefixMatch(url.pathname, p)) ||
    (policy.disallowedPaths !== null &&
      (!paths(policy.disallowedPaths) ||
        policy.disallowedPaths.some((p) => prefixMatch(url.pathname, p)))) ||
    !Number.isSafeInteger(policy.retentionDays) ||
    policy.retentionDays < 1
  )
    return undefined;
  return { source, policy };
}
/** Separate, reviewed control evidence is mandatory. A distinct domain alone proves nothing. */
export function manufacturerIndependence(
  config: ManufacturerNetworkSources,
  source: ManufacturerNetworkSource,
  subject: { workspaceId: string; companyId: string; domain: string },
  now: Date,
): ManufacturerIndependenceAttestation | undefined {
  const target = subject.domain.replace(/^www\./u, "");
  if (
    source.knownCorporateDomains.some(
      (d) =>
        target === d || target.endsWith(`.${d}`) || d.endsWith(`.${target}`),
    )
  )
    return undefined;
  return config.independenceAttestations.find(
    (a) =>
      a.workspaceId === subject.workspaceId &&
      a.companyId === subject.companyId &&
      a.targetDomain === target &&
      a.publisherId === source.publisherId &&
      currentManufacturerReview(a, now),
  );
}
