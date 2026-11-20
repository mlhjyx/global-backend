import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { companyMayUseExternalProcessing } from "./company-suppression-gate";
import {
  isProviderCompanyName,
  isStableSafeHttpsUrl,
} from "./raw-source-provider-normalizer";
import type { ManufacturerIdentityEvidenceRef } from "@global/contracts";

export interface ReviewedManufacturerLegalName {
  readonly value: string;
  readonly reference: ManufacturerIdentityEvidenceRef;
  readonly fetchedAt: string;
}
export interface ManufacturerIdentitySubject {
  readonly workspaceId: string;
  readonly companyId: string;
  readonly domain: string;
  readonly country: string;
}
/** Digest is SHA-256 of the exact original string's UTF-8 bytes, NOT JSON-stringified or normalized text. */
export function manufacturerIdentityValueSha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Field names are not trust markers: dereference the reviewed immutable UUID/value pair and current rights/scope. */
export async function loadReviewedManufacturerLegalNames(
  tx: Prisma.TransactionClient,
  subject: ManufacturerIdentitySubject,
  references: readonly ManufacturerIdentityEvidenceRef[],
  now = new Date(),
): Promise<readonly ReviewedManufacturerLegalName[] | undefined> {
  if (
    !references.length ||
    references.length > 4 ||
    subject.country !== "DE" ||
    !(await companyMayUseExternalProcessing(
      tx,
      subject.workspaceId,
      subject.companyId,
    ))
  )
    return undefined;
  const company = await tx.canonicalCompany.findFirst({
    where: { id: subject.companyId, workspaceId: subject.workspaceId },
    select: { domain: true, country: true, attributes: true },
  });
  if (
    !company ||
    company.domain?.replace(/^www\./u, "") !==
      subject.domain.replace(/^www\./u, "") ||
    company.country !== subject.country
  )
    return undefined;
  const fields = await tx.fieldEvidence.findMany({
    where: {
      id: { in: references.map((r) => r.fieldEvidenceId) },
      workspaceId: subject.workspaceId,
      entityType: "company",
      entityId: subject.companyId,
    },
    select: {
      id: true,
      value: true,
      field: true,
      providerKey: true,
      sourceUrl: true,
      license: true,
      allowedActions: true,
      dataClass: true,
      fetchedAt: true,
    },
  });
  const result: ReviewedManufacturerLegalName[] = [];
  for (const reference of references) {
    const row = fields.find((f) => f.id === reference.fieldEvidenceId);
    if (
      !row ||
      typeof row.value !== "string" ||
      row.value.length < 1 ||
      row.value.length > 160 ||
      !isProviderCompanyName(row.value) ||
      manufacturerIdentityValueSha256(row.value) !== reference.valueSha256 ||
      row.dataClass !== "green" ||
      !row.license.trim() ||
      /^(?:sandbox|unknown|unreviewed|none|no_license)$/iu.test(
        row.license.trim(),
      ) ||
      !Array.isArray(row.allowedActions) ||
      !row.allowedActions.includes("match") ||
      !row.sourceUrl ||
      !isStableSafeHttpsUrl(row.sourceUrl) ||
      row.fetchedAt.getTime() > now.getTime() ||
      now.getTime() - row.fetchedAt.getTime() > 30 * 86400000
    )
      return undefined;
    const url = new URL(row.sourceUrl);
    const host = url.hostname.replace(/^www\./u, "");
    let approved = false;
    if (
      row.field === "website_profile.legal_name" &&
      row.providerKey === "website_profile" &&
      host === subject.domain.replace(/^www\./u, "")
    )
      approved = true;
    if (
      row.field === "gleif.legal_name" &&
      row.providerKey === "gleif" &&
      ["api.gleif.org", "search.gleif.org"].includes(url.hostname)
    ) {
      const attrs = company.attributes as {
        gleif?: { registered_country?: unknown };
      } | null;
      if (attrs?.gleif?.registered_country !== subject.country)
        return undefined;
      const policy = await tx.sourcePolicy.findUnique({
        where: { domain: url.hostname },
        select: {
          sourceType: true,
          reviewStatus: true,
          termsStatus: true,
          allowedPurpose: true,
        },
      });
      approved = Boolean(
        policy?.sourceType === "gov_registry" &&
        policy.reviewStatus === "APPROVED" &&
        ["REVIEWED_OK", "REVIEWED_RESTRICTED"].includes(policy.termsStatus) &&
        Array.isArray(policy.allowedPurpose) &&
        policy.allowedPurpose.includes("enrichment"),
      );
    }
    if (!approved) return undefined;
    result.push({
      value: row.value,
      reference: { ...reference },
      fetchedAt: row.fetchedAt.toISOString(),
    });
  }
  return result;
}
